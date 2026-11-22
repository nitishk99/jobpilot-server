import { connect } from "amqplib";
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  Options,
} from "amqplib";
import { z } from "zod";
import { safeErrorDetails } from "../../utils/safe-error-details.js";
import { getRabbitMqUrl } from "../../config/env.js";

export const EMAIL_PIPELINE_QUEUE = "jobpilot.email.pipeline";
export const EMAIL_PIPELINE_RETRY_QUEUE = "jobpilot.email.pipeline.retry";
export const EMAIL_PIPELINE_DEAD_QUEUE = "jobpilot.email.pipeline.dead";
export const EMAIL_PIPELINE_RETRY_DELAY_MS = 30_000;
export const EMAIL_PIPELINE_MAX_RETRIES = 5;
export const EMAIL_PIPELINE_CONSUMER_PREFETCH = 1;

export const emailPipelineJobSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("initial-sync"),
    userId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal("process-pending"),
    userId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal("gmail-history"),
    emailAddress: z.string().email(),
    historyId: z.string().regex(/^\d+$/),
  }).strict(),
]);

export type EmailPipelineJob = z.infer<typeof emailPipelineJobSchema>;

type QueueCloseListener = () => void;

let connection: ChannelModel | undefined;
let publishChannel: ConfirmChannel | undefined;
let consumeChannel: Channel | undefined;
let connectionPromise: Promise<void> | undefined;
let queueCloseListener: QueueCloseListener | undefined;

const publishConfirmed = async (
  channel: ConfirmChannel,
  queue: string,
  content: Buffer,
  options: Options.Publish,
): Promise<void> =>
  new Promise((resolve, reject) => {
    channel.sendToQueue(queue, content, options, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

const resetChannels = () => {
  connection = undefined;
  publishChannel = undefined;
  consumeChannel = undefined;
};

const notifyQueueClosed = () => {
  if (queueCloseListener) {
    queueCloseListener();
  }
};

const handleChannelClose = (
  channelModel: ChannelModel,
  channelName: "publisher" | "consumer",
) => {
  if (connection !== channelModel) {
    return;
  }

  console.error(`RabbitMQ ${channelName} channel closed`);
  resetChannels();
  void channelModel.close().catch((error: unknown) => {
    console.error(
      "RabbitMQ connection close after channel failure failed:",
      safeErrorDetails(error),
    );
  });
  notifyQueueClosed();
};

const ensureChannels = async (): Promise<void> => {
  if (connection && publishChannel && consumeChannel) {
    return;
  }
  if (connectionPromise) {
    await connectionPromise;
    return;
  }

  connectionPromise = (async () => {
    const channelModel = await connect(getRabbitMqUrl());
    connection = channelModel;
    channelModel.on("error", (error: unknown) => {
      console.error("RabbitMQ connection error:", safeErrorDetails(error));
    });
    channelModel.on("close", () => {
      if (connection !== channelModel) {
        return;
      }
      resetChannels();
      notifyQueueClosed();
    });

    publishChannel = await channelModel.createConfirmChannel();
    publishChannel.on("error", (error: unknown) => {
      console.error("RabbitMQ publisher error:", safeErrorDetails(error));
    });
    publishChannel.on("close", () =>
      handleChannelClose(channelModel, "publisher"),
    );
    consumeChannel = await channelModel.createChannel();
    consumeChannel.on("error", (error: unknown) => {
      console.error("RabbitMQ consumer channel error:", safeErrorDetails(error));
    });
    consumeChannel.on("close", () =>
      handleChannelClose(channelModel, "consumer"),
    );

    await publishChannel.assertQueue(EMAIL_PIPELINE_DEAD_QUEUE, {
      durable: true,
    });
    await publishChannel.assertQueue(EMAIL_PIPELINE_QUEUE, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": EMAIL_PIPELINE_DEAD_QUEUE,
      },
    });
    await publishChannel.assertQueue(EMAIL_PIPELINE_RETRY_QUEUE, {
      durable: true,
      arguments: {
        "x-message-ttl": EMAIL_PIPELINE_RETRY_DELAY_MS,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": EMAIL_PIPELINE_QUEUE,
      },
    });
  })();

  try {
    await connectionPromise;
  } catch (error) {
    const failedConnection = connection;
    resetChannels();
    if (failedConnection) {
      await failedConnection.close().catch((closeError: unknown) => {
        console.error(
          "RabbitMQ connection cleanup after setup failure failed:",
          safeErrorDetails(closeError),
        );
      });
    }
    throw error;
  } finally {
    connectionPromise = undefined;
  }
};

export const setEmailPipelineQueueCloseListener = (
  listener: QueueCloseListener | undefined,
): void => {
  queueCloseListener = listener;
};

export const enqueueEmailPipelineJob = async (
  job: EmailPipelineJob,
): Promise<void> => {
  const parsedJob = emailPipelineJobSchema.parse(job);
  await ensureChannels();
  if (!publishChannel) {
    throw new Error("RabbitMQ publisher is unavailable");
  }

  await publishConfirmed(
    publishChannel,
    EMAIL_PIPELINE_QUEUE,
    Buffer.from(JSON.stringify(parsedJob)),
    {
      contentType: "application/json",
      persistent: true,
    },
  );
};

export const initializeEmailPipelinePublisher = async (): Promise<void> => {
  await ensureChannels();
};

export const getEmailPipelineConsumerChannel = async (): Promise<Channel> => {
  await ensureChannels();
  if (!consumeChannel) {
    throw new Error("RabbitMQ consumer channel is unavailable");
  }
  return consumeChannel;
};

export const enqueueEmailPipelineRetry = async (
  content: Buffer,
  options: Options.Publish = {},
): Promise<void> => {
  await ensureChannels();
  if (!publishChannel) {
    throw new Error("RabbitMQ publisher is unavailable");
  }
  await publishConfirmed(
    publishChannel,
    EMAIL_PIPELINE_RETRY_QUEUE,
    content,
    options,
  );
};

export const closeEmailPipelineQueue = async (): Promise<void> => {
  const activeConnection = connection;
  resetChannels();
  if (activeConnection) {
    await activeConnection.close();
  }
};
