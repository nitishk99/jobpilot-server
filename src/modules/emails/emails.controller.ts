import type { RequestHandler } from "express";
import { z } from "zod";
import { AppDataSource } from "../../config/db.js";
import { Email } from "../../database/entities/Email.js";
import {
  changeEmailAssociation,
  createApplicationFromReviewEmail,
  dismissEmailFromReview,
  EmailAssociationError,
  type EmailAssociationOperation,
} from "./email-association.service.js";
import {
  asNullableString,
  asRecord,
  getGmailUrl,
  isApplicationMatchOutcome,
  isEmailCategory,
  toIsoString,
} from "./email-api-fields.js";
import { sendError, sendSuccess } from "../../utils/api-response.js";
import { sanitizeEmailText } from "../gmail/gmail.parser.js";

const uuidSchema = z.string().uuid();
const associationRequestSchema = z.object({
  applicationId: uuidSchema,
}).strict();
const createApplicationRequestSchema = z.object({
  companyName: z.string().trim().min(1).max(255).optional(),
  jobTitle: z.string().trim().min(1).max(255).optional(),
}).strict();
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const listEmailsForReview: RequestHandler = async (req, res) => {
  if (!req.authUserId) {
    sendError(res, 401, "Authentication required");
    return;
  }
  const parsedPagination = paginationSchema.safeParse(req.query);
  if (!parsedPagination.success) {
    sendError(res, 400, "Invalid review pagination");
    return;
  }

  const { page, limit } = parsedPagination.data;
  try {
    const [emails, total] = await AppDataSource.getRepository(Email)
      .createQueryBuilder("email")
      .select([
        "email.id",
        "email.subject",
        "email.fromEmail",
        "email.receivedAt",
        "email.extractedData",
        "email.gmailMessageId",
      ])
      .where("email.user_id = :userId", { userId: req.authUserId })
      .andWhere("email.application_id IS NULL")
      .andWhere("email.processing_status = :processingStatus", {
        processingStatus: "PROCESSED",
      })
      .andWhere("email.extractedData IS NOT NULL")
      .andWhere("email.extractedData ->> 'isJobRelated' = :jobRelated", {
        jobRelated: "true",
      })
      .andWhere(
        "(email.extractedData ->> 'applicationMatchOutcome' IS NULL OR email.extractedData ->> 'applicationMatchOutcome' = :reviewOutcome)",
        { reviewOutcome: "NEEDS_REVIEW" },
      )
      .orderBy("email.receivedAt", "DESC")
      .addOrderBy("email.id", "ASC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    sendSuccess(res, 200, "Review emails loaded", {
      emails: emails.map((email) => {
        const extraction = asRecord(email.extractedData);
        const category = isEmailCategory(extraction?.category)
          ? extraction.category
          : null;
        const outcome = extraction?.applicationMatchOutcome;
        return {
          emailId: email.id,
          gmailMessageId: email.gmailMessageId,
          gmailUrl: getGmailUrl(email.gmailMessageId),
          subject: email.subject,
          senderName: asNullableString(extraction?.senderName),
          senderOrganization: asNullableString(extraction?.senderOrganization),
          senderEmail: email.fromEmail,
          receivedAt: toIsoString(email.receivedAt),
          companyName: asNullableString(extraction?.companyName),
          jobTitle: asNullableString(extraction?.jobTitle),
          eventType: asNullableString(extraction?.eventType),
          category,
          summary: asNullableString(extraction?.summary),
          reviewOutcome: isApplicationMatchOutcome(outcome)
            ? outcome
            : "NEEDS_REVIEW",
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Email review list lookup failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    sendError(res, 500, "Unable to load emails for review");
  }
};

export const getEmailDetails: RequestHandler = async (req, res) => {
  const parsedId = uuidSchema.safeParse(req.params.id);
  if (!parsedId.success || !req.authUserId) {
    sendError(res, 404, "Email not found");
    return;
  }

  try {
    const email = await AppDataSource.getRepository(Email).findOne({
      where: { id: parsedId.data, userId: req.authUserId },
      select: {
        id: true,
        fromEmail: true,
        toEmail: true,
        subject: true,
        bodyText: true,
        receivedAt: true,
        gmailMessageId: true,
      },
    });
    if (!email) {
      sendError(res, 404, "Email not found");
      return;
    }

    sendSuccess(res, 200, "Email loaded", {
      email: {
        id: email.id,
        gmailMessageId: email.gmailMessageId,
        gmailUrl: getGmailUrl(email.gmailMessageId),
        fromEmail: email.fromEmail,
        toEmail: email.toEmail,
        subject: email.subject,
        bodyText: email.bodyText ? sanitizeEmailText(email.bodyText) : email.bodyText,
        receivedAt: toIsoString(email.receivedAt),
      },
    });
  } catch (error) {
    console.error(
      "Email detail lookup failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    sendError(res, 500, "Unable to load email");
  }
};

export const createApplicationFromEmail: RequestHandler = async (req, res) => {
  const parsedEmailId = uuidSchema.safeParse(req.params.id);
  if (!parsedEmailId.success) {
    sendError(res, 400, "Invalid email ID");
    return;
  }
  const parsedBody = createApplicationRequestSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    sendError(res, 400, "Invalid application fields");
    return;
  }
  if (!req.authUserId) {
    sendError(res, 401, "Authentication required");
    return;
  }

  try {
    const result = await createApplicationFromReviewEmail(
      req.authUserId,
      parsedEmailId.data,
      parsedBody.data,
    );
    sendSuccess(res, 201, "Application created from email", result);
  } catch (error) {
    if (error instanceof EmailAssociationError) {
      sendError(res, error.statusCode, error.message);
      return;
    }
    console.error(
      "Application creation from email failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    sendError(res, 500, "Unable to create application from email");
  }
};

export const dismissReviewEmail: RequestHandler = async (req, res) => {
  const parsedEmailId = uuidSchema.safeParse(req.params.id);
  if (!parsedEmailId.success) {
    sendError(res, 400, "Invalid email ID");
    return;
  }
  if (!req.authUserId) {
    sendError(res, 401, "Authentication required");
    return;
  }

  try {
    const result = await dismissEmailFromReview(
      req.authUserId,
      parsedEmailId.data,
    );
    sendSuccess(res, 200, "Email dismissed from review", result);
  } catch (error) {
    if (error instanceof EmailAssociationError) {
      sendError(res, error.statusCode, error.message);
      return;
    }
    console.error(
      "Email review dismissal failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    sendError(res, 500, "Unable to dismiss email from review");
  }
};

const updateEmailAssociation = (
  operation: EmailAssociationOperation,
): RequestHandler => async (req, res) => {
  const parsedEmailId = uuidSchema.safeParse(req.params.id);
  if (!parsedEmailId.success) {
    sendError(res, 400, "Invalid email ID");
    return;
  }

  let targetApplicationId: string | undefined;
  if (operation !== "unassociate") {
    const parsedBody = associationRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      sendError(res, 400, "A valid applicationId is required");
      return;
    }
    targetApplicationId = parsedBody.data.applicationId;
  }
  if (!req.authUserId) {
    sendError(res, 401, "Authentication required");
    return;
  }

  try {
    const result = await changeEmailAssociation(
      req.authUserId,
      parsedEmailId.data,
      operation,
      targetApplicationId,
    );
    sendSuccess(res, 200, "Email association updated", result);
  } catch (error) {
    if (error instanceof EmailAssociationError) {
      sendError(res, error.statusCode, error.message);
      return;
    }
    console.error(
      `Email ${operation} failed:`,
      error instanceof Error ? error.name : "UnknownError",
    );
    sendError(res, 500, "Unable to update email association");
  }
};

export const associateEmail: RequestHandler =
  updateEmailAssociation("associate");

export const reassignEmail: RequestHandler =
  updateEmailAssociation("reassign");

export const unassociateEmail: RequestHandler =
  updateEmailAssociation("unassociate");
