import {
  processPendingEmailsForUser,
  type EmailProcessingSummary,
} from "../../modules/emails/processor.js";
import {
  GmailSyncError,
  syncGmailForUser,
  syncGmailHistoryForUser,
  type GmailSyncSummary,
} from "../../modules/gmail/gmail.service.js";

type EmailPipelineSync =
  | { type: "recent" }
  | { type: "history"; historyId: string }
  | { type: "none" };

interface EmailPipelineSummary {
  sync: GmailSyncSummary | null;
  processing: EmailProcessingSummary;
}

const emptyProcessingSummary = (): EmailProcessingSummary => ({
  processed: 0,
  jobRelated: 0,
  notJobRelated: 0,
  failed: 0,
  remaining: 0,
  aiClassified: 0,
  prefiltered: 0,
});

export const runEmailPipelineForUser = async (
  userId: string,
  syncMode: EmailPipelineSync,
): Promise<EmailPipelineSummary> => {
  let sync: GmailSyncSummary | null = null;
  let syncFailed = false;
  let syncError: unknown;
  try {
    if (syncMode.type === "recent") {
      sync = await syncGmailForUser(userId);
    } else if (syncMode.type === "history") {
      sync = await syncGmailHistoryForUser(userId, syncMode.historyId);
    }

    if (sync && sync.failed > 0) {
      throw new GmailSyncError(
        503,
        "GMAIL_PIPELINE_INGESTION_INCOMPLETE",
        "Gmail ingestion was incomplete and will be retried.",
      );
    }

    console.log(JSON.stringify({
      event: "email.pipeline.ingestion.completed",
      userId,
      syncType: syncMode.type,
      ...(sync ?? {}),
    }));
  } catch (error) {
    syncFailed = true;
    syncError = error;
    console.warn("Gmail ingestion failed; processing saved emails:", {
      userId,
      ...(error instanceof GmailSyncError ? { code: error.code } : {}),
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  const processing = emptyProcessingSummary();
  while (true) {
    const batch = await processPendingEmailsForUser(userId);
    processing.processed += batch.processed;
    processing.jobRelated += batch.jobRelated;
    processing.notJobRelated += batch.notJobRelated;
    processing.failed += batch.failed;
    processing.aiClassified += batch.aiClassified;
    processing.prefiltered += batch.prefiltered;
    processing.remaining = batch.remaining;

    if (batch.remaining === 0 || batch.processed + batch.failed === 0) {
      break;
    }
  }

  console.log(JSON.stringify({
    event: "email.pipeline.processing.completed",
    userId,
    ...processing,
  }));

  if (syncFailed) {
    throw syncError;
  }
  return { sync, processing };
};
