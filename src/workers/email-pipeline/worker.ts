import type { Channel, ConsumeMessage } from "amqplib";
import { AppDataSource } from "../../config/db.js";
import { Email } from "../../database/entities/Email.js";
import {
  GmailSyncError,
  findGoogleAccountByEmail,
} from "../../modules/gmail/gmail.service.js";
import { safeErrorDetails } from "../../utils/safe-error-details.js";
import { runEmailPipelineForUser } from "./pipeline.js";
import {
  closeEmailPipelineQueue,
  emailPipelineJobSchema,
  enqueueEmailPipelineJob,
  enqueueEmailPipelineRetry,
  EMAIL_PIPELINE_CONSUMER_PREFETCH,
  EMAIL_PIPELINE_MAX_RETRIES,
  EMAIL_PIPELINE_QUEUE,
  getEmailPipelineConsumerChannel,
  setEmailPipelineQueueCloseListener,
  type EmailPipelineJob,
} from "./queue.js";

const RECONNECT_DELAY_MS = 5_000;
const RECOVERY_INTERVAL_MS = 60_000;

let consumerTag: string | undefined;
let consumerChannel: Channel | undefined;
let consumerRequested = false;
let reconnectTimer: NodeJS.Timeout | undefined;
let recoveryTimer: NodeJS.Timeout | undefined;
let recoveryPromise: Promise<void> | undefined;
// Keep retrying if emails were reset but their recovery job could not be queued.
let recoveryNeedsEnqueue = false;
let activeMessageHandlers = 0;
const messageHandlerDrainWaiters = new Set<() => void>();

const scheduleReconnect = () => {
  if (!consumerRequested || reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void startEmailPipelineConsumer().catch((error: unknown) => {
      console.error(
        "RabbitMQ consumer reconnect failed:",
        safeErrorDetails(error),
      );
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
  reconnectTimer.unref();
};

const handleQueueClosed = () => {
  consumerTag = undefined;
  consumerChannel = undefined;
  scheduleReconnect();
};

const processPipelineJob = async (job: EmailPipelineJob): Promise<void> => {
  if (job.type === "initial-sync") {
    await runEmailPipelineForUser(job.userId, { type: "recent" });
    return;
  }
  if (job.type === "process-pending") {
    await runEmailPipelineForUser(job.userId, { type: "none" });
    return;
  }

  const account = await findGoogleAccountByEmail(job.emailAddress);
  if (account?.status === "ACTIVE") {
    await runEmailPipelineForUser(account.userId, {
      type: "history",
      historyId: job.historyId,
    });
  }
};

const handleEmailPipelineMessage = async (
  channel: Channel,
  message: ConsumeMessage,
): Promise<void> => {
  let value: unknown;
  try {
    value = JSON.parse(message.content.toString("utf8"));
  } catch {
    channel.nack(message, false, false);
    return;
  }

  const parsedJob = emailPipelineJobSchema.safeParse(value);
  if (!parsedJob.success) {
    channel.nack(message, false, false);
    return;
  }

  try {
    await processPipelineJob(parsedJob.data);
    channel.ack(message);
  } catch (error) {
    const retryCountValue = Number(
      message.properties.headers?.["x-retry-count"] ?? 0,
    );
    const retryCount = Number.isInteger(retryCountValue) && retryCountValue >= 0
      ? retryCountValue
      : 0;
    console.warn(
      "Email pipeline queue job failed:",
      {
        jobType: parsedJob.data.type,
        retryCount,
        ...(error instanceof GmailSyncError ? { code: error.code } : {}),
        ...safeErrorDetails(error),
      },
    );

    if (retryCount >= EMAIL_PIPELINE_MAX_RETRIES) {
      channel.nack(message, false, false);
      return;
    }

    try {
      await enqueueEmailPipelineRetry(message.content, {
        contentType: "application/json",
        persistent: true,
        headers: {
          ...message.properties.headers,
          "x-retry-count": retryCount + 1,
        },
      });
      channel.ack(message);
    } catch (publishError) {
      console.error(
        "Email pipeline retry enqueue failed:",
        safeErrorDetails(publishError),
      );
      channel.nack(message, false, true);
    }
  }
};

const recoverPendingEmails = async (
  includeExistingPending: boolean,
): Promise<void> => {
  const recovered = await AppDataSource.getRepository(Email)
    .createQueryBuilder()
    .update(Email)
    .set({ processingStatus: "PENDING", processedAt: null })
    .where(
      "processing_status = :processingStatus AND (processed_at IS NULL OR processed_at < NOW() - INTERVAL '15 minutes')",
      { processingStatus: "PROCESSING" },
    )
    .execute();

  if (recovered.affected) {
    recoveryNeedsEnqueue = true;
  }
  const pendingUsersQuery = AppDataSource.getRepository(Email)
    .createQueryBuilder("email")
    .select("email.user_id", "userId")
    .distinct(true);
  if (includeExistingPending || recoveryNeedsEnqueue) {
    pendingUsersQuery.where(
      "(email.processing_status = :processingStatus OR email.matching_pending = TRUE)",
      { processingStatus: "PENDING" },
    );
  } else {
    pendingUsersQuery.where("email.matching_pending = TRUE");
  }
  const pendingUsers = await pendingUsersQuery.getRawMany<{ userId: string }>();

  for (const { userId } of pendingUsers) {
    await enqueueEmailPipelineJob({ type: "process-pending", userId });
  }
  recoveryNeedsEnqueue = false;
};

const waitForMessageHandlers = async (): Promise<void> => {
  while (activeMessageHandlers > 0) {
    await new Promise<void>((resolve) => {
      messageHandlerDrainWaiters.add(resolve);
    });
  }
};

const runMessageHandler = async (
  channel: Channel,
  message: ConsumeMessage,
): Promise<void> => {
  activeMessageHandlers += 1;
  try {
    await handleEmailPipelineMessage(channel, message);
  } catch (error) {
    console.error(
      "Email pipeline message handling failed:",
      safeErrorDetails(error),
    );
    try {
      channel.nack(message, false, true);
    } catch {
      scheduleReconnect();
    }
  } finally {
    activeMessageHandlers -= 1;
    if (activeMessageHandlers === 0) {
      for (const resolve of messageHandlerDrainWaiters) {
        resolve();
      }
      messageHandlerDrainWaiters.clear();
    }
  }
};

export const startEmailPipelineConsumer = async (): Promise<void> => {
  consumerRequested = true;
  setEmailPipelineQueueCloseListener(handleQueueClosed);
  if (consumerTag) {
    return;
  }

  const channel = await getEmailPipelineConsumerChannel();
  consumerChannel = channel;
  await channel.prefetch(EMAIL_PIPELINE_CONSUMER_PREFETCH);
  await recoverPendingEmails(true);
  const result = await channel.consume(
    EMAIL_PIPELINE_QUEUE,
    (message) => {
      if (!message) {
        return;
      }
      if (!consumerRequested) {
        try {
          channel.nack(message, false, true);
        } catch {
          scheduleReconnect();
        }
        return;
      }
      void runMessageHandler(channel, message);
    },
    { noAck: false },
  );
  consumerTag = result.consumerTag;
  if (!recoveryTimer) {
    recoveryTimer = setInterval(() => {
      if (recoveryPromise) {
        return;
      }
      recoveryPromise = recoverPendingEmails(false)
        .catch((error: unknown) => {
          console.error("Email pipeline recovery failed:", safeErrorDetails(error));
        })
        .finally(() => {
          recoveryPromise = undefined;
        });
    }, RECOVERY_INTERVAL_MS);
    recoveryTimer.unref();
  }
};

export const stopEmailPipelineConsumer = async (): Promise<void> => {
  consumerRequested = false;
  setEmailPipelineQueueCloseListener(undefined);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = undefined;
  }

  let cancelError: unknown;
  const activeConsumerTag = consumerTag;
  consumerTag = undefined;
  if (activeConsumerTag) {
    try {
      if (consumerChannel) {
        await consumerChannel.cancel(activeConsumerTag);
      }
    } catch (error) {
      cancelError = error;
    }
  }
  consumerChannel = undefined;

  await recoveryPromise;
  await waitForMessageHandlers();
  await closeEmailPipelineQueue();

  if (cancelError) {
    throw cancelError;
  }
};
