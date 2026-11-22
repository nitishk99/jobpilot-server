import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mock = {
  connect: jest.fn(),
  publisher: {
    on: jest.fn(),
    assertQueue: jest.fn(),
    sendToQueue: jest.fn(),
  },
  consumer: {
    on: jest.fn(),
    prefetch: jest.fn(),
    consume: jest.fn(),
    cancel: jest.fn(),
  },
  consumeHandler: undefined as
    | ((message: unknown) => void)
    | undefined,
  getRepository: jest.fn(),
  emailQueryBuilder: {
    update: jest.fn(),
    set: jest.fn(),
    where: jest.fn(),
    execute: jest.fn(),
    select: jest.fn(),
    distinct: jest.fn(),
    getRawMany: jest.fn(),
  },
  findGoogleAccountByEmail: jest.fn(),
  connection: {
    on: jest.fn(),
    createConfirmChannel: jest.fn(),
    createChannel: jest.fn(),
    close: jest.fn(),
  },
};

const waitFor = async (check: () => void): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

jest.mock("amqplib", () => ({
  connect: (...args) => mock.connect(...args),
}));

jest.mock("../../../src/config/db.js", () => ({
  AppDataSource: {
    getRepository: (...args) => mock.getRepository(...args),
  },
}));

jest.mock("../../../src/modules/gmail/gmail.service.js", () => ({
  GmailSyncError: class GmailSyncError extends Error {},
  findGoogleAccountByEmail: (...args) =>
    mock.findGoogleAccountByEmail(...args),
  startGmailWatchForUser: jest.fn(),
}));

jest.mock("../../../src/workers/email-pipeline/pipeline.js", () => ({
  runEmailPipelineForUser: jest.fn(),
}));

import {
  enqueueEmailPipelineJob,
  initializeEmailPipelinePublisher,
} from "../../../src/workers/email-pipeline/queue.js";
import { startEmailPipelineConsumer } from "../../../src/workers/email-pipeline/worker.js";
import { stopEmailPipelineConsumer } from "../../../src/workers/email-pipeline/worker.js";
import { Email } from "../../../src/database/entities/Email.js";
import { runEmailPipelineForUser } from "../../../src/workers/email-pipeline/pipeline.js";

describe("email pipeline RabbitMQ queue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RABBITMQ_URL = "amqp://localhost";
    mock.publisher.assertQueue.mockResolvedValue({});
    mock.publisher.sendToQueue.mockImplementation(
      (_queue, _content, _options, callback) => callback(null, {}),
    );
    mock.consumer.prefetch.mockResolvedValue({});
    mock.consumer.cancel.mockResolvedValue(undefined);
    mock.consumer.consume.mockImplementation(
      async (_queue, handler) => {
        mock.consumeHandler = handler;
        return { consumerTag: "email-worker" };
      },
    );
    mock.connection.createConfirmChannel.mockResolvedValue(mock.publisher);
    mock.connection.createChannel.mockResolvedValue(mock.consumer);
    mock.connection.close.mockResolvedValue(undefined);
    mock.connect.mockResolvedValue(mock.connection);
    for (const method of [
      mock.emailQueryBuilder.update,
      mock.emailQueryBuilder.set,
      mock.emailQueryBuilder.where,
      mock.emailQueryBuilder.select,
      mock.emailQueryBuilder.distinct,
    ]) {
      method.mockReturnThis();
    }
    mock.emailQueryBuilder.execute.mockResolvedValue({ affected: 0 });
    mock.emailQueryBuilder.getRawMany.mockResolvedValue([]);
    mock.findGoogleAccountByEmail.mockResolvedValue({
      userId: "45870876-86b3-4013-b67b-bde9ad5e12e7",
      status: "ACTIVE",
    });
    mock.getRepository.mockReturnValue({
      createQueryBuilder: jest.fn(() => mock.emailQueryBuilder),
    });
    jest.mocked(runEmailPipelineForUser).mockResolvedValue({
      sync: null,
      processing: {
        processed: 0,
        jobRelated: 0,
        notJobRelated: 0,
        failed: 0,
        remaining: 0,
        aiClassified: 0,
        prefiltered: 0,
      },
    });
  });

  afterEach(async () => {
    await stopEmailPipelineConsumer();
    jest.useRealTimers();
  });

  it("publishes durable initial-import jobs to the pipeline queue", async () => {
    const userId = "45870876-86b3-4013-b67b-bde9ad5e12e7";

    await enqueueEmailPipelineJob({ type: "initial-sync", userId });

    expect(mock.connect).toHaveBeenCalledWith("amqp://localhost");
    expect(mock.publisher.assertQueue).toHaveBeenCalledWith(
      "jobpilot.email.pipeline",
      expect.objectContaining({ durable: true }),
    );
    const [queue, content, options] = mock.publisher.sendToQueue.mock.calls[0]!;
    expect(queue).toBe("jobpilot.email.pipeline");
    expect(JSON.parse(content.toString("utf8"))).toEqual({
      type: "initial-sync",
      userId,
    });
    expect(options).toMatchObject({
      contentType: "application/json",
      persistent: true,
    });
  });

  it("requeues users with pending emails when the consumer starts", async () => {
    const userId = "45870876-86b3-4013-b67b-bde9ad5e12e7";
    mock.emailQueryBuilder.getRawMany.mockResolvedValueOnce([{ userId }]);

    await startEmailPipelineConsumer();

    expect(mock.emailQueryBuilder.set).toHaveBeenCalledWith({
      processingStatus: "PENDING",
      processedAt: null,
    });
    expect(mock.emailQueryBuilder.execute).toHaveBeenCalled();
    expect(mock.emailQueryBuilder.where).toHaveBeenCalledWith(
      "(email.processing_status = :processingStatus OR email.matching_pending = TRUE)",
      { processingStatus: "PENDING" },
    );
    const publishedJobs = mock.publisher.sendToQueue.mock.calls.map(
      ([, content]) => JSON.parse(content.toString("utf8")),
    );
    expect(publishedJobs).toContainEqual({ type: "process-pending", userId });
  });

  it("rejects malformed jobs before publishing", async () => {
    await expect(
      enqueueEmailPipelineJob({
        type: "initial-sync",
        userId: "not-a-uuid",
      } as never),
    ).rejects.toThrow();

    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("closes a partially initialized connection when channel setup fails", async () => {
    mock.connection.createChannel.mockRejectedValueOnce(
      new Error("consumer channel setup failed"),
    );

    await expect(initializeEmailPipelinePublisher()).rejects.toThrow(
      "consumer channel setup failed",
    );
    expect(mock.connection.close).toHaveBeenCalledTimes(1);
  });

  it("consumes queued initial imports and acknowledges successful work", async () => {
    await startEmailPipelineConsumer();
    const message = {
      content: Buffer.from(JSON.stringify({
        type: "initial-sync",
        userId: "45870876-86b3-4013-b67b-bde9ad5e12e7",
      })),
      properties: { headers: {} },
    };
    const channel = mock.consumer as unknown as {
      ack: ReturnType<typeof jest.fn>;
    };
    channel.ack = jest.fn();

    mock.consumeHandler?.(message);
    await waitFor(() => {
      expect(runEmailPipelineForUser).toHaveBeenCalledWith(
        "45870876-86b3-4013-b67b-bde9ad5e12e7",
        { type: "recent" },
      );
      expect(channel.ack).toHaveBeenCalledWith(message);
    });

    const pendingMessage = {
      content: Buffer.from(JSON.stringify({
        type: "process-pending",
        userId: "45870876-86b3-4013-b67b-bde9ad5e12e7",
      })),
      properties: { headers: {} },
    };
    mock.consumeHandler?.(pendingMessage);
    await waitFor(() => {
      expect(runEmailPipelineForUser).toHaveBeenCalledWith(
        "45870876-86b3-4013-b67b-bde9ad5e12e7",
        { type: "none" },
      );
      expect(channel.ack).toHaveBeenCalledWith(pendingMessage);
    });

    const historyMessage = {
      content: Buffer.from(JSON.stringify({
        type: "gmail-history",
        emailAddress: "user@example.com",
        historyId: "12345",
      })),
      properties: { headers: {} },
    };
    mock.consumeHandler?.(historyMessage);
    await waitFor(() => {
      expect(mock.findGoogleAccountByEmail).toHaveBeenCalledWith(
        "user@example.com",
      );
      expect(runEmailPipelineForUser).toHaveBeenCalledWith(
        "45870876-86b3-4013-b67b-bde9ad5e12e7",
        { type: "history", historyId: "12345" },
      );
      expect(channel.ack).toHaveBeenCalledWith(historyMessage);
    });

    expect(mock.getRepository).toHaveBeenCalledWith(Email);
    expect(mock.emailQueryBuilder.where).toHaveBeenCalledWith(
      "processing_status = :processingStatus AND (processed_at IS NULL OR processed_at < NOW() - INTERVAL '15 minutes')",
      { processingStatus: "PROCESSING" },
    );
  });

  it("reconnects when an individual RabbitMQ channel closes", async () => {
    jest.useFakeTimers();
    await startEmailPipelineConsumer();
    const closeCall = mock.publisher.on.mock.calls.find(
      ([event]) => event === "close",
    );
    const closeHandler = closeCall?.[1];
    expect(typeof closeHandler).toBe("function");

    if (typeof closeHandler !== "function") {
      throw new Error("Publisher close handler was not registered");
    }
    closeHandler();

    await jest.advanceTimersByTimeAsync(5_000);

    expect(mock.connection.close).toHaveBeenCalledTimes(1);
    expect(mock.connect).toHaveBeenCalledTimes(2);
    expect(mock.consumer.consume).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying when the first RabbitMQ reconnection fails", async () => {
    jest.useFakeTimers();
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    await startEmailPipelineConsumer();
    const closeHandler = mock.publisher.on.mock.calls.find(
      ([event]) => event === "close",
    )?.[1];
    if (typeof closeHandler !== "function") {
      throw new Error("Publisher close handler was not registered");
    }
    mock.connect.mockRejectedValueOnce(new Error("broker unavailable"));
    closeHandler();

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mock.connect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mock.connect).toHaveBeenCalledTimes(3);
    expect(mock.consumer.consume).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
  });

  it("periodically requeues emails that become stale after startup", async () => {
    jest.useFakeTimers();
    const userId = "45870876-86b3-4013-b67b-bde9ad5e12e7";
    mock.emailQueryBuilder.execute
      .mockResolvedValueOnce({ affected: 0 })
      .mockResolvedValueOnce({ affected: 1 });
    mock.emailQueryBuilder.getRawMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ userId }]);
    await startEmailPipelineConsumer();

    await jest.advanceTimersByTimeAsync(60_000);

    const jobs = mock.publisher.sendToQueue.mock.calls.map(
      ([, content]) => JSON.parse(content.toString("utf8")),
    );
    expect(jobs).toContainEqual({ type: "process-pending", userId });
  });

  it("recovers extracted emails still awaiting matching without another incoming email", async () => {
    jest.useFakeTimers();
    const userId = "45870876-86b3-4013-b67b-bde9ad5e12e7";
    mock.emailQueryBuilder.getRawMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ userId }]);
    await startEmailPipelineConsumer();

    await jest.advanceTimersByTimeAsync(60_000);

    expect(mock.emailQueryBuilder.where).toHaveBeenCalledWith("email.matching_pending = TRUE");
    const jobs = mock.publisher.sendToQueue.mock.calls.map(
      ([, content]) => JSON.parse(content.toString("utf8")),
    );
    expect(jobs).toContainEqual({ type: "process-pending", userId });
  });

  it("retries recovery if publishing a recovered user fails", async () => {
    jest.useFakeTimers();
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    const userId = "45870876-86b3-4013-b67b-bde9ad5e12e7";
    mock.emailQueryBuilder.execute
      .mockResolvedValueOnce({ affected: 0 })
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValueOnce({ affected: 0 });
    mock.emailQueryBuilder.getRawMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ userId }])
      .mockResolvedValueOnce([{ userId }]);
    mock.publisher.sendToQueue.mockImplementationOnce(
      (_queue, _content, _options, callback) => callback(new Error("publish failed")),
    );
    await startEmailPipelineConsumer();

    await jest.advanceTimersByTimeAsync(60_000);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mock.publisher.sendToQueue).toHaveBeenCalledTimes(2);
    const content = mock.publisher.sendToQueue.mock.calls[1]?.[1];
    expect(JSON.parse(content.toString("utf8"))).toEqual({ type: "process-pending", userId });
    errorLog.mockRestore();
  });

  it("publishes failed jobs to the delayed retry queue with an incremented count", async () => {
    await startEmailPipelineConsumer();
    const channel = mock.consumer as unknown as {
      ack: ReturnType<typeof jest.fn>;
      nack: ReturnType<typeof jest.fn>;
    };
    channel.ack = jest.fn();
    channel.nack = jest.fn();
    jest.mocked(runEmailPipelineForUser).mockRejectedValueOnce(
      new Error("temporary pipeline failure"),
    );
    const message = {
      content: Buffer.from(JSON.stringify({
        type: "initial-sync",
        userId: "45870876-86b3-4013-b67b-bde9ad5e12e7",
      })),
      properties: { headers: {} },
    };

    mock.consumeHandler?.(message);
    await waitFor(() => {
      expect(channel.ack).toHaveBeenCalledWith(message);
    });

    expect(mock.publisher.sendToQueue).toHaveBeenCalledWith(
      "jobpilot.email.pipeline.retry",
      message.content,
      expect.objectContaining({
        persistent: true,
        headers: { "x-retry-count": 1 },
      }),
      expect.any(Function),
    );
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("dead-letters a failed job after the retry limit", async () => {
    await startEmailPipelineConsumer();
    const channel = mock.consumer as unknown as {
      ack: ReturnType<typeof jest.fn>;
      nack: ReturnType<typeof jest.fn>;
    };
    channel.ack = jest.fn();
    channel.nack = jest.fn();
    jest.mocked(runEmailPipelineForUser).mockRejectedValueOnce(
      new Error("permanent pipeline failure"),
    );
    const message = {
      content: Buffer.from(JSON.stringify({
        type: "initial-sync",
        userId: "45870876-86b3-4013-b67b-bde9ad5e12e7",
      })),
      properties: { headers: { "x-retry-count": 5 } },
    };

    mock.consumeHandler?.(message);
    await waitFor(() => {
      expect(channel.nack).toHaveBeenCalledWith(message, false, false);
    });

    expect(mock.publisher.sendToQueue).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it("waits for in-flight work before closing RabbitMQ", async () => {
    let finishJob!: () => void;
    jest.mocked(runEmailPipelineForUser).mockReturnValueOnce(
      new Promise((resolve) => {
        finishJob = () => resolve({
          sync: null,
          processing: {
            processed: 0,
            jobRelated: 0,
            notJobRelated: 0,
            failed: 0,
            remaining: 0,
            aiClassified: 0,
            prefiltered: 0,
          },
        });
      }),
    );
    await startEmailPipelineConsumer();

    const message = {
      content: Buffer.from(JSON.stringify({
        type: "initial-sync",
        userId: "45870876-86b3-4013-b67b-bde9ad5e12e7",
      })),
      properties: { headers: {} },
    };
    const channel = mock.consumer as unknown as {
      ack: ReturnType<typeof jest.fn>;
    };
    channel.ack = jest.fn();
    mock.consumeHandler?.(message);

    const shutdown = stopEmailPipelineConsumer();
    await Promise.resolve();
    expect(mock.consumer.cancel).toHaveBeenCalledWith("email-worker");
    expect(mock.connection.close).not.toHaveBeenCalled();

    finishJob();
    await shutdown;

    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(mock.connection.close).toHaveBeenCalledTimes(1);
  });
});
