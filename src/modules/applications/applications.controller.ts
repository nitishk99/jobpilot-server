import type { RequestHandler } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../../config/db.js";
import { Application } from "../../database/entities/Application.js";
import { Email } from "../../database/entities/Email.js";
import {
  getEmailTimelineTimestamp,
  getLatestApplicationStatus,
} from "./application-status.js";
import {
  asNullableString,
  asRecord,
  getGmailUrl,
  getLastActivityAt,
  isEmailCategory,
  toIsoString,
} from "../emails/email-api-fields.js";
import { sendError, sendSuccess } from "../../utils/api-response.js";

const uuidSchema = z.string().uuid();
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  sortBy: z.enum(["lastActivityAt", "companyName", "createdAt"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

interface ApplicationSummary {
  id: string;
  companyName: string;
  jobTitle: string;
  status: Application["status"];
  appliedAt: string | null;
  lastActivityAt: string | null;
  totalEmailCount: number;
  createdAt: Date;
}

export const listApplications: RequestHandler = async (req, res) => {
  if (!req.authUserId) {
    sendError(res, 401, "Authentication required");
    return;
  }
  const parsedQuery = listQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    sendError(res, 400, "Invalid application query");
    return;
  }

  const { page, limit, search, sortBy, order } = parsedQuery.data;
  try {
    const applications = await AppDataSource.getRepository(Application).find({
      where: { userId: req.authUserId },
    });

    const emails = applications.length
      ? await AppDataSource.getRepository(Email).find({
          where: {
            userId: req.authUserId,
            applicationId: In(applications.map(({ id }) => id)),
          },
          select: {
            id: true,
            applicationId: true,
            extractedData: true,
            receivedAt: true,
          },
        })
      : [];
    const emailsByApplicationId = new Map<string, Email[]>();
    for (const email of emails) {
      if (!email.applicationId) {
        continue;
      }
      const associatedEmails =
        emailsByApplicationId.get(email.applicationId) ?? [];
      associatedEmails.push(email);
      emailsByApplicationId.set(email.applicationId, associatedEmails);
    }

    const summaries: ApplicationSummary[] = applications.map((application) => {
      const associatedEmails = emailsByApplicationId.get(application.id) ?? [];
      return {
        id: application.id,
        companyName: application.companyName,
        jobTitle: application.jobTitle,
        status: getLatestApplicationStatus(
          application.id,
          associatedEmails,
          application.status,
        ),
        appliedAt: toIsoString(application.appliedAt),
        lastActivityAt: toIsoString(getLastActivityAt(associatedEmails)),
        totalEmailCount: associatedEmails.length,
        createdAt: application.createdAt,
      };
    });

    const normalizedSearch = search?.toLocaleLowerCase("en-US");
    const filtered = normalizedSearch
      ? summaries.filter((application) =>
          `${application.companyName} ${application.jobTitle}`
            .toLocaleLowerCase("en-US")
            .includes(normalizedSearch),
        )
      : summaries;
    const direction = order === "asc" ? 1 : -1;
    filtered.sort((left, right) => {
      let comparison: number;
      if (sortBy === "companyName") {
        comparison = left.companyName.localeCompare(right.companyName);
      } else if (sortBy === "lastActivityAt") {
        if (!left.lastActivityAt && !right.lastActivityAt) {
          comparison = 0;
        } else if (!left.lastActivityAt) {
          return 1;
        } else if (!right.lastActivityAt) {
          return -1;
        } else {
          comparison =
            Date.parse(left.lastActivityAt) - Date.parse(right.lastActivityAt);
        }
      } else {
        comparison = left.createdAt.getTime() - right.createdAt.getTime();
      }
      return comparison * direction || left.id.localeCompare(right.id);
    });

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const stats = {
      total: summaries.length,
      inProgress: summaries.filter(({ status }) =>
        ["APPLIED", "SCREENING", "INTERVIEW"].includes(status),
      ).length,
      interviewing: summaries.filter(({ status }) => status === "INTERVIEW").length,
      offers: summaries.filter(({ status }) => status === "OFFER").length,
      newlyApplied: summaries.filter(({ status }) => status === "APPLIED").length,
    };
    const pageItems = filtered.slice(offset, offset + limit).map(({
      createdAt: _createdAt,
      ...application
    }) => application);

    sendSuccess(res, 200, "Applications loaded", {
      applications: pageItems,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      stats,
    });
  } catch (error) {
    console.error(
      "Application list lookup failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    sendError(res, 500, "Unable to load applications");
  }
};

export const getApplicationTimeline: RequestHandler = async (req, res) => {
  const parsedId = uuidSchema.safeParse(req.params.id);
  if (!parsedId.success || !req.authUserId) {
    sendError(res, 404, "Application not found");
    return;
  }

  try {
    const applicationRepository = AppDataSource.getRepository(Application);
    const application = await applicationRepository.findOne({
      where: { id: parsedId.data, userId: req.authUserId },
    });
    if (!application) {
      sendError(res, 404, "Application not found");
      return;
    }

    const emails = await AppDataSource.getRepository(Email).find({
      where: { applicationId: application.id, userId: req.authUserId },
      select: {
        id: true,
        applicationId: true,
        extractedData: true,
        receivedAt: true,
        subject: true,
        gmailMessageId: true,
      },
    });
    const orderedEmails = [...emails].sort(
      (left, right) =>
        getEmailTimelineTimestamp(left.extractedData, left.receivedAt) -
          getEmailTimelineTimestamp(right.extractedData, right.receivedAt) ||
        left.receivedAt.getTime() - right.receivedAt.getTime() ||
        left.id.localeCompare(right.id),
    );
    const lastActivity = getLastActivityAt(emails);

    const timeline = orderedEmails.map((email) => {
      const extraction = asRecord(email.extractedData);
      const category = isEmailCategory(extraction?.category)
        ? extraction.category
        : null;
      return {
        emailId: email.id,
        gmailMessageId: email.gmailMessageId,
        gmailUrl: getGmailUrl(email.gmailMessageId),
        eventType: asNullableString(extraction?.eventType),
        category,
        eventDate: asNullableString(extraction?.eventDate),
        emailReceivedAt: toIsoString(email.receivedAt),
        subject: email.subject,
        summary: asNullableString(extraction?.summary),
        senderName: asNullableString(extraction?.senderName),
        senderOrganization: asNullableString(
          extraction?.senderOrganization,
        ),
        meetingLink: asNullableString(extraction?.meetingLink),
        originalEmailAvailable: true,
      };
    });

    sendSuccess(res, 200, "Application timeline loaded", {
      application: {
        id: application.id,
        companyName: application.companyName,
        jobTitle: application.jobTitle,
        status: getLatestApplicationStatus(
          application.id,
          emails,
          application.status,
        ),
        appliedAt: toIsoString(application.appliedAt),
        lastActivityAt: toIsoString(lastActivity),
        totalEmailCount: emails.length,
      },
      timeline,
    });
  } catch (error) {
    console.error(
      "Application timeline lookup failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    sendError(res, 500, "Unable to load application timeline");
  }
};
