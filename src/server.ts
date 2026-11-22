import "dotenv/config";

import type { Server } from "node:http";
import { AppDataSource, connectDB } from "./config/db.js";
import { safeErrorDetails } from "./utils/safe-error-details.js";
import { renewExpiringGmailWatches } from "./modules/gmail/gmail.service.js";
import { createApp } from "./app.js";
import {
  startEmailPipelineConsumer,
  stopEmailPipelineConsumer,
} from "./workers/email-pipeline/worker.js";
import { bootstrapEmailPipeline } from "./workers/email-pipeline/bootstrap.js";
import { getAllowedClientOrigins, getPort } from "./config/env.js";
import { initializeEmailPipelinePublisher } from "./workers/email-pipeline/queue.js";

const GMAIL_WATCH_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

let httpServer: Server | undefined;
let watchRenewalTimer: NodeJS.Timeout | undefined;
let shutdownPromise: Promise<void> | undefined;

const startServer = async () => {
  const port = getPort();
  getAllowedClientOrigins();
  await connectDB();
  await initializeEmailPipelinePublisher();
  await bootstrapEmailPipeline();
  await startEmailPipelineConsumer();
  await renewExpiringGmailWatches();

  httpServer = createApp().listen(port, () => {
    console.log(`JobPilot API running on port ${port}`);
    console.log("JobPilot email pipeline worker running");

    watchRenewalTimer = setInterval(() => {
      void renewExpiringGmailWatches().catch((error: unknown) => {
        console.error("Gmail watch renewal failed:", safeErrorDetails(error));
      });
    }, GMAIL_WATCH_RENEWAL_INTERVAL_MS);
    watchRenewalTimer.unref();
  });
};

const shutdown = (): Promise<void> => {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    const errors: unknown[] = [];

    if (watchRenewalTimer) {
      clearInterval(watchRenewalTimer);
      watchRenewalTimer = undefined;
    }

    const activeServer = httpServer;
    httpServer = undefined;
    if (activeServer) {
      try {
        await new Promise<void>((resolve, reject) => {
          activeServer.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await stopEmailPipelineConsumer();
    } catch (error) {
      errors.push(error);
    }
    if (AppDataSource.isInitialized) {
      try {
        await AppDataSource.destroy();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "JobPilot shutdown failed");
    }
  })();

  return shutdownPromise;
};

const handleShutdown = (signal: NodeJS.Signals): void => {
  console.log(`JobPilot shutting down after ${signal}`);
  void shutdown().catch((error: unknown) => {
    console.error("JobPilot shutdown failed:", safeErrorDetails(error));
    process.exitCode = 1;
  });
};

process.once("SIGINT", () => handleShutdown("SIGINT"));
process.once("SIGTERM", () => handleShutdown("SIGTERM"));

void startServer().catch((error: unknown) => {
  console.error("JobPilot startup failed:", safeErrorDetails(error));
  process.exitCode = 1;
  void shutdown().catch((shutdownError: unknown) => {
    console.error(
      "JobPilot startup cleanup failed:",
      safeErrorDetails(shutdownError),
    );
    process.exitCode = 1;
  });
});