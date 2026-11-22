import { gmail_v1 } from "googleapis";
import { IsNull } from "typeorm";
import { AppDataSource } from "../../config/db.js";
import { Email } from "../../database/entities/Email.js";
import {
  getGoogleErrorDetails,
  isAuthorizationError,
  retryGoogleRequest,
  toGmailApiError,
} from "./gmail.client.js";
import { safeErrorDetails } from "../../utils/safe-error-details.js";
import {
  GmailMessageWithoutBodyError,
  parseGmailMessage,
  type ParsedGmailEmail,
} from "./gmail.parser.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESULTS_PER_PAGE = 100;

export interface GmailSyncSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
}

type EmailSaveResult = "inserted" | "updated" | "skipped";

const insertOrRepairEmail = async (
  email: ParsedGmailEmail,
): Promise<EmailSaveResult> => {
  const repository = AppDataSource.getRepository(Email);
  const existing = await repository.findOneBy({
    userId: email.userId,
    gmailMessageId: email.gmailMessageId,
  });

  if (existing) {
    if (existing.bodyText === null) {
      const update = await repository.update(
        { id: existing.id, bodyText: IsNull() },
        { bodyText: email.bodyText },
      );
      if (update.affected) {
        return "updated";
      }
    }
    return "skipped";
  }

  const result = await repository
    .createQueryBuilder()
    .insert()
    .into(Email)
    .values(email)
    .orIgnore()
    .returning(["id"])
    .execute();
  return Array.isArray(result.raw) && result.raw.length > 0
    ? "inserted"
    : "skipped";
};

const removeExistingEmailWithoutBody = async (
  userId: string,
  gmailMessageId: string,
): Promise<void> => {
  await AppDataSource.getRepository(Email).delete({
    userId,
    gmailMessageId,
    bodyText: IsNull(),
  });
};

const emptySyncSummary = (): GmailSyncSummary => ({
  fetched: 0,
  inserted: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
});

export const syncMessageIdsForUser = async (
  gmail: gmail_v1.Gmail,
  userId: string,
  messageIds: Iterable<string>,
): Promise<GmailSyncSummary> => {
  const summary = emptySyncSummary();

  for (const messageId of messageIds) {
    let stage = "fetch";
    try {
      const result = await retryGoogleRequest(() =>
        gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        }),
      );
      let email: ParsedGmailEmail;
      try {
        stage = "parse";
        email = parseGmailMessage(result.data, userId);
      } catch (error) {
        if (error instanceof GmailMessageWithoutBodyError) {
          await removeExistingEmailWithoutBody(userId, messageId);
          summary.fetched += 1;
          summary.skipped += 1;
          continue;
        }
        throw error;
      }
      stage = "save";
      const saveResult = await insertOrRepairEmail(email);
      summary.fetched += 1;
      switch (saveResult) {
        case "inserted":
          summary.inserted += 1;
          break;
        case "updated":
          summary.updated += 1;
          break;
        case "skipped":
          summary.skipped += 1;
          break;
      }
    } catch (error) {
      const googleError = getGoogleErrorDetails(error);
      const { errorName, databaseCode } = safeErrorDetails(error);
      console.warn("Gmail message sync failed:", {
        userId,
        messageId,
        stage,
        errorName,
        ...(googleError.status !== undefined ? { status: googleError.status } : {}),
        ...(databaseCode ? { databaseCode } : {}),
      });
      if (isAuthorizationError(error)) {
        throw toGmailApiError(error);
      }
      summary.failed += 1;
    }
  }

  return summary;
};

export const syncRecentMail = async (
  gmail: gmail_v1.Gmail,
  userId: string,
): Promise<GmailSyncSummary> => {
  const summary: GmailSyncSummary = {
    ...emptySyncSummary(),
  };
  const after = Math.floor((Date.now() - SEVEN_DAYS_MS) / 1000);
  let pageToken: string | undefined;

  do {
    let response: gmail_v1.Schema$ListMessagesResponse;
    try {
      const result = await retryGoogleRequest(() =>
        gmail.users.messages.list({
          userId: "me",
          q: `after:${after} -in:sent`,
          maxResults: MAX_RESULTS_PER_PAGE,
          ...(pageToken ? { pageToken } : {}),
        }),
      );
      response = result.data;
    } catch (error) {
      throw toGmailApiError(error);
    }

    const messageIds = (response.messages ?? [])
      .map((message) => message.id)
      .filter((messageId): messageId is string => Boolean(messageId));
    summary.failed += (response.messages ?? []).length - messageIds.length;
    const pageSummary = await syncMessageIdsForUser(gmail, userId, messageIds);
    summary.fetched += pageSummary.fetched;
    summary.inserted += pageSummary.inserted;
    summary.updated += pageSummary.updated;
    summary.skipped += pageSummary.skipped;
    summary.failed += pageSummary.failed;

    pageToken = response.nextPageToken ?? undefined;
  } while (pageToken);

  return summary;
};
