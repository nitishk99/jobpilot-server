import type {
  ApplicationMatchOutcome,
  EmailCategory,
} from "../../database/entities/Email.js";

const emailCategories = new Set<string>([
  "APPLICATION",
  "INTERVIEW",
  "OFFER",
  "ASSESSMENT",
  "HR_COMMUNICATION",
  "OTHER",
]);

const matchOutcomes = new Set<string>([
  "MATCHED",
  "NEW_APPLICATION",
  "NEEDS_REVIEW",
]);

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

export const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export const isEmailCategory = (value: unknown): value is EmailCategory =>
  typeof value === "string" && emailCategories.has(value);

export const isApplicationMatchOutcome = (
  value: unknown,
): value is ApplicationMatchOutcome =>
  typeof value === "string" && matchOutcomes.has(value);

export const toIsoString = (
  date: Date | null | undefined,
): string | null =>
  date instanceof Date && Number.isFinite(date.getTime())
    ? date.toISOString()
    : null;

export const getLastActivityAt = (
  emails: readonly { receivedAt: Date }[],
): Date | null =>
  emails.reduce<Date | null>((latest, email) => {
    const timestamp = email.receivedAt.getTime();
    if (!Number.isFinite(timestamp)) {
      return latest;
    }
    return !latest || timestamp > latest.getTime()
      ? email.receivedAt
      : latest;
  }, null);

export const getGmailUrl = (
  gmailMessageId: string | null | undefined,
): string | null =>
  gmailMessageId
    ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(gmailMessageId)}`
    : null;
