import { gmail_v1 } from "googleapis";
import { AppDataSource } from "../../config/db.js";
import { ConnectedAccount } from "../../database/entities/ConnectedAccount.js";
import {
  createGmailClientForUser,
  getGoogleErrorDetails,
  GmailSyncError,
  retryGoogleRequest,
  toGmailApiError,
} from "./gmail.client.js";
import { syncMessageIdsForUser, type GmailSyncSummary, syncRecentMail } from "./gmail.sync.shared.js";
import {
  advanceGmailHistoryCursor,
  startGmailWatchForUser,
} from "./gmail.watch.js";

const MAX_RESULTS_PER_PAGE = 100;

const laterHistoryId = (first: string, second: string): string =>
  BigInt(first) >= BigInt(second) ? first : second;

export const syncGmailHistoryForUser = async (
  userId: string,
  notificationHistoryId: string,
): Promise<GmailSyncSummary> => {
  const accountRepository = AppDataSource.getRepository(ConnectedAccount);
  const account = await accountRepository.findOneBy({
    userId,
    provider: "GOOGLE",
  });
  if (!account) {
    throw new GmailSyncError(
      409,
      "GOOGLE_ACCOUNT_NOT_CONNECTED",
      "Connect a Google account before syncing Gmail.",
    );
  }

  const gmail = await createGmailClientForUser(userId);
  if (!account.gmailHistoryId) {
    const summary = await syncRecentMail(gmail, userId);
    if (summary.failed > 0) {
      throw new GmailSyncError(
        503,
        "GMAIL_HISTORY_SYNC_INCOMPLETE",
        "Gmail history sync was incomplete and will be retried.",
      );
    }
    await advanceGmailHistoryCursor(account.id, notificationHistoryId, {
      gmailInitialSyncCompleted: true,
    });
    return summary;
  }

  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId = account.gmailHistoryId;

  do {
    let response: gmail_v1.Schema$ListHistoryResponse;
    try {
      const result = await retryGoogleRequest(() =>
        gmail.users.history.list({
          userId: "me",
          startHistoryId: account.gmailHistoryId!,
          historyTypes: ["messageAdded"],
          maxResults: MAX_RESULTS_PER_PAGE,
          ...(pageToken ? { pageToken } : {}),
        }),
      );
      response = result.data;
    } catch (error) {
      if (getGoogleErrorDetails(error).status !== 404) {
        throw toGmailApiError(error);
      }

      const watch = await startGmailWatchForUser(userId);
      const summary = await syncRecentMail(gmail, userId);
      if (summary.failed > 0) {
        throw new GmailSyncError(
          503,
          "GMAIL_HISTORY_SYNC_INCOMPLETE",
          "Gmail history sync was incomplete and will be retried.",
        );
      }
      await advanceGmailHistoryCursor(account.id, watch.historyId, {
        gmailInitialSyncCompleted: true,
      });
      return summary;
    }

    for (const history of response.history ?? []) {
      for (const addedMessage of history.messagesAdded ?? []) {
        const messageId = addedMessage.message?.id;
        if (messageId) {
          messageIds.add(messageId);
        }
      }
    }
    if (response.historyId) {
      latestHistoryId = laterHistoryId(latestHistoryId, response.historyId);
    }
    pageToken = response.nextPageToken ?? undefined;
  } while (pageToken);

  const summary = await syncMessageIdsForUser(gmail, userId, messageIds);
  if (summary.failed > 0) {
    throw new GmailSyncError(
      503,
      "GMAIL_HISTORY_SYNC_INCOMPLETE",
      "Gmail history sync was incomplete and will be retried.",
    );
  }
  await advanceGmailHistoryCursor(
    account.id,
    laterHistoryId(latestHistoryId, notificationHistoryId),
  );
  return summary;
};
