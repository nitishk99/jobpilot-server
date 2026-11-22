import { AppDataSource } from "../../config/db.js";
import { getGmailPubSubTopic } from "../../config/env.js";
import { ConnectedAccount } from "../../database/entities/ConnectedAccount.js";
import { safeErrorDetails } from "../../utils/safe-error-details.js";
import {
  createGmailClientForUser,
  GmailSyncError,
  retryGoogleRequest,
  toGmailApiError,
} from "./gmail.client.js";

type WatchStateUpdates = Partial<
  Pick<
    ConnectedAccount,
    "gmailWatchExpiresAt" | "gmailInitialSyncCompleted"
  >
>;

export const advanceGmailHistoryCursor = async (
  accountId: string,
  historyId: string,
  updates: WatchStateUpdates = {},
): Promise<void> => {
  await AppDataSource.getRepository(ConnectedAccount)
    .createQueryBuilder()
    .update(ConnectedAccount)
    .set({
      ...updates,
      gmailHistoryId: () =>
        "GREATEST(COALESCE(NULLIF(gmail_history_id, '')::numeric, 0), CAST(:historyId AS numeric))::text",
    })
    .where("id = :accountId", { accountId })
    .setParameter("historyId", historyId)
    .execute();
};

export const startGmailWatchForUser = async (
  userId: string,
): Promise<{
  historyId: string;
  expiration: Date;
  initialSyncRequired: boolean;
}> => {
  const topicName = getGmailPubSubTopic();
  if (!topicName) {
    throw new GmailSyncError(
      503,
      "GMAIL_PUBSUB_NOT_CONFIGURED",
      "Gmail push notifications are not configured on the server.",
    );
  }

  const gmail = await createGmailClientForUser(userId);
  const accountRepository = AppDataSource.getRepository(ConnectedAccount);
  const account = await accountRepository.findOneBy({
    userId,
    provider: "GOOGLE",
  });
  if (!account) {
    throw new GmailSyncError(
      409,
      "GOOGLE_ACCOUNT_NOT_CONNECTED",
      "Connect a Google account before enabling Gmail notifications.",
    );
  }

  try {
    const response = await retryGoogleRequest(() =>
      gmail.users.watch({
        userId: "me",
        requestBody: {
          topicName,
          labelIds: ["INBOX"],
          labelFilterBehavior: "include",
        },
      }),
    );
    const historyId = response.data.historyId;
    const expirationValue = Number(response.data.expiration);
    if (
      !historyId ||
      !Number.isFinite(expirationValue) ||
      expirationValue <= Date.now()
    ) {
      throw new GmailSyncError(
        502,
        "GMAIL_WATCH_INVALID_RESPONSE",
        "Gmail returned an invalid notification subscription.",
      );
    }

    const expiration = new Date(expirationValue);
    await accountRepository
      .createQueryBuilder()
      .update(ConnectedAccount)
      .set({
        gmailWatchExpiresAt: expiration,
        // A renewed watch must not skip history that has not been synced.
        gmailHistoryId: () =>
          "COALESCE(NULLIF(gmail_history_id, ''), CAST(:historyId AS text))",
      })
      .where("id = :accountId", { accountId: account.id })
      .setParameter("historyId", historyId)
      .execute();

    return {
      historyId,
      expiration,
      initialSyncRequired: !account.gmailInitialSyncCompleted,
    };
  } catch (error) {
    if (error instanceof GmailSyncError) {
      throw error;
    }
    throw toGmailApiError(error);
  }
};

export const renewExpiringGmailWatches = async (): Promise<void> => {
  if (!getGmailPubSubTopic()) {
    return;
  }

  const accounts = await AppDataSource.getRepository(ConnectedAccount).find({
    where: { provider: "GOOGLE", status: "ACTIVE" },
  });
  const renewalThreshold = Date.now() + 24 * 60 * 60 * 1000;

  for (const account of accounts) {
    if (
      account.gmailWatchExpiresAt &&
      account.gmailWatchExpiresAt.getTime() > renewalThreshold
    ) {
      continue;
    }

    try {
      await startGmailWatchForUser(account.userId);
    } catch (error) {
      console.warn(
        "Gmail watch renewal failed:",
        {
          ...(error instanceof GmailSyncError ? { code: error.code } : {}),
          ...safeErrorDetails(error),
        },
      );
    }
  }
};
