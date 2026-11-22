import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mock = {
  getRepository: jest.fn(),
  findApplication: jest.fn(),
  findApplications: jest.fn(),
  findEmails: jest.fn(),
  findEmail: jest.fn(),
  findSessionUserId: jest.fn(),
};

jest.mock("../../../src/config/db.js", () => ({
  AppDataSource: {
    getRepository: (...args) => mock.getRepository(...args),
  },
}));

jest.mock("../../../src/modules/auth/auth.session.js", () => ({
  findSessionUserId: (...args) => mock.findSessionUserId(...args),
  SESSION_COOKIE_NAME: "session",
}));

import { Application } from "../../../src/database/entities/Application.js";
import { Email } from "../../../src/database/entities/Email.js";
import applicationsRouter from "../../../src/modules/applications/applications.routes.js";
import emailsRouter from "../../../src/modules/emails/emails.routes.js";

const app = express();
app.use(cookieParser());
app.use("/api/applications", applicationsRouter);
app.use("/api/emails", emailsRouter);

const applicationId = "9bc1e19a-a64a-4a7c-938a-e32d3e1a6534";
const emailId = "b3f53c70-471a-49ab-a7c4-f2f4dc5ec90d";

const makeApplication = (): Application =>
  Object.assign(new Application(), {
    id: applicationId,
    userId: "user-1",
    companyName: "ANC Technologies",
    jobTitle: "Java Developer",
    status: "APPLIED" as const,
    source: "Gmail",
    appliedAt: new Date("2026-11-12T10:00:00.000Z"),
    createdAt: new Date("2026-11-12T10:00:00.000Z"),
  });

const makeEmail = (
  id: string,
  receivedAt: string,
  extractedData: Record<string, unknown> | null,
  overrides: Partial<Email> = {},
): Email =>
  Object.assign(new Email(), {
    id,
    userId: "user-1",
    applicationId,
    gmailMessageId: `gmail-${id}`,
    gmailThreadId: `thread-${id}`,
    fromEmail: "hr@anc.example",
    toEmail: "candidate@example.com",
    subject: `Message ${id}`,
    bodyText: `Body for ${id}`,
    extractedData,
    processingStatus: "PROCESSED",
    receivedAt: new Date(receivedAt),
    createdAt: new Date(receivedAt),
    ...overrides,
  });

let emails: Email[];
let application: Application;
let applications: Application[];

const authenticate = (token = "user-1-token") =>
  `session=${token}`;

describe("application timeline and email detail APIs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    application = makeApplication();
    applications = [application];
    emails = [];

    mock.findSessionUserId.mockImplementation(
      async (token: string) =>
        token === "user-2-token" ? "user-2" : "user-1",
    );
    mock.findApplication.mockImplementation(
      async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === application.id && where.userId === application.userId
          ? application
          : null,
    );
    mock.findApplications.mockImplementation(
      async ({ where }: { where: { userId: string } }) =>
        applications
          .filter(({ userId }) => userId === where.userId)
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime() ||
              left.id.localeCompare(right.id),
          ),
    );
    mock.findEmails.mockImplementation(
      async ({
        where,
      }: {
        where: { applicationId: string | object; userId: string };
      }) =>
        emails.filter(
          (email) =>
            email.userId === where.userId &&
            (typeof where.applicationId !== "string" ||
              email.applicationId === where.applicationId),
        ),
    );
    mock.findEmail.mockImplementation(
      async ({ where }: { where: { id: string; userId: string } }) =>
        emails.find(
          (email) => email.id === where.id && email.userId === where.userId,
        ) ?? null,
    );
    mock.getRepository.mockImplementation((entity: unknown) =>
      entity === Application
        ? {
            findOne: mock.findApplication,
            find: mock.findApplications,
          }
        : {
            find: mock.findEmails,
            findOne: mock.findEmail,
          },
    );
  });

  it("lists owned applications with paginated activity summaries", async () => {
    const secondApplication = Object.assign(makeApplication(), {
      id: "c2d7d0f0-56c5-41b6-9aa4-024c78ab9d68",
      companyName: "Example Corp",
      jobTitle: "Product Designer",
      status: "APPLIED" as const,
      appliedAt: null,
      createdAt: new Date("2026-11-18T10:00:00.000Z"),
    });
    const otherUsersApplication = Object.assign(makeApplication(), {
      id: "d3d5da5c-61c8-4a43-92de-a925a29aa3f1",
      userId: "user-2",
    });
    applications = [application, secondApplication, otherUsersApplication];
    emails = [
      makeEmail("application-list-email", "2026-11-20T10:00:00.000Z", {
        isJobRelated: true,
        category: "INTERVIEW",
        eventType: "INTERVIEW_SCHEDULED",
        eventDate: "2026-11-19T10:00:00.000Z",
      }),
      makeEmail(
        "other-user-email",
        "2026-11-21T10:00:00.000Z",
        {
          isJobRelated: true,
          category: "OFFER",
          eventType: "OFFER_RECEIVED",
          eventDate: "2026-11-21T10:00:00.000Z",
        },
        { userId: "user-2", applicationId: otherUsersApplication.id },
      ),
    ];

    const response = await request(app)
      .get("/api/applications?page=1&limit=2")
      .set("Cookie", authenticate());

    expect(response.status).toBe(200);
    expect(response.body.data.applications).toEqual([
      {
        id: secondApplication.id,
        companyName: "Example Corp",
        jobTitle: "Product Designer",
        status: "APPLIED",
        appliedAt: null,
        lastActivityAt: null,
        totalEmailCount: 0,
      },
      {
        id: application.id,
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        status: "INTERVIEW",
        appliedAt: "2026-11-12T10:00:00.000Z",
        lastActivityAt: "2026-11-20T10:00:00.000Z",
        totalEmailCount: 1,
      },
    ]);
    expect(response.body.data.pagination).toEqual({
      page: 1,
      limit: 2,
      total: 2,
      totalPages: 1,
    });
    expect(response.body.data.stats).toEqual({
      total: 2,
      inProgress: 2,
      interviewing: 1,
      offers: 0,
      newlyApplied: 1,
    });
    expect(mock.findApplications).toHaveBeenCalledWith(
      {
        where: { userId: "user-1" },
      },
    );
    expect(mock.findEmails).toHaveBeenCalledTimes(1);
    expect(mock.findEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1" }),
      }),
    );

    const nextPage = await request(app)
      .get("/api/applications?page=2&limit=1")
      .set("Cookie", authenticate());
    expect(nextPage.status).toBe(200);
    expect(nextPage.body.data.applications.map(({ id }: { id: string }) => id))
      .toEqual([application.id]);
  });

  it("rejects invalid application pagination", async () => {
    const response = await request(app)
      .get("/api/applications?page=0")
      .set("Cookie", authenticate());

    expect(response.status).toBe(400);
    expect(mock.findApplications).not.toHaveBeenCalled();
  });

  it("searches company and role while keeping pipeline stats global", async () => {
    const matchingApplication = Object.assign(makeApplication(), {
      id: "c2d7d0f0-56c5-41b6-9aa4-024c78ab9d68",
      companyName: "Example Corp",
      jobTitle: "Product Designer",
      createdAt: new Date("2026-11-18T10:00:00.000Z"),
    });
    applications = [application, matchingApplication];

    const response = await request(app)
      .get("/api/applications?search=product")
      .set("Cookie", authenticate());

    expect(response.status).toBe(200);
    expect(response.body.data.applications).toHaveLength(1);
    expect(response.body.data.applications[0].id).toBe(matchingApplication.id);
    expect(response.body.data.pagination.total).toBe(1);
    expect(response.body.data.stats.total).toBe(2);
  });

  it("sorts by last activity and keeps applications without activity last", async () => {
    const activeApplication = Object.assign(makeApplication(), {
      id: "c2d7d0f0-56c5-41b6-9aa4-024c78ab9d68",
      companyName: "Example Corp",
      jobTitle: "Product Designer",
      createdAt: new Date("2026-11-18T10:00:00.000Z"),
    });
    applications = [application, activeApplication];
    emails = [
      makeEmail("activity", "2026-11-20T10:00:00.000Z", {
        isJobRelated: true,
        category: "APPLICATION",
        eventType: "APPLICATION_RECEIVED",
      }, { applicationId: activeApplication.id }),
    ];

    const response = await request(app)
      .get("/api/applications?sortBy=lastActivityAt&order=desc")
      .set("Cookie", authenticate());

    expect(response.body.data.applications.map(
      ({ id }: { id: string }) => id,
    )).toEqual([activeApplication.id, application.id]);
  });

  it.each([
    "?sortBy=status",
    "?order=sideways",
    `?search=${"x".repeat(201)}`,
  ])("rejects unsupported list query %s", async (query) => {
    const response = await request(app)
      .get(`/api/applications${query}`)
      .set("Cookie", authenticate());

    expect(response.status).toBe(400);
    expect(mock.findApplications).not.toHaveBeenCalled();
  });

  it("returns only associated emails sorted by event date with safe fallbacks", async () => {
    emails = [
      makeEmail("event-later", "2026-11-10T10:00:00.000Z", {
        isJobRelated: true,
        category: "HR_COMMUNICATION",
        eventType: "HR_UPDATE",
        eventDate: "2026-11-20T10:00:00.000Z",
        summary: "Recruiter update",
        senderName: "Alex",
        senderOrganization: "ANC Technologies",
        meetingLink: null,
      }),
      makeEmail("received-fallback", "2026-11-15T10:00:00.000Z", {
        isJobRelated: true,
        category: "APPLICATION",
        eventType: "APPLICATION_RECEIVED",
        eventDate: null,
      }),
      makeEmail("invalid-date", "2026-11-18T10:00:00.000Z", {
        isJobRelated: true,
        category: "OFFER",
        eventType: "OFFER_RECEIVED",
        eventDate: "not-a-date",
      }),
      makeEmail("event-earlier", "2026-11-16T10:00:00.000Z", {
        isJobRelated: true,
        category: "INTERVIEW",
        eventType: "INTERVIEW_SCHEDULED",
        eventDate: "2026-11-12T10:00:00.000Z",
        meetingLink: "https://meet.example/interview",
      }),
      makeEmail("unassociated", "2026-11-19T10:00:00.000Z", null, {
        applicationId: null,
      }),
      makeEmail("other-users-email", "2026-11-19T10:00:00.000Z", null, {
        userId: "user-2",
      }),
    ];

    const response = await request(app)
      .get(`/api/applications/${applicationId}/timeline`)
      .set("Cookie", authenticate());

    expect(response.status).toBe(200);
    expect(mock.findEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId, userId: "user-1" },
      }),
    );
    expect(response.body.data.application).toEqual({
      id: applicationId,
      companyName: "ANC Technologies",
      jobTitle: "Java Developer",
      status: "OFFER",
      appliedAt: "2026-11-12T10:00:00.000Z",
      lastActivityAt: "2026-11-18T10:00:00.000Z",
      totalEmailCount: 4,
    });
    expect(response.body.data.timeline.map((item: { emailId: string }) =>
      item.emailId,
    )).toEqual([
      "event-earlier",
      "received-fallback",
      "invalid-date",
      "event-later",
    ]);
    expect(response.body.data.timeline[0]).toMatchObject({
      gmailMessageId: "gmail-event-earlier",
      gmailUrl: "https://mail.google.com/mail/u/0/#inbox/gmail-event-earlier",
      eventDate: "2026-11-12T10:00:00.000Z",
      emailReceivedAt: "2026-11-16T10:00:00.000Z",
      originalEmailAvailable: true,
    });
    expect(response.body.data.timeline[2].eventDate).toBe("not-a-date");
    expect(response.body.data.timeline[3]).toMatchObject({
      category: "HR_COMMUNICATION",
      summary: "Recruiter update",
      senderName: "Alex",
      senderOrganization: "ANC Technologies",
      meetingLink: null,
    });
  });

  it("returns an empty timeline and null activity when the application has no emails", async () => {
    const response = await request(app)
      .get(`/api/applications/${applicationId}/timeline`)
      .set("Cookie", authenticate());

    expect(response.status).toBe(200);
    expect(response.body.data.timeline).toEqual([]);
    expect(response.body.data.application).toMatchObject({
      totalEmailCount: 0,
      lastActivityAt: null,
      status: "APPLIED",
    });
  });

  it("returns not found for an application owned by another user", async () => {
    const response = await request(app)
      .get(`/api/applications/${applicationId}/timeline`)
      .set("Cookie", authenticate("user-2-token"));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      message: "Application not found",
      data: null,
      error: "Application not found",
    });
    expect(mock.findApplication).toHaveBeenCalledWith({
      where: { id: applicationId, userId: "user-2" },
    });
    expect(mock.findEmails).not.toHaveBeenCalled();
  });

  it("does not let document or HR events override status, while offer and rejection milestones do", async () => {
    application.status = "INTERVIEW";
    emails = [
      makeEmail("documents", "2026-11-15T10:00:00.000Z", {
        isJobRelated: true,
        category: "ASSESSMENT",
        eventType: "DOCUMENTS_REQUESTED",
        eventDate: "2026-11-15T10:00:00.000Z",
      }),
      makeEmail("hr", "2026-11-16T10:00:00.000Z", {
        isJobRelated: true,
        category: "HR_COMMUNICATION",
        eventType: "HR_UPDATE",
        eventDate: "2026-11-16T10:00:00.000Z",
      }),
    ];

    const neutralResponse = await request(app)
      .get(`/api/applications/${applicationId}/timeline`)
      .set("Cookie", authenticate());
    expect(neutralResponse.body.data.application.status).toBe("INTERVIEW");

    emails.push(
      makeEmail("offer", "2026-11-17T10:00:00.000Z", {
        isJobRelated: true,
        category: "OFFER",
        eventType: "OFFER_RECEIVED",
        eventDate: "2026-11-17T10:00:00.000Z",
      }),
    );
    const offerResponse = await request(app)
      .get(`/api/applications/${applicationId}/timeline`)
      .set("Cookie", authenticate());
    expect(offerResponse.body.data.application.status).toBe("OFFER");

    emails.push(
      makeEmail("rejection", "2026-11-18T10:00:00.000Z", {
        isJobRelated: true,
        category: "HR_COMMUNICATION",
        eventType: "REJECTION_RECEIVED",
        eventDate: "2026-11-18T10:00:00.000Z",
      }),
    );
    const rejectionResponse = await request(app)
      .get(`/api/applications/${applicationId}/timeline`)
      .set("Cookie", authenticate());
    expect(rejectionResponse.body.data.application.status).toBe("REJECTED");
  });

  it("returns safe original email fields only to its owner", async () => {
    emails = [
      makeEmail(emailId, "2026-11-12T10:00:00.000Z", {
        isJobRelated: true,
        category: "APPLICATION",
        eventType: "APPLICATION_RECEIVED",
      }, {
        bodyText:
          "Hello \\*Candidate\\*\n\n\nhttps://in.indeed.com/rc/clk/dl?" +
          "jk=abc123&tk=private&tracking=" + "x".repeat(220),
      }),
    ];

    const response = await request(app)
      .get(`/api/emails/${emailId}`)
      .set("Cookie", authenticate());

    expect(response.status).toBe(200);
    expect(response.body.data.email).toEqual({
      id: emailId,
      gmailMessageId: `gmail-${emailId}`,
      gmailUrl: `https://mail.google.com/mail/u/0/#inbox/gmail-${emailId}`,
      fromEmail: "hr@anc.example",
      toEmail: "candidate@example.com",
      subject: `Message ${emailId}`,
      bodyText:
        "Hello Candidate\n\nhttps://in.indeed.com/rc/clk/dl?jk=abc123",
      receivedAt: "2026-11-12T10:00:00.000Z",
    });
    expect(mock.findEmail).toHaveBeenCalledWith({
      where: { id: emailId, userId: "user-1" },
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
  });

  it("does not reveal an email owned by another user", async () => {
    emails = [
      makeEmail(emailId, "2026-11-12T10:00:00.000Z", null, {
        userId: "user-2",
      }),
    ];

    const response = await request(app)
      .get(`/api/emails/${emailId}`)
      .set("Cookie", authenticate());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      message: "Email not found",
      data: null,
      error: "Email not found",
    });
  });

  it("handles absent or malformed extraction metadata without failing", async () => {
    emails = [
      makeEmail("missing-metadata", "2026-11-12T10:00:00.000Z", null),
      makeEmail(
        "malformed-metadata",
        "2026-11-13T10:00:00.000Z",
        { category: 42, eventType: {}, summary: false },
      ),
    ];

    const response = await request(app)
      .get(`/api/applications/${applicationId}/timeline`)
      .set("Cookie", authenticate());

    expect(response.status).toBe(200);
    expect(response.body.data.timeline).toHaveLength(2);
    expect(response.body.data.timeline[0]).toMatchObject({
      category: null,
      eventType: null,
      eventDate: null,
      summary: null,
    });
    expect(response.body.data.timeline[1]).toMatchObject({
      category: null,
      eventType: null,
      summary: null,
    });
  });
});
