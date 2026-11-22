import type { ApplicationStatus } from "../../database/entities/Application.js";
import type { Email } from "../../database/entities/Email.js";

const statusByEventType: Record<string, ApplicationStatus> = {
  APPLICATION_RECEIVED: "APPLIED",
  INTERVIEW_SCHEDULED: "INTERVIEW",
  INTERVIEW_CLEARED: "INTERVIEW",
  INTERVIEW_REJECTED: "REJECTED",
  OFFER_RECEIVED: "OFFER",
  REJECTION_RECEIVED: "REJECTED",
};

const legacyStatusByCategory: Record<string, ApplicationStatus> = {
  APPLICATION: "APPLIED",
  INTERVIEW: "INTERVIEW",
  OFFER: "OFFER",
};

const getRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const getEventDateTimestamp = (extractedData: unknown): number | null => {
  const eventDate = getRecord(extractedData)?.eventDate;
  if (typeof eventDate !== "string" || !eventDate.trim()) {
    return null;
  }
  const timestamp = Date.parse(eventDate);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const getReceivedAtTimestamp = (receivedAt: Date): number =>
  Number.isFinite(receivedAt.getTime()) ? receivedAt.getTime() : 0;

export const getEmailTimelineTimestamp = (
  extractedData: unknown,
  receivedAt: Date,
): number =>
  getEventDateTimestamp(extractedData) ?? getReceivedAtTimestamp(receivedAt);

const getStatusForEmail = (extractedData: unknown): ApplicationStatus | null => {
  const data = getRecord(extractedData);
  if (!data || data.isJobRelated !== true) {
    return null;
  }

  if (typeof data.eventType === "string") {
    return statusByEventType[data.eventType] ?? null;
  }

  return typeof data.category === "string"
    ? legacyStatusByCategory[data.category] ?? null
    : null;
};

export const getLatestApplicationStatus = (
  applicationId: string,
  emails: readonly Email[],
  currentStatus: ApplicationStatus,
): ApplicationStatus => {
  const events = emails
    .filter((email) => email.applicationId === applicationId)
    .flatMap((email) => {
      const status = getStatusForEmail(email.extractedData);
      if (!status) {
        return [];
      }
      const receivedAt = getReceivedAtTimestamp(email.receivedAt);
      return [{
        status,
        timestamp: getEmailTimelineTimestamp(email.extractedData, email.receivedAt),
        receivedAt,
        emailId: email.id,
      }];
    })
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        right.receivedAt - left.receivedAt ||
        left.emailId.localeCompare(right.emailId),
    );

  return events[0]?.status ?? currentStatus;
};
