import { z } from "zod";
import type {
  ApplicationMatchOutcome,
  EmailCategory,
} from "../../database/entities/Email.js";

export const EMAIL_CATEGORIES = [
  "APPLICATION",
  "INTERVIEW",
  "OFFER",
  "ASSESSMENT",
  "HR_COMMUNICATION",
  "OTHER",
] as const satisfies readonly EmailCategory[];

export const EMAIL_EVENT_TYPES = [
  "APPLICATION_RECEIVED",
  "INTERVIEW_SCHEDULED",
  "INTERVIEW_COMPLETED",
  "INTERVIEW_CLEARED",
  "INTERVIEW_REJECTED",
  "ASSESSMENT_REQUESTED",
  "ASSESSMENT_COMPLETED",
  "DOCUMENTS_REQUESTED",
  "DOCUMENTS_SUBMITTED",
  "OFFER_RECEIVED",
  "REJECTION_RECEIVED",
  "HR_UPDATE",
  "OTHER",
] as const;

const nullableText = z
  .string()
  .nullable()
  .transform((value) => value?.trim() || null);

export const emailExtractionSchema = z
  .object({
    isJobRelated: z.boolean(),
    category: z.enum(EMAIL_CATEGORIES),
    eventType: z.enum(EMAIL_EVENT_TYPES),
    companyName: nullableText,
    jobTitle: nullableText,
    jobReferenceId: nullableText,
    applicationReferenceId: nullableText,
    eventDate: nullableText,
    meetingLink: nullableText,
    senderName: nullableText,
    senderOrganization: nullableText,
    summary: nullableText,
  })
  .strict();

export type EmailExtraction = z.infer<typeof emailExtractionSchema>;

export const storedEmailExtractionSchema = z
  .object({
    isJobRelated: z.boolean(),
    category: z.enum(EMAIL_CATEGORIES),
    eventType: z.string().nullable().optional(),
    companyName: z.string().nullable().optional(),
    jobTitle: z.string().nullable().optional(),
    jobReferenceId: z.string().trim().transform((value) => value || null).nullable().optional(),
    applicationReferenceId: z.string().trim().transform((value) => value || null).nullable().optional(),
    eventDate: z.string().nullable().optional(),
    meetingLink: z.string().nullable().optional(),
    senderName: z.string().nullable().optional(),
    senderOrganization: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    applicationMatchOutcome: z.enum([
      "MATCHED",
      "NEW_APPLICATION",
      "NEEDS_REVIEW",
    ] satisfies readonly ApplicationMatchOutcome[]).optional(),
  })
  .passthrough();

export type StoredEmailExtraction = z.infer<
  typeof storedEmailExtractionSchema
>;
