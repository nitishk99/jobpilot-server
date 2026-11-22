import { AppDataSource } from "../../config/db.js";
import { Application } from "../../database/entities/Application.js";
import { Email } from "../../database/entities/Email.js";
import { getLatestApplicationStatus } from "../applications/application-status.js";
import {
  getLastActivityAt,
  toIsoString,
} from "./email-api-fields.js";
import { storedEmailExtractionSchema } from "./extraction.js";
import {
  getApplicationDisplayName,
} from "../applications/application-matching.js";
import {
  normalizeCompanyName,
  normalizeJobTitle,
} from "../applications/application-normalization.js";

export type EmailAssociationOperation = "associate" | "reassign" | "unassociate";

export class EmailAssociationError extends Error {
  constructor(
    public readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "EmailAssociationError";
  }
}

export interface UpdatedApplicationActivity {
  id: string;
  status: Application["status"];
  totalEmailCount: number;
  lastActivityAt: string | null;
}

export interface EmailAssociationResult {
  emailId: string;
  applicationId: string | null;
  associationSource: "MANUAL";
  applications: UpdatedApplicationActivity[];
}

export interface DismissEmailReviewResult {
  emailId: string;
  dismissed: true;
}

export interface CreateApplicationFromEmailResult {
  emailId: string;
  application: {
    id: string;
    companyName: string;
    jobTitle: string;
    status: Application["status"];
    totalEmailCount: number;
    lastActivityAt: string | null;
  };
}

export const createApplicationFromReviewEmail = async (
  userId: string,
  emailId: string,
  fields?: {
    companyName?: string;
    jobTitle?: string;
  },
): Promise<CreateApplicationFromEmailResult> =>
  AppDataSource.transaction(async (manager) => {
    const emailRepository = manager.getRepository(Email);
    const applicationRepository = manager.getRepository(Application);
    const email = await emailRepository.findOne({
      where: { id: emailId, userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!email) {
      throw new EmailAssociationError(404, "Email not found");
    }
    if (email.processingStatus !== "PROCESSED") {
      throw new EmailAssociationError(409, "Email is not ready for review");
    }
    if (email.applicationId) {
      throw new EmailAssociationError(409, "Email is already associated");
    }

    const parsedExtraction = storedEmailExtractionSchema.safeParse(
      email.extractedData,
    );
    if (!parsedExtraction.success || !parsedExtraction.data.isJobRelated) {
      throw new EmailAssociationError(409, "Email is not eligible for review");
    }
    if (
      parsedExtraction.data.applicationMatchOutcome &&
      parsedExtraction.data.applicationMatchOutcome !== "NEEDS_REVIEW"
    ) {
      throw new EmailAssociationError(409, "Email is not awaiting review");
    }

    const companyName =
      fields?.companyName?.trim() || parsedExtraction.data.companyName?.trim();
    const jobTitle =
      fields?.jobTitle?.trim() || parsedExtraction.data.jobTitle?.trim();
    if (!companyName || !jobTitle) {
      throw new EmailAssociationError(
        409,
        "companyName and jobTitle are required to create an application",
      );
    }
    if (!normalizeCompanyName(companyName) || !normalizeJobTitle(jobTitle)) {
      throw new EmailAssociationError(
        409,
        "companyName and jobTitle must contain meaningful text",
      );
    }

    const application = await applicationRepository.save(
      applicationRepository.create({
        userId,
        companyName: getApplicationDisplayName(companyName),
        jobTitle: getApplicationDisplayName(jobTitle),
        status: "APPLIED",
        source: "Manual review",
        appliedAt:
          parsedExtraction.data.eventType === "APPLICATION_RECEIVED" ||
          parsedExtraction.data.category === "APPLICATION"
            ? email.receivedAt
            : null,
        notes: null,
      }),
    );

    email.applicationId = application.id;
    email.associationSource = "MANUAL";
    email.extractedData = {
      ...email.extractedData!,
      companyName: application.companyName,
      jobTitle: application.jobTitle,
      applicationMatchOutcome: "NEW_APPLICATION",
    };
    await emailRepository.save(email);

    const status = getLatestApplicationStatus(
      application.id,
      [email],
      application.status,
    );
    if (application.status !== status) {
      application.status = status;
      await applicationRepository.save(application);
    }

    return {
      emailId: email.id,
      application: {
        id: application.id,
        companyName: application.companyName,
        jobTitle: application.jobTitle,
        status: application.status,
        totalEmailCount: 1,
        lastActivityAt: toIsoString(email.receivedAt),
      },
    };
  });

export const dismissEmailFromReview = async (
  userId: string,
  emailId: string,
): Promise<DismissEmailReviewResult> =>
  AppDataSource.transaction(async (manager) => {
    const emailRepository = manager.getRepository(Email);
    const email = await emailRepository.findOne({
      where: { id: emailId, userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!email) {
      throw new EmailAssociationError(404, "Email not found");
    }
    if (email.processingStatus !== "PROCESSED" || email.applicationId) {
      throw new EmailAssociationError(409, "Email is not awaiting review");
    }

    const extraction = storedEmailExtractionSchema.safeParse(
      email.extractedData,
    );
    if (!extraction.success || !extraction.data.isJobRelated) {
      throw new EmailAssociationError(409, "Email is not eligible for review");
    }
    if (
      extraction.data.applicationMatchOutcome &&
      extraction.data.applicationMatchOutcome !== "NEEDS_REVIEW"
    ) {
      throw new EmailAssociationError(409, "Email is not awaiting review");
    }

    email.associationSource = "MANUAL";
    email.extractedData = {
      ...email.extractedData!,
      isJobRelated: false,
      category: "OTHER",
      eventType: "OTHER",
      applicationMatchOutcome: "NEEDS_REVIEW",
    };
    await emailRepository.save(email);

    return { emailId: email.id, dismissed: true };
  });

export const changeEmailAssociation = async (
  userId: string,
  emailId: string,
  operation: EmailAssociationOperation,
  targetApplicationId?: string,
): Promise<EmailAssociationResult> =>
  AppDataSource.transaction(async (manager) => {
    const emailRepository = manager.getRepository(Email);
    const applicationRepository = manager.getRepository(Application);
    const email = await emailRepository.findOne({
      where: { id: emailId, userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!email) {
      throw new EmailAssociationError(404, "Email not found");
    }

    if (operation === "associate" && email.applicationId) {
      throw new EmailAssociationError(
        409,
        "Email is already associated; use the reassign endpoint",
      );
    }
    if (operation === "reassign" && !email.applicationId) {
      throw new EmailAssociationError(
        409,
        "Email has no current application association",
      );
    }
    if (
      operation !== "unassociate" &&
      email.applicationId === targetApplicationId
    ) {
      throw new EmailAssociationError(
        409,
        "Email is already associated with this application",
      );
    }
    if (operation !== "unassociate" && !targetApplicationId) {
      throw new EmailAssociationError(404, "Application not found");
    }

    const previousApplicationId = email.applicationId;
    const affectedApplicationIds = [
      ...new Set(
        [previousApplicationId, targetApplicationId].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ].sort();
    const applicationsById = new Map<string, Application>();
    for (const id of affectedApplicationIds) {
      const application = await applicationRepository.findOne({
        where: { id, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (application) {
        applicationsById.set(id, application);
      }
    }

    if (
      targetApplicationId &&
      !applicationsById.has(targetApplicationId)
    ) {
      throw new EmailAssociationError(404, "Application not found");
    }

    email.applicationId =
      operation === "unassociate" ? null : targetApplicationId ?? null;
    email.associationSource = "MANUAL";
    if (email.extractedData) {
      email.extractedData = {
        ...email.extractedData,
        applicationMatchOutcome:
          operation === "unassociate" ? "NEEDS_REVIEW" : "MATCHED",
      };
    }
    await emailRepository.save(email);

    const applications: UpdatedApplicationActivity[] = [];
    for (const id of affectedApplicationIds) {
      const application = applicationsById.get(id);
      if (!application) {
        continue;
      }
      const associatedEmails = await emailRepository.find({
        where: { userId, applicationId: id },
        select: {
          id: true,
          applicationId: true,
          extractedData: true,
          receivedAt: true,
        },
      });
      const status = getLatestApplicationStatus(
        id,
        associatedEmails,
        application.status,
      );
      if (status !== application.status) {
        application.status = status;
        await applicationRepository.save(application);
      }
      applications.push({
        id,
        status: application.status,
        totalEmailCount: associatedEmails.length,
        lastActivityAt: toIsoString(getLastActivityAt(associatedEmails)),
      });
    }

    return {
      emailId: email.id,
      applicationId: email.applicationId,
      associationSource: "MANUAL",
      applications,
    };
  });
