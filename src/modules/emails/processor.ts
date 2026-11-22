import { AppDataSource } from "../../config/db.js";
import { getOpenAiApiKey } from "../../config/env.js";
import { Email } from "../../database/entities/Email.js";
import type { EmailExtraction } from "./extraction.js";
import { processAiProcessedEmailsForUser } from "../applications/application-processing.service.js";
import {
  classifyEmail,
  EmailProcessingError,
  isLikelyJobRelatedEmail,
} from "./classifier.js";

const BATCH_SIZE = 10;

export interface EmailProcessingSummary {
  processed: number;
  jobRelated: number;
  notJobRelated: number;
  failed: number;
  remaining: number;
  aiClassified: number;
  prefiltered: number;
}

export const processPendingEmailsForUser = async (
  userId: string,
  batchSize = BATCH_SIZE,
): Promise<EmailProcessingSummary> => {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > BATCH_SIZE) {
    throw new EmailProcessingError(
      400,
      "INVALID_BATCH_SIZE",
      `batchSize must be an integer from 1 to ${BATCH_SIZE}.`,
    );
  }

  const emails = AppDataSource.getRepository(Email);
  const candidates = await emails.find({
    where: { userId, processingStatus: "PENDING" },
    order: { receivedAt: "ASC", id: "ASC" },
    take: batchSize,
  });
  if (
    !getOpenAiApiKey() &&
    candidates.some(isLikelyJobRelatedEmail)
  ) {
    await processAiProcessedEmailsForUser(userId);
    throw new EmailProcessingError(
      503,
      "OPENAI_NOT_CONFIGURED",
      "OpenAI API is not configured on the server.",
    );
  }
  const summary: EmailProcessingSummary = {
    processed: 0,
    jobRelated: 0,
    notJobRelated: 0,
    failed: 0,
    remaining: 0,
    aiClassified: 0,
    prefiltered: 0,
  };
  let retryError: EmailProcessingError | undefined;

  for (const email of candidates) {
    const claim = await emails.update(
      {
        id: email.id,
        userId,
        processingStatus: "PENDING",
      },
      {
        processingStatus: "PROCESSING",
        processedAt: new Date(),
      },
    );
    if (!claim.affected) {
      continue;
    }

    let extractedData: EmailExtraction;
    const usesAi = isLikelyJobRelatedEmail(email);
    try {
      extractedData = await classifyEmail(email);
    } catch (error) {
      const retryable = error instanceof EmailProcessingError &&
        error.statusCode === 503;
      await emails.update(
        {
          id: email.id,
          userId,
          processingStatus: "PROCESSING",
        },
        {
          processingStatus: retryable ? "PENDING" : "FAILED",
          processedAt: retryable ? null : new Date(),
        },
      );
      summary.failed += 1;
      console.warn(
        "OpenAI email processing failed:",
        error instanceof EmailProcessingError
          ? {
              code: error.code,
              ...(error.providerErrorName
                ? { providerErrorName: error.providerErrorName }
                : {}),
              ...(error.providerErrorCode
                ? { providerErrorCode: error.providerErrorCode }
                : {}),
            }
          : error instanceof Error
            ? { errorName: error.name }
            : { errorName: "UnknownError" },
      );
      if (retryable) {
        retryError = error;
      }
      continue;
    }

    const saved = await emails
      .createQueryBuilder()
      .update(Email)
      .set({
        extractedData: () => "CAST(:extractedData AS jsonb)",
        processingStatus: "PROCESSED",
        matchingPending: true,
        processedAt: new Date(),
      })
      .where(
        "id = :id AND user_id = :userId AND processing_status = :processingStatus",
        {
          id: email.id,
          userId,
          processingStatus: "PROCESSING",
        },
      )
      .setParameter("extractedData", JSON.stringify(extractedData))
      .execute();

    if (saved.affected !== 1) {
      throw new Error("Email processing claim was lost before saving extraction.");
    }

    summary.processed += 1;
    summary[usesAi ? "aiClassified" : "prefiltered"] += 1;
    summary[extractedData.isJobRelated ? "jobRelated" : "notJobRelated"] += 1;
  }

  await processAiProcessedEmailsForUser(userId);
  // Retry temporary failures after saving the other emails in this batch.
  if (retryError) {
    throw retryError;
  }
  summary.remaining = await emails.count({
    where: { userId, processingStatus: "PENDING" },
  });
  return summary;
};
