import { Brackets, type EntityManager } from "typeorm";
import { AppDataSource } from "../../config/db.js";
import { Application } from "../../database/entities/Application.js";
import { Email, type ApplicationMatchOutcome } from "../../database/entities/Email.js";
import {
  getApplicationDisplayName,
  getUsableExtraction,
  isReliableNewApplication,
  createApplicationAssociationIndexes,
  selectApplication,
} from "./application-matching.js";
import { getLatestApplicationStatus } from "./application-status.js";
import type { StoredEmailExtraction } from "../emails/extraction.js";
import {
  getJobTitleMatchKey,
  normalizeCompanyName,
  normalizeJobTitle,
} from "./application-normalization.js";

const MATCH_BATCH_SIZE = 10;

export interface ApplicationProcessingSummary {
  examined: number;
  ignored: number;
  applicationsCreated: number;
  applicationsMatched: number;
  emailsAssociated: number;
  statusesUpdated: number;
  outcomes: Record<ApplicationMatchOutcome, number>;
}

const findCandidates = async (
  manager: EntityManager,
  userId: string,
  email: Email,
  extraction: StoredEmailExtraction,
): Promise<{ applications: Application[]; emails: Email[] }> => {
  const relatedEmails = await manager.getRepository(Email)
    .createQueryBuilder("email")
    .select([
      "email.id",
      "email.applicationId",
      "email.gmailThreadId",
      "email.extractedData",
    ])
    .where("email.user_id = :userId", { userId })
    .andWhere("email.application_id IS NOT NULL")
    .andWhere(new Brackets((query) => {
      query.where("email.gmail_thread_id = :threadId", {
        threadId: email.gmailThreadId,
      });
      if (extraction.jobReferenceId) {
        query.orWhere(
          "jobpilot_trim_reference(email.extracted_data ->> 'jobReferenceId') = :jobReferenceId",
          { jobReferenceId: extraction.jobReferenceId },
        );
      }
      if (extraction.applicationReferenceId) {
        query.orWhere(
          "jobpilot_trim_reference(email.extracted_data ->> 'applicationReferenceId') = :applicationReferenceId",
          { applicationReferenceId: extraction.applicationReferenceId },
        );
      }
    }))
    .getMany();
  const associatedIds = [...new Set(
    [...relatedEmails.map((item) => item.applicationId), email.applicationId]
      .filter((id): id is string => Boolean(id)),
  )];
  const company = normalizeCompanyName(extraction.companyName);
  const title = extraction.jobTitle;
  const titleKey =
    title && normalizeJobTitle(title) ? getJobTitleMatchKey(title) : null;
  if (!associatedIds.length && !(company && titleKey)) {
    return { applications: [], emails: relatedEmails };
  }
  const applications = await manager.getRepository(Application)
    .createQueryBuilder("application")
    .where("application.user_id = :userId", { userId })
    .andWhere(new Brackets((query) => {
      if (associatedIds.length) {
        query.where("application.id IN (:...associatedIds)", { associatedIds });
      }
      if (company && titleKey) {
        const condition =
          "(application.normalized_company_name = :company AND application.normalized_job_title = :title)";
        const parameters = { company, title: titleKey };
        if (associatedIds.length) {
          query.orWhere(condition, parameters);
        } else {
          query.where(condition, parameters);
        }
      }
    }))
    .getMany();
  return { applications, emails: relatedEmails };
};

const emptySummary = (): ApplicationProcessingSummary => ({
  examined: 0,
  ignored: 0,
  applicationsCreated: 0,
  applicationsMatched: 0,
  emailsAssociated: 0,
  statusesUpdated: 0,
  outcomes: { MATCHED: 0, NEW_APPLICATION: 0, NEEDS_REVIEW: 0 },
});

export const processAiProcessedEmailsForUser = async (
  userId: string,
): Promise<ApplicationProcessingSummary> => {
  const summary = emptySummary();
  while (true) {
    const processed = await AppDataSource.transaction(async (manager) => {
      await manager.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [userId],
      );
      const emailRepository = manager.getRepository(Email);
      const applicationRepository = manager.getRepository(Application);
      const emails = await emailRepository.find({
        where: { userId, matchingPending: true },
        order: { receivedAt: "ASC", id: "ASC" },
        take: MATCH_BATCH_SIZE,
        lock: { mode: "pessimistic_write" },
      });
      const affectedIds = new Set<string>();

      for (const email of emails) {
        summary.examined += 1;
        email.matchingPending = false;
        if (email.associationSource === "MANUAL") {
          summary.ignored += 1;
          await emailRepository.save(email);
          continue;
        }
        const extraction = getUsableExtraction(email);
        if (!extraction) {
          summary.ignored += 1;
          console.warn("Email matching skipped an invalid extraction:", {
            emailId: email.id,
          });
          await emailRepository.save(email);
          continue;
        }

        const previousApplicationId = email.applicationId;
        let application: Application | undefined;
        let outcome: ApplicationMatchOutcome = "NEEDS_REVIEW";
        if (
          extraction.isJobRelated &&
          !(extraction.category === "OTHER" && extraction.eventType === "OTHER")
        ) {
          const candidates = await findCandidates(manager, userId, email, extraction);
          const indexes = createApplicationAssociationIndexes(
            candidates.applications,
            candidates.emails,
          );
          const selection = selectApplication(
            email,
            extraction,
            candidates.applications,
            indexes,
          );
          application = selection.application;
          if (application) {
            outcome = "MATCHED";
            summary.applicationsMatched += 1;
          } else if (
            !selection.ambiguous &&
            isReliableNewApplication(extraction)
          ) {
            const companyName = extraction.companyName?.trim();
            const jobTitle = extraction.jobTitle?.trim();
            if (
              companyName &&
              jobTitle &&
              normalizeCompanyName(companyName) &&
              normalizeJobTitle(jobTitle)
            ) {
              application = await applicationRepository.save(
                applicationRepository.create({
                  userId,
                  companyName: getApplicationDisplayName(companyName),
                  jobTitle: getApplicationDisplayName(jobTitle),
                  status: "APPLIED",
                  appliedAt:
                    extraction.category === "APPLICATION" ? email.receivedAt : null,
                }),
              );
              summary.applicationsCreated += 1;
              outcome = "NEW_APPLICATION";
            }
          }
        } else if (!extraction.isJobRelated) {
          summary.ignored += 1;
        }

        email.applicationId = application?.id ?? null;
        email.extractedData = {
          ...email.extractedData!,
          applicationMatchOutcome: outcome,
        };
        await emailRepository.save(email);
        summary.outcomes[outcome] += 1;
        if (previousApplicationId) {
          affectedIds.add(previousApplicationId);
        }
        if (application) {
          affectedIds.add(application.id);
          if (previousApplicationId !== application.id) {
            summary.emailsAssociated += 1;
          }
        }
      }

      for (const applicationId of [...affectedIds].sort()) {
        const application = await applicationRepository.findOne({
          where: { id: applicationId, userId },
          lock: { mode: "pessimistic_write" },
        });
        if (!application) {
          continue;
        }
        const associatedEmails = await emailRepository.find({
          where: { userId, applicationId },
          select: {
            id: true,
            applicationId: true,
            extractedData: true,
            receivedAt: true,
          },
        });
        const status = getLatestApplicationStatus(
          applicationId,
          associatedEmails,
          application.status,
        );
        if (status !== application.status) {
          application.status = status;
          await applicationRepository.save(application);
          summary.statusesUpdated += 1;
        }
      }
      return emails.length;
    });
    if (processed < MATCH_BATCH_SIZE) {
      break;
    }
  }
  console.log(JSON.stringify({
    event: "application.processing.completed",
    userId,
    ...summary,
  }));
  return summary;
};
