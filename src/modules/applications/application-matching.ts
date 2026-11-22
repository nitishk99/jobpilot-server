import type { Application } from "../../database/entities/Application.js";
import type { Email } from "../../database/entities/Email.js";
import {
  storedEmailExtractionSchema,
  type StoredEmailExtraction,
} from "../emails/extraction.js";
import {
  getJobTitleMatchKey,
  normalizeCompanyName,
  normalizeJobTitle,
} from "./application-normalization.js";

export const getUsableExtraction = (
  email: Email,
): StoredEmailExtraction | null => {
  const parsed = storedEmailExtractionSchema.safeParse(email.extractedData);
  return parsed.success ? parsed.data : null;
};

const titlesMatch = (left: string, right: string): boolean => {
  const normalizedLeft = getJobTitleMatchKey(left);
  const normalizedRight = getJobTitleMatchKey(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
};

export const isReliableNewApplication = (
  extraction: StoredEmailExtraction,
): boolean => {
  if (extraction.eventType === "APPLICATION_RECEIVED") {
    return true;
  }
  if (
    extraction.eventType === "HR_UPDATE" &&
    extraction.category === "HR_COMMUNICATION"
  ) {
    return true;
  }
  return !extraction.eventType && extraction.category === "APPLICATION";
};

const getReferenceKey = (
  kind: "jobReferenceId" | "applicationReferenceId",
  value: string,
): string => `${kind}\u0000${value}`;

export const getReferenceKeys = (extraction: StoredEmailExtraction): string[] => {
  const keys: string[] = [];
  if (extraction.jobReferenceId) {
    keys.push(getReferenceKey("jobReferenceId", extraction.jobReferenceId));
  }
  if (extraction.applicationReferenceId) {
    keys.push(
      getReferenceKey(
        "applicationReferenceId",
        extraction.applicationReferenceId,
      ),
    );
  }
  return keys;
};

const getReferenceApplicationIds = (
  extraction: StoredEmailExtraction,
  applicationsByReference: Map<string, Set<string>>,
): Set<string> => {
  const applicationIds = new Set<string>();
  for (const key of getReferenceKeys(extraction)) {
    for (const applicationId of applicationsByReference.get(key) ?? []) {
      applicationIds.add(applicationId);
    }
  }
  return applicationIds;
};

const getTitleCandidates = (
  extraction: StoredEmailExtraction,
  applications: Application[],
): Application[] => {
  const company = normalizeCompanyName(extraction.companyName);
  const jobTitle = extraction.jobTitle;
  if (!company || !jobTitle || !normalizeJobTitle(jobTitle)) {
    return [];
  }
  return applications.filter(
    (application) =>
      normalizeCompanyName(application.companyName) === company &&
      titlesMatch(application.jobTitle, jobTitle),
  );
};

const conflictsWithApplication = (
  extraction: StoredEmailExtraction,
  application: Application,
): boolean => {
  const company = normalizeCompanyName(extraction.companyName);
  const jobTitle = normalizeJobTitle(extraction.jobTitle);
  return Boolean(
    (company && normalizeCompanyName(application.companyName) !== company) ||
      (jobTitle &&
        !titlesMatch(application.jobTitle, extraction.jobTitle!)),
  );
};

type MatchableEmail = Pick<Email, "gmailThreadId" | "applicationId">;

export interface ApplicationAssociationIndexes {
  applicationsById: Map<string, Application>;
  applicationsByReference: Map<string, Set<string>>;
  applicationsByThread: Map<string, Set<string>>;
}

export const selectApplication = (
  email: MatchableEmail,
  extraction: StoredEmailExtraction,
  applications: Application[],
  indexes: ApplicationAssociationIndexes,
): { application?: Application; ambiguous: boolean } => {
  const {
    applicationsById,
    applicationsByReference,
    applicationsByThread,
  } = indexes;
  const referenceApplicationIds = getReferenceApplicationIds(
    extraction,
    applicationsByReference,
  );
  if (referenceApplicationIds.size > 1) {
    return { ambiguous: true };
  }
  if (referenceApplicationIds.size === 1) {
    const applicationId = [...referenceApplicationIds][0]!;
    const application = applicationsById.get(applicationId);
    return application && !conflictsWithApplication(extraction, application)
      ? { application, ambiguous: false }
      : { ambiguous: true };
  }

  const titleCandidates = getTitleCandidates(extraction, applications);
  const threadApplicationIds = new Set(
    applicationsByThread.get(email.gmailThreadId) ?? [],
  );
  if (email.applicationId && applicationsById.has(email.applicationId)) {
    threadApplicationIds.add(email.applicationId);
  }

  if (threadApplicationIds.size === 1) {
    const threadApplicationId = [...threadApplicationIds][0]!;
    const threadApplication = applicationsById.get(threadApplicationId);
    if (!threadApplication) {
      return { ambiguous: true };
    }
    if (!conflictsWithApplication(extraction, threadApplication)) {
      return { application: threadApplication, ambiguous: false };
    }
    if (titleCandidates.length === 1) {
      return { application: titleCandidates[0], ambiguous: false };
    }
    return { ambiguous: true };
  }

  if (threadApplicationIds.size > 1) {
    if (titleCandidates.length === 1) {
      return { application: titleCandidates[0], ambiguous: false };
    }
    return { ambiguous: true };
  }

  if (titleCandidates.length === 1) {
    return { application: titleCandidates[0], ambiguous: false };
  }
  return { ambiguous: titleCandidates.length > 1 };
};

export const getApplicationDisplayName = (value: string): string =>
  value.trim().replace(/\s+/g, " ");

const addThreadAssociation = (
  applicationsByThread: Map<string, Set<string>>,
  threadId: string,
  applicationId: string,
): void => {
  const applicationIds = applicationsByThread.get(threadId) ?? new Set<string>();
  applicationIds.add(applicationId);
  applicationsByThread.set(threadId, applicationIds);
};

const addReferenceAssociations = (
  applicationsByReference: Map<string, Set<string>>,
  applicationId: string,
  email: Email,
): void => {
  const extraction = getUsableExtraction(email);
  if (!extraction) {
    return;
  }

  for (const key of getReferenceKeys(extraction)) {
    const applicationIds = applicationsByReference.get(key) ?? new Set<string>();
    applicationIds.add(applicationId);
    applicationsByReference.set(key, applicationIds);
  }
};

export const createApplicationAssociationIndexes = (
  applications: Application[],
  emails: Email[],
): ApplicationAssociationIndexes => {
  const applicationsById = new Map(
    applications.map((application) => [application.id, application]),
  );
  const applicationsByReference = new Map<string, Set<string>>();
  const applicationsByThread = new Map<string, Set<string>>();

  for (const email of emails) {
    if (!email.applicationId || !applicationsById.has(email.applicationId)) {
      continue;
    }

    addThreadAssociation(
      applicationsByThread,
      email.gmailThreadId,
      email.applicationId,
    );
    addReferenceAssociations(
      applicationsByReference,
      email.applicationId,
      email,
    );
  }

  return { applicationsById, applicationsByReference, applicationsByThread };
};
