import { AppDataSource } from "../../config/db.js";
import { ConnectedAccount } from "../../database/entities/ConnectedAccount.js";
import { safeErrorDetails } from "../../utils/safe-error-details.js";
import {
  GmailSyncError,
  startGmailWatchForUser,
} from "../../modules/gmail/gmail.service.js";
import { enqueueEmailPipelineJob } from "./queue.js";

const WATCH_RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export const initializeEmailPipelineForUser = async (
  userId: string,
): Promise<void> => {
  const accounts = AppDataSource.getRepository(ConnectedAccount);
  const account = await accounts.findOneBy({
    userId,
    provider: "GOOGLE",
  });
  if (!account || account.status !== "ACTIVE") {
    return;
  }

  const watchNeedsRenewal =
    !account.gmailWatchExpiresAt ||
    account.gmailWatchExpiresAt.getTime() <=
      Date.now() + WATCH_RENEWAL_THRESHOLD_MS;
  if (watchNeedsRenewal) {
    try {
      await startGmailWatchForUser(userId);
    } catch (error) {
      console.warn(
        "Gmail watch setup failed:",
        {
          ...(error instanceof GmailSyncError ? { code: error.code } : {}),
          ...safeErrorDetails(error),
        },
      );
    }
  }

  if (!account.gmailInitialSyncCompleted) {
    await enqueueEmailPipelineJob({ type: "initial-sync", userId });
  }
};

export const bootstrapEmailPipeline = async (): Promise<void> => {
  const accounts = await AppDataSource.getRepository(ConnectedAccount).find({
    where: { provider: "GOOGLE", status: "ACTIVE" },
  });
  for (const account of accounts) {
    try {
      await initializeEmailPipelineForUser(account.userId);
    } catch (error) {
      console.error(
        "Email pipeline account bootstrap failed:",
        safeErrorDetails(error),
      );
    }
  }
};
