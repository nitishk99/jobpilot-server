import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mock = {
  getRepository: jest.fn(),
  transaction: jest.fn(),
  findEmail: jest.fn(),
  findEmails: jest.fn(),
  saveEmail: jest.fn(),
  findApplication: jest.fn(),
  findApplications: jest.fn(),
  saveApplication: jest.fn(),
  createApplication: jest.fn(),
  findSessionUserId: jest.fn(),
};

jest.mock("../../../src/config/db.js", () => ({
  AppDataSource: {
    getRepository: (...args) => mock.getRepository(...args),
    transaction: (...args) => mock.transaction(...args),
  },
}));

jest.mock("../../../src/modules/auth/auth.session.js", () => ({
  findSessionUserId: (...args) => mock.findSessionUserId(...args),
  SESSION_COOKIE_NAME: "session",
}));

import { Application } from "../../../src/database/entities/Application.js";
import { Email } from "../../../src/database/entities/Email.js";
import { CLIENT_ORIGIN } from "../../../src/config/client-origin.js";
import emailsRouter from "../../../src/modules/emails/emails.routes.js";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/emails", emailsRouter);

const emailId = "90b4d87a-12f1-46b4-943a-54b68aa45d29";
const firstApplicationId = "8f9ad2a4-4fa2-4c79-a718-7a1fcf5e2620";
const secondApplicationId = "10376e9b-a271-40e6-9a9c-074a035d7fc3";
const clientOrigin = CLIENT_ORIGIN;

const makeApplication = (
  id: string,
  userId = "user-1",
  status: Application["status"] = "APPLIED",
): Application =>
  Object.assign(new Application(), {
    id,
    userId,
    companyName: "ANC Technologies",
    jobTitle: "Java Developer",
    status,
    source: "Gmail",
    appliedAt: new Date("2026-11-12T10:00:00.000Z"),
    createdAt: new Date("2026-11-12T10:00:00.000Z"),
    updatedAt: new Date("2026-11-12T10:00:00.000Z"),
  });

const makeEmail = (
  id: string,
  applicationId: string | null,
  extractedData: Record<string, unknown> | null,
  options: {
    userId?: string;
    processingStatus?: Email["processingStatus"];
    associationSource?: Email["associationSource"];
    receivedAt?: string;
  } = {},
): Email =>
  Object.assign(new Email(), {
    id,
    userId: options.userId ?? "user-1",
    applicationId,
    associationSource: options.associationSource ?? "AUTO",
    gmailMessageId: `gmail-${id}`,
    gmailThreadId: `thread-${id}`,
    fromEmail: "recruiter@anc.example",
    toEmail: "candidate@example.com",
    subject: `Message ${id}`,
    bodyText: `Body for ${id}`,
    extractedData,
    processingStatus: options.processingStatus ?? "PROCESSED",
    processedAt: new Date("2026-11-12T10:00:00.000Z"),
    receivedAt: new Date(options.receivedAt ?? "2026-11-12T10:00:00.000Z"),
    createdAt: new Date("2026-11-12T10:00:00.000Z"),
  });

const jobExtraction = (
  eventType = "INTERVIEW_SCHEDULED",
): Record<string, unknown> => ({
  isJobRelated: true,
  category: "INTERVIEW",
  companyName: "ANC Technologies",
  jobTitle: "Java Developer",
  eventType,
  eventDate: "2026-11-15T10:00:00.000Z",
  summary: "Interview invitation",
  applicationMatchOutcome: "NEEDS_REVIEW",
});

const authCookie = (token = "user-1-token") => `session=${token}`;

let emails: Email[];
let applications: Application[];
let reviewBuilder: ReturnType<typeof createReviewBuilder>;

const createReviewBuilder = () => {
  let userId = "";
  let offset = 0;
  let limit = 25;
  let builder: {
    select: ReturnType<typeof jest.fn>;
    where: ReturnType<typeof jest.fn>;
    andWhere: ReturnType<typeof jest.fn>;
    orderBy: ReturnType<typeof jest.fn>;
    addOrderBy: ReturnType<typeof jest.fn>;
    skip: ReturnType<typeof jest.fn>;
    take: ReturnType<typeof jest.fn>;
    getManyAndCount: ReturnType<typeof jest.fn>;
  };
  builder = {
    select: jest.fn(() => builder),
    where: jest.fn((_condition: string, parameters: { userId: string }) => {
      userId = parameters.userId;
      return builder;
    }),
    andWhere: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    addOrderBy: jest.fn(() => builder),
    skip: jest.fn((value: number) => {
      offset = value;
      return builder;
    }),
    take: jest.fn((value: number) => {
      limit = value;
      return builder;
    }),
    getManyAndCount: jest.fn(async () => {
      const matches = emails
        .filter(
          (email) =>
            email.userId === userId &&
            email.applicationId === null &&
            email.processingStatus === "PROCESSED" &&
            email.extractedData?.isJobRelated === true,
        )
        .sort(
          (left, right) =>
            right.receivedAt.getTime() - left.receivedAt.getTime(),
        );
      return [matches.slice(offset, offset + limit), matches.length] as const;
    }),
  };
  return builder;
};

const emailRepository = {
  findOne: mock.findEmail,
  find: mock.findEmails,
  save: mock.saveEmail,
  createQueryBuilder: jest.fn(() => {
    reviewBuilder = createReviewBuilder();
    return reviewBuilder;
  }),
};

const applicationRepository = {
  findOne: mock.findApplication,
  find: mock.findApplications,
  create: mock.createApplication,
  save: mock.saveApplication,
};

const manager = {
  getRepository: mock.getRepository,
};

describe("email manual review and association APIs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emails = [];
    applications = [];

    mock.findSessionUserId.mockImplementation(
      async (token: string) =>
        token === "user-2-token" ? "user-2" : "user-1",
    );
    mock.getRepository.mockImplementation((entity: unknown) =>
      entity === Email ? emailRepository : applicationRepository,
    );
    mock.transaction.mockImplementation(
      async (
        callback: (entityManager: typeof manager) => Promise<unknown>,
      ) => callback(manager),
    );
    mock.findEmail.mockImplementation(
      async ({ where }: { where: { id: string; userId: string } }) =>
        emails.find(
          (email) => email.id === where.id && email.userId === where.userId,
        ) ?? null,
    );
    mock.findEmails.mockImplementation(
      async ({
        where,
      }: {
        where: { applicationId: string; userId: string };
      }) =>
        emails.filter(
          (email) =>
            email.applicationId === where.applicationId &&
            email.userId === where.userId,
        ),
    );
    mock.saveEmail.mockImplementation(async (email: Email) => email);
    mock.findApplication.mockImplementation(
      async ({ where }: { where: { id: string; userId: string } }) =>
        applications.find(
          (application) =>
            application.id === where.id &&
            application.userId === where.userId,
        ) ?? null,
    );
    mock.findApplications.mockImplementation(
      async ({ where }: { where: { id: string; userId: string } }) =>
        applications.filter(
          (application) =>
            application.id === where.id &&
            application.userId === where.userId,
        ),
    );
    mock.saveApplication.mockImplementation(
      async (application: Application) => application,
    );
    mock.createApplication.mockImplementation(
      (values: Partial<Application>) => Object.assign(new Application(), values),
    );
  });

  it("lists only processed, unassigned job-related emails for the signed-in user", async () => {
    emails = [
      makeEmail(emailId, null, jobExtraction()),
      makeEmail(
        "unrelated",
        null,
        { isJobRelated: false, category: "OTHER" },
      ),
      makeEmail("associated", firstApplicationId, jobExtraction()),
      makeEmail("pending", null, jobExtraction(), {
        processingStatus: "PENDING",
      }),
      makeEmail("processing", null, jobExtraction(), {
        processingStatus: "PROCESSING",
      }),
      makeEmail("failed", null, jobExtraction(), {
        processingStatus: "FAILED",
      }),
      makeEmail("other-user", null, jobExtraction(), { userId: "user-2" }),
    ];

    const response = await request(app)
      .get("/api/emails/review")
      .set("Cookie", authCookie());

    expect(response.status).toBe(200);
    expect(response.body.data.emails).toHaveLength(1);
    expect(response.body.data.emails[0]).toMatchObject({
      emailId,
      gmailMessageId: `gmail-${emailId}`,
      gmailUrl: `https://mail.google.com/mail/u/0/#inbox/gmail-${emailId}`,
      senderName: null,
      senderOrganization: null,
      senderEmail: "recruiter@anc.example",
      companyName: "ANC Technologies",
      jobTitle: "Java Developer",
      eventType: "INTERVIEW_SCHEDULED",
      reviewOutcome: "NEEDS_REVIEW",
    });
    expect(response.body.data.pagination).toEqual({
      page: 1,
      limit: 25,
      total: 1,
      totalPages: 1,
    });
    expect(reviewBuilder.where).toHaveBeenCalledWith(
      "email.user_id = :userId",
      { userId: "user-1" },
    );
    expect(reviewBuilder.andWhere).toHaveBeenCalledWith(
      "email.application_id IS NULL",
    );
    expect(reviewBuilder.andWhere).toHaveBeenCalledWith(
      "email.processing_status = :processingStatus",
      { processingStatus: "PROCESSED" },
    );
    expect(reviewBuilder.andWhere).toHaveBeenCalledWith(
      "email.extractedData ->> 'isJobRelated' = :jobRelated",
      { jobRelated: "true" },
    );
    expect(reviewBuilder.andWhere).toHaveBeenCalledWith(
      "(email.extractedData ->> 'applicationMatchOutcome' IS NULL OR email.extractedData ->> 'applicationMatchOutcome' = :reviewOutcome)",
      { reviewOutcome: "NEEDS_REVIEW" },
    );
  });

  it("validates pagination parameters", async () => {
    const response = await request(app)
      .get("/api/emails/review?limit=1000")
      .set("Cookie", authCookie());

    expect(response.status).toBe(400);
    expect(emailRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("associates an unassigned email with an owned application and recalculates status", async () => {
    applications = [makeApplication(firstApplicationId)];
    emails = [makeEmail(emailId, null, jobExtraction())];

    const response = await request(app)
      .patch(`/api/emails/${emailId}/associate`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({ applicationId: firstApplicationId });

    expect(response.status).toBe(200);
    expect(mock.findEmail).toHaveBeenCalledWith({
      where: { id: emailId, userId: "user-1" },
      lock: { mode: "pessimistic_write" },
    });
    expect(emails[0]).toMatchObject({
      applicationId: firstApplicationId,
      associationSource: "MANUAL",
      extractedData: { applicationMatchOutcome: "MATCHED" },
    });
    expect(response.body.data).toMatchObject({
      emailId,
      applicationId: firstApplicationId,
      associationSource: "MANUAL",
      applications: [
        {
          id: firstApplicationId,
          status: "INTERVIEW",
          totalEmailCount: 1,
          lastActivityAt: "2026-11-12T10:00:00.000Z",
        },
      ],
    });
  });

  it("creates an application from a review email and associates it atomically", async () => {
    emails = [makeEmail(emailId, null, jobExtraction())];
    mock.saveApplication.mockImplementation(async (application: Application) => {
      if (!application.id) {
        application.id = firstApplicationId;
      }
      return application;
    });

    const response = await request(app)
      .post(`/api/emails/${emailId}/create-application`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({});

    expect(response.status).toBe(201);
    expect(mock.createApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        source: "Manual review",
      }),
    );
    expect(emails[0]).toMatchObject({
      applicationId: firstApplicationId,
      associationSource: "MANUAL",
      extractedData: {
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        applicationMatchOutcome: "NEW_APPLICATION",
      },
    });
    expect(response.body.data.application).toMatchObject({
      id: firstApplicationId,
      companyName: "ANC Technologies",
      jobTitle: "Java Developer",
      status: "INTERVIEW",
      totalEmailCount: 1,
    });
  });

  it("creates an application when the request only contains the email ID", async () => {
    emails = [makeEmail(emailId, null, jobExtraction())];
    mock.saveApplication.mockImplementation(async (application: Application) => {
      application.id = firstApplicationId;
      return application;
    });

    const response = await request(app)
      .post(`/api/emails/${emailId}/create-application`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie());

    expect(response.status).toBe(201);
  });

  it("uses user-supplied fields when extraction data is incomplete", async () => {
    emails = [
      makeEmail(emailId, null, {
        ...jobExtraction(),
        companyName: null,
        jobTitle: null,
      }),
    ];
    mock.saveApplication.mockImplementation(async (application: Application) => {
      application.id = firstApplicationId;
      return application;
    });

    const response = await request(app)
      .post(`/api/emails/${emailId}/create-application`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({
        companyName: "Corrected Company",
        jobTitle: "Platform Engineer",
      });

    expect(response.status).toBe(201);
    expect(response.body.data.application).toMatchObject({
      companyName: "Corrected Company",
      jobTitle: "Platform Engineer",
    });
  });

  it("rejects application creation from an already-associated email", async () => {
    emails = [makeEmail(emailId, firstApplicationId, jobExtraction())];

    const response = await request(app)
      .post(`/api/emails/${emailId}/create-application`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({});

    expect(response.status).toBe(409);
    expect(mock.createApplication).not.toHaveBeenCalled();
  });

  it("rejects placeholder company and job-title values", async () => {
    emails = [
      makeEmail(emailId, null, {
        ...jobExtraction(),
        companyName: "unknown",
        jobTitle: "not specified",
      }),
    ];

    const response = await request(app)
      .post(`/api/emails/${emailId}/create-application`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({});

    expect(response.status).toBe(409);
    expect(mock.createApplication).not.toHaveBeenCalled();
  });

  it("dismisses an irrelevant review email without deleting stored email data", async () => {
    const email = makeEmail(emailId, null, jobExtraction());
    emails = [email];

    const response = await request(app)
      .delete(`/api/emails/${emailId}/review`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      message: "Email dismissed from review",
      data: {
        emailId,
        dismissed: true,
      },
      error: null,
    });
    expect(email).toMatchObject({
      applicationId: null,
      associationSource: "MANUAL",
      bodyText: `Body for ${emailId}`,
      extractedData: {
        isJobRelated: false,
        category: "OTHER",
        eventType: "OTHER",
        applicationMatchOutcome: "NEEDS_REVIEW",
      },
    });

    const reviewResponse = await request(app)
      .get("/api/emails/review")
      .set("Cookie", authCookie());
    expect(reviewResponse.body.data.emails).toHaveLength(0);
  });

  it("rejects dismissing an email that is not in review", async () => {
    emails = [makeEmail(emailId, firstApplicationId, jobExtraction())];

    const response = await request(app)
      .delete(`/api/emails/${emailId}/review`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie());

    expect(response.status).toBe(409);
  });

  it("rejects association with another user's application", async () => {
    applications = [makeApplication(firstApplicationId, "user-2")];
    emails = [makeEmail(emailId, null, jobExtraction())];

    const response = await request(app)
      .patch(`/api/emails/${emailId}/associate`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({ applicationId: firstApplicationId });

    expect(response.status).toBe(404);
    expect(emails[0].applicationId).toBeNull();
    expect(emails[0].associationSource).toBe("AUTO");
  });

  it("does not allow accessing or associating another user's email", async () => {
    emails = [
      makeEmail(emailId, null, jobExtraction(), { userId: "user-2" }),
    ];
    applications = [makeApplication(firstApplicationId)];

    const response = await request(app)
      .patch(`/api/emails/${emailId}/associate`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({ applicationId: firstApplicationId });

    expect(response.status).toBe(404);
    expect(emails[0].applicationId).toBeNull();
  });

  it("requires reassign instead of associating an already-associated email", async () => {
    applications = [makeApplication(firstApplicationId)];
    emails = [makeEmail(emailId, firstApplicationId, jobExtraction())];

    const response = await request(app)
      .patch(`/api/emails/${emailId}/associate`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({ applicationId: firstApplicationId });

    expect(response.status).toBe(409);
    expect(emails[0].applicationId).toBe(firstApplicationId);
  });

  it("reassigns to another owned application and recalculates both applications", async () => {
    applications = [
      makeApplication(firstApplicationId, "user-1", "INTERVIEW"),
      makeApplication(secondApplicationId),
    ];
    const email = makeEmail(emailId, firstApplicationId, jobExtraction());
    const earlierApplicationEmail = makeEmail(
      "e3ec7c42-0e61-4984-8be8-06640889e587",
      firstApplicationId,
      {
        ...jobExtraction("APPLICATION_RECEIVED"),
        eventDate: "2026-11-10T10:00:00.000Z",
      },
    );
    emails = [email, earlierApplicationEmail];

    const response = await request(app)
      .patch(`/api/emails/${emailId}/reassign`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({ applicationId: secondApplicationId });

    expect(response.status).toBe(200);
    expect(email.applicationId).toBe(secondApplicationId);
    expect(email.associationSource).toBe("MANUAL");
    expect(response.body.data.applications).toEqual([
      {
        id: secondApplicationId,
        status: "INTERVIEW",
        totalEmailCount: 1,
        lastActivityAt: "2026-11-12T10:00:00.000Z",
      },
      {
        id: firstApplicationId,
        status: "APPLIED",
        totalEmailCount: 1,
        lastActivityAt: "2026-11-12T10:00:00.000Z",
      },
    ]);
    expect(mock.findApplication).toHaveBeenCalledWith({
      where: { id: firstApplicationId, userId: "user-1" },
      lock: { mode: "pessimistic_write" },
    });
    expect(mock.findApplication).toHaveBeenCalledWith({
      where: { id: secondApplicationId, userId: "user-1" },
      lock: { mode: "pessimistic_write" },
    });
  });

  it("rejects reassigning to the current application", async () => {
    applications = [makeApplication(firstApplicationId)];
    emails = [makeEmail(emailId, firstApplicationId, jobExtraction())];

    const response = await request(app)
      .patch(`/api/emails/${emailId}/reassign`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({ applicationId: firstApplicationId });

    expect(response.status).toBe(409);
  });

  it("unassociates without deleting the email and makes it reviewable again", async () => {
    applications = [makeApplication(firstApplicationId)];
    const email = makeEmail(emailId, firstApplicationId, jobExtraction());
    emails = [email];

    const response = await request(app)
      .patch(`/api/emails/${emailId}/unassociate`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie());

    expect(response.status).toBe(200);
    expect(email).toMatchObject({
      applicationId: null,
      associationSource: "MANUAL",
      bodyText: `Body for ${emailId}`,
      extractedData: {
        isJobRelated: true,
        applicationMatchOutcome: "NEEDS_REVIEW",
      },
    });
    expect(response.body.data.applications[0]).toMatchObject({
      id: firstApplicationId,
      totalEmailCount: 0,
      lastActivityAt: null,
    });

    const reviewResponse = await request(app)
      .get("/api/emails/review")
      .set("Cookie", authCookie());
    expect(reviewResponse.body.data.emails).toHaveLength(1);
    expect(reviewResponse.body.data.emails[0].emailId).toBe(emailId);
  });

  it("returns validation errors for malformed IDs and request bodies", async () => {
    const invalidEmailId = await request(app)
      .patch("/api/emails/not-a-uuid/unassociate")
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie());
    const missingApplicationId = await request(app)
      .patch(`/api/emails/${emailId}/associate`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({});
    const extraFields = await request(app)
      .patch(`/api/emails/${emailId}/reassign`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({ applicationId: firstApplicationId, extra: true });
    const invalidApplicationId = await request(app)
      .patch(`/api/emails/${emailId}/associate`)
      .set("Origin", clientOrigin)
      .set("Cookie", authCookie())
      .send({ applicationId: "not-a-uuid" });

    expect(invalidEmailId.status).toBe(400);
    expect(missingApplicationId.status).toBe(400);
    expect(extraFields.status).toBe(400);
    expect(invalidApplicationId.status).toBe(400);
  });
});
