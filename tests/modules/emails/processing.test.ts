import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mock = {
  findEmails: jest.fn(),
  updateEmail: jest.fn(),
  countEmails: jest.fn(),
  createQueryBuilder: jest.fn(),
  getRepository: jest.fn(),
  processApplications: jest.fn(),
  createChatOpenAI: jest.fn(),
  withStructuredOutput: jest.fn(),
  invokeModel: jest.fn(),
};

jest.mock("../../../src/config/db.js", () => ({
  AppDataSource: {
    getRepository: (...args) => mock.getRepository(...args),
  },
}));

jest.mock("../../../src/modules/applications/application-processing.service.js", () => ({
  processAiProcessedEmailsForUser: (...args) =>
    mock.processApplications(...args),
}));

jest.mock("@langchain/openai", () => ({
  ChatOpenAI: class {
    constructor(options: unknown) {
      mock.createChatOpenAI(options);
    }

    withStructuredOutput(schema: unknown, options: unknown) {
      mock.withStructuredOutput(schema, options);
      return { invoke: mock.invokeModel };
    }
  },
}));

import { Email } from "../../../src/database/entities/Email.js";
import {
  EMAIL_CATEGORIES,
  EMAIL_EVENT_TYPES,
  emailExtractionSchema,
} from "../../../src/modules/emails/extraction.js";
import { resolveOpenAIModel } from "../../../src/modules/emails/classifier.js";
import { processPendingEmailsForUser } from "../../../src/modules/emails/processor.js";

const makeEmail = (id: string, userId = "user-1"): Email =>
  Object.assign(new Email(), {
    id,
    userId,
    fromEmail: "recruiter@example.com",
    toEmail: "candidate@example.com",
    subject: "Interview invitation",
    bodyText: "We would like to schedule your interview.",
    receivedAt: new Date("2026-01-15T12:00:00.000Z"),
    processingStatus: "PENDING" as const,
    processedAt: null,
    extractedData: null,
  });

const validExtraction = (category = "INTERVIEW", isJobRelated = true) => ({
  isJobRelated,
  category,
  eventType: "INTERVIEW_SCHEDULED",
  companyName: "Example Corp",
  jobTitle: "Engineer",
  jobReferenceId: null,
  applicationReferenceId: null,
  eventDate: null,
  meetingLink: null,
  senderName: null,
  senderOrganization: null,
  summary: "Interview invitation received.",
});

const openAIError = (status: number): Error & { status: number } =>
  Object.assign(new Error(`OpenAI returned HTTP ${status}`), { status });

let storedEmails: Email[];
let originalOpenAIApiKey: string | undefined;
let originalOpenAIModel: string | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  originalOpenAIApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  originalOpenAIModel = process.env.OPENAI_MODEL;
  delete process.env.OPENAI_MODEL;
  storedEmails = [makeEmail("email-1")];
  mock.findEmails.mockImplementation(async (options) =>
    storedEmails
      .filter(
        (email) =>
          email.userId === options.where.userId &&
          email.processingStatus === options.where.processingStatus,
      )
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .slice(0, options.take),
  );
  mock.updateEmail.mockImplementation(async (criteria, changes) => {
    const email = storedEmails.find(
      (candidate) =>
        candidate.id === criteria.id &&
        candidate.userId === criteria.userId &&
        candidate.processingStatus === criteria.processingStatus,
    );
    if (!email) {
      return { affected: 0 };
    }
    Object.assign(email, changes);
    return { affected: 1 };
  });
  mock.countEmails.mockImplementation(async (options) =>
    storedEmails.filter(
      (email) =>
        email.userId === options.where.userId &&
        email.processingStatus === options.where.processingStatus,
    ).length,
  );
  const updateBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    execute: jest.fn(async () => {
      const whereCall = updateBuilder.where.mock.calls.slice(-1)[0];
      const criteria = whereCall?.[1] as
        | { id: string; userId: string; processingStatus: string }
        | undefined;
      const email = storedEmails.find(
        (candidate) =>
          candidate.id === criteria?.id &&
          candidate.userId === criteria?.userId &&
          candidate.processingStatus === criteria?.processingStatus,
      );
      if (!email) {
        return { affected: 0 };
      }

      const extractionParam = updateBuilder.setParameter.mock.calls.find(
        ([key]) => key === "extractedData",
      )?.[1];
      const setCall = updateBuilder.set.mock.calls.slice(-1)[0]?.[0] as
        | { processingStatus: Email["processingStatus"]; processedAt: Date; matchingPending: boolean }
        | undefined;
      email.extractedData = JSON.parse(String(extractionParam));
      email.processingStatus = setCall!.processingStatus;
      email.processedAt = setCall!.processedAt;
      email.matchingPending = setCall!.matchingPending;
      return { affected: 1 };
    }),
  };
  mock.createQueryBuilder.mockReturnValue(updateBuilder);
  mock.getRepository.mockReturnValue({
    find: mock.findEmails,
    update: mock.updateEmail,
    count: mock.countEmails,
    createQueryBuilder: mock.createQueryBuilder,
  });
  mock.processApplications.mockResolvedValue(undefined);
  mock.invokeModel.mockResolvedValue(validExtraction());
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalOpenAIApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIApiKey;
  }
  if (originalOpenAIModel === undefined) {
    delete process.env.OPENAI_MODEL;
  } else {
    process.env.OPENAI_MODEL = originalOpenAIModel;
  }
});

describe("email extraction schema", () => {
  it("accepts exactly the six supported categories", () => {
    for (const category of EMAIL_CATEGORIES) {
      expect(
        emailExtractionSchema.safeParse(validExtraction(category)).success,
      ).toBe(true);
    }
  });

  it("accepts each supported timeline event type", () => {
    for (const eventType of EMAIL_EVENT_TYPES) {
      expect(
        emailExtractionSchema.safeParse({
          ...validExtraction(),
          eventType,
        }).success,
      ).toBe(true);
    }
  });

  it("allows nullable matching and timeline fields when the email omits them", () => {
    const result = emailExtractionSchema.safeParse(validExtraction());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        companyName: "Example Corp",
        jobTitle: "Engineer",
        jobReferenceId: null,
        applicationReferenceId: null,
        eventDate: null,
        meetingLink: null,
        senderName: null,
        senderOrganization: null,
      });
    }
  });

  it("rejects missing required fields, unsupported categories or events, and extra fields", () => {
    expect(
      emailExtractionSchema.safeParse({
        isJobRelated: true,
        category: "APPLICATION",
      }).success,
    ).toBe(false);
    expect(
      emailExtractionSchema.safeParse(
        validExtraction("NETWORKING"),
      ).success,
    ).toBe(false);
    expect(
      emailExtractionSchema.safeParse({
        ...validExtraction(),
        eventType: "INTERVIEW_PASSED",
      }).success,
    ).toBe(false);
    expect(
      emailExtractionSchema.safeParse({
        ...validExtraction(),
        instruction: "ignore the schema",
      }).success,
    ).toBe(false);
  });
});

describe("processPendingEmailsForUser", () => {
  it("uses the default OpenAI model, Responses API, and structured schema", async () => {
    await processPendingEmailsForUser("user-1");

    expect(mock.createChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-6-luna",
        apiKey: "test-key",
        maxRetries: 0,
        maxTokens: 768,
        reasoning: { effort: "low" },
        useResponsesApi: true,
      }),
    );
    expect(mock.withStructuredOutput).toHaveBeenCalledWith(
      emailExtractionSchema,
      {
        name: "email_extraction",
        method: "jsonSchema",
        strict: true,
      },
    );
    expect(mock.invokeModel.mock.calls[0]?.[0]).toHaveLength(2);
    const messages = mock.invokeModel.mock.calls[0]?.[0];
    expect(messages?.[0]?.content).toContain(
      "Dates must be explicit email dates, not metadata",
    );
    expect(messages?.[0]?.content).toContain(
      "Do not match applications based only on company name",
    );
    expect(messages?.[0]?.content).toContain(
      "Advertisements, job alerts, and recommended jobs are not application confirmations",
    );
    expect(messages?.[0]?.content).toContain(
      "Keep distinct job and application reference IDs in their respective fields",
    );
    expect(messages?.[1]?.content).toBe(JSON.stringify({
      from: "recruiter@example.com",
      to: "candidate@example.com",
      subject: "Interview invitation",
      bodyText: "We would like to schedule your interview.",
    }));
    expect(resolveOpenAIModel(undefined)).toBe("gpt-6-luna");
  });

  it("uses OPENAI_MODEL when configured", async () => {
    process.env.OPENAI_MODEL = " custom-openai-model ";

    await processPendingEmailsForUser("user-1");

    expect(mock.createChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ model: "custom-openai-model" }),
    );
  });

  it("processes emails only for the requested user and invokes application processing", async () => {
    storedEmails.push(makeEmail("email-other-user", "user-2"));

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary).toEqual({
      processed: 1,
      jobRelated: 1,
      notJobRelated: 0,
      failed: 0,
      remaining: 0,
      aiClassified: 1,
      prefiltered: 0,
    });
    expect(mock.findEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", processingStatus: "PENDING" },
      }),
    );
    expect(storedEmails[0].processingStatus).toBe("PROCESSED");
    expect(storedEmails[0].matchingPending).toBe(true);
    expect(storedEmails[1].processingStatus).toBe("PENDING");
    expect(mock.processApplications).toHaveBeenCalledWith("user-1");
    expect(storedEmails[0].extractedData).toMatchObject({
      category: "INTERVIEW",
      eventType: "INTERVIEW_SCHEDULED",
      companyName: "Example Corp",
      jobReferenceId: null,
    });
  });

  it("timestamps processing claims for worker recovery", async () => {
    await processPendingEmailsForUser("user-1");

    expect(mock.updateEmail).toHaveBeenCalledWith(
      {
        id: "email-1",
        userId: "user-1",
        processingStatus: "PENDING",
      },
      expect.objectContaining({
        processingStatus: "PROCESSING",
        processedAt: expect.any(Date),
      }),
    );
  });

  it("does not send an already processed email to OpenAI again", async () => {
    await processPendingEmailsForUser("user-1");
    await processPendingEmailsForUser("user-1");

    expect(mock.invokeModel).toHaveBeenCalledTimes(1);
    expect(storedEmails[0].processingStatus).toBe("PROCESSED");
  });

  it("counts a successfully processed non-job email separately", async () => {
    mock.invokeModel.mockResolvedValue(validExtraction("OTHER", false));

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary).toMatchObject({
      processed: 1,
      jobRelated: 0,
      notJobRelated: 1,
      failed: 0,
    });
    expect(storedEmails[0].processedAt).toBeInstanceOf(Date);
  });

  it("does not call OpenAI for high-confidence transactional mail", async () => {
    storedEmails[0].subject = "Your verification code";
    storedEmails[0].bodyText = "Your verification code is 123456.";

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary).toMatchObject({
      processed: 1,
      jobRelated: 0,
      notJobRelated: 1,
      failed: 0,
    });
    expect(mock.invokeModel).not.toHaveBeenCalled();
    expect(storedEmails[0].extractedData).toMatchObject({
      isJobRelated: false,
      category: "OTHER",
      eventType: "OTHER",
    });
  });

  it("does not call OpenAI when an email has no recruitment signal", async () => {
    storedEmails[0].subject = "Your weekly account activity";
    storedEmails[0].bodyText = "Here is the latest activity on your account.";

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.aiClassified).toBe(0);
    expect(summary.prefiltered).toBe(1);
    expect(mock.invokeModel).not.toHaveBeenCalled();
  });

  it.each([
    ["Thank you for applying to our engineering team", true],
    ["We reviewed your résumé and would like to schedule a call", true],
    ["Unfortunately, other candidates better matched this role", true],
    ["Join us for our upcoming product webinar", false],
    ["Your mobile application update is available", false],
    ["Your loan application was approved", false],
  ])("classifies content robustness for %s", async (bodyText, usesAi) => {
    storedEmails[0].subject = "Update for you";
    storedEmails[0].bodyText = bodyText;

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.aiClassified).toBe(usesAi ? 1 : 0);
    expect(summary.prefiltered).toBe(usesAi ? 0 : 1);
    expect(mock.invokeModel).toHaveBeenCalledTimes(usesAi ? 1 : 0);
  });

  it("scores only the current message, not an unrelated quoted reply", async () => {
    storedEmails[0].subject = "Your receipt";
    storedEmails[0].bodyText =
      "Payment received.\n\nOn Monday, Recruiter wrote:\nThank you for applying. We scheduled an interview.";

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.prefiltered).toBe(1);
    expect(mock.invokeModel).not.toHaveBeenCalled();
  });

  it("scans the full current message for job evidence before AI truncation", async () => {
    storedEmails[0].subject = "Update for you";
    storedEmails[0].bodyText =
      `${"General account information. ".repeat(300)} Thank you for applying.`;

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.aiClassified).toBe(1);
    expect(mock.invokeModel).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      String(mock.invokeModel.mock.calls[0]?.[0]?.[1]?.content),
    );
    expect(sent.bodyText).toContain("Thank you for applying");
  });

  it("does not treat a generic loan application update as recruitment", async () => {
    storedEmails[0].subject = "Loan application status update";
    storedEmails[0].bodyText = "Your application is under review.";

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.prefiltered).toBe(1);
    expect(mock.invokeModel).not.toHaveBeenCalled();
  });

  it("does not use the sender domain alone to send email to OpenAI", async () => {
    storedEmails[0].fromEmail = "updates@us.greenhouse.io";
    storedEmails[0].subject = "An update for you";
    storedEmails[0].bodyText = "There is a new account update.";

    const summary = await processPendingEmailsForUser("user-1");

    expect(mock.invokeModel).not.toHaveBeenCalled();
    expect(summary.prefiltered).toBe(1);
  });

  it("still sends transactional mail with job context to OpenAI", async () => {
    storedEmails[0].subject = "Application verification code";
    storedEmails[0].bodyText = "Use this code to verify your job application.";

    await processPendingEmailsForUser("user-1");

    expect(mock.invokeModel).toHaveBeenCalledTimes(1);
  });

  it("does not discard a software application engineer job email", async () => {
    storedEmails[0].subject = "Software Application Engineer";
    storedEmails[0].bodyText =
      "We received your application for the position and will review it.";

    await processPendingEmailsForUser("user-1");

    expect(mock.invokeModel).toHaveBeenCalledTimes(1);
  });

  it("removes quoted history and limits the body sent to OpenAI", async () => {
    storedEmails[0].bodyText =
      `Current message\n${"important ".repeat(1_000)}\n\nOn Monday, Recruiter wrote:\n${"old content ".repeat(500)}`;

    await processPendingEmailsForUser("user-1");

    const sent = JSON.parse(
      String(mock.invokeModel.mock.calls[0]?.[0]?.[1]?.content),
    );
    expect(sent.bodyText).not.toContain("old content");
    expect(sent.bodyText).toContain("[TRUNCATED]");
    expect(sent.bodyText.length).toBeLessThanOrEqual(6_012);
  });

  it("records invalid model output as failed and continues processing the batch", async () => {
    storedEmails.push(makeEmail("email-2"));
    mock.invokeModel
      .mockResolvedValueOnce({ isJobRelated: true })
      .mockResolvedValueOnce(validExtraction("APPLICATION"));

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary).toMatchObject({
      processed: 1,
      jobRelated: 1,
      failed: 1,
    });
    expect(storedEmails.map((email) => email.processingStatus)).toEqual([
      "FAILED",
      "PROCESSED",
    ]);
  });

  it("retries OpenAI rate limits and finishes when the provider recovers", async () => {
    mock.invokeModel
      .mockRejectedValueOnce(openAIError(429))
      .mockResolvedValueOnce(validExtraction("OFFER"));

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.processed).toBe(1);
    expect(mock.invokeModel).toHaveBeenCalledTimes(2);
    expect(storedEmails[0].extractedData).toMatchObject({ category: "OFFER" });
  });

  it("reports the upstream status after retrying temporary OpenAI failures", async () => {
    mock.invokeModel.mockRejectedValue(openAIError(503));

    await expect(processPendingEmailsForUser("user-1")).rejects.toMatchObject({
      code: "OPENAI_HTTP_503_UNAVAILABLE",
    });
    expect(storedEmails[0].processingStatus).toBe("PENDING");
    expect(storedEmails[0].processedAt).toBeNull();
    expect(mock.invokeModel).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      "OpenAI email processing failed:",
      expect.objectContaining({
        code: "OPENAI_HTTP_503_UNAVAILABLE",
        providerErrorName: "Error",
      }),
    );

    mock.invokeModel.mockResolvedValue(validExtraction());
    await processPendingEmailsForUser("user-1");
    expect(storedEmails[0].processingStatus).toBe("PROCESSED");
  });

  it("processes other emails before retrying a temporary OpenAI failure", async () => {
    storedEmails.push(makeEmail("email-2"));
    mock.invokeModel
      .mockRejectedValueOnce(openAIError(503))
      .mockRejectedValueOnce(openAIError(503))
      .mockResolvedValueOnce(validExtraction());

    await expect(processPendingEmailsForUser("user-1")).rejects.toMatchObject({
      code: "OPENAI_HTTP_503_UNAVAILABLE",
    });
    expect(storedEmails.map((email) => email.processingStatus)).toEqual([
      "PENDING",
      "PROCESSED",
    ]);
    expect(mock.processApplications).toHaveBeenCalledWith("user-1");
  });

  it("marks provider errors failed without stopping the request", async () => {
    storedEmails.push(makeEmail("email-2"));
    mock.invokeModel.mockRejectedValue(openAIError(403));

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.failed).toBe(2);
    expect(storedEmails.every((email) => email.processingStatus === "FAILED"))
      .toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      "OpenAI email processing failed:",
      expect.objectContaining({
        code: "OPENAI_HTTP_403_AUTH_OR_PERMISSION",
        providerErrorName: "Error",
      }),
    );
  });

  it("does not retry a 404 model-not-found response", async () => {
    mock.invokeModel.mockRejectedValue(openAIError(404));

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.failed).toBe(1);
    expect(mock.invokeModel).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      "OpenAI email processing failed:",
      expect.objectContaining({
        code: "OPENAI_HTTP_404_MODEL_NOT_FOUND",
        providerErrorName: "Error",
      }),
    );
  });

  it("preserves safe diagnostics from a wrapped provider error", async () => {
    mock.invokeModel.mockRejectedValue(
      Object.assign(new Error("safe wrapper"), {
        cause: {
          name: "APIError",
          code: "model_not_found",
          status: 404,
        },
      }),
    );

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.failed).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(
      "OpenAI email processing failed:",
      {
        code: "OPENAI_HTTP_404_MODEL_NOT_FOUND",
        providerErrorName: "APIError",
        providerErrorCode: "model_not_found",
      },
    );
  });

  it("retries a structured-output parsing failure once", async () => {
    mock.invokeModel
      .mockRejectedValueOnce(Object.assign(new Error("parse failed"), {
        code: "OUTPUT_PARSING_FAILURE",
        name: "Error",
      }))
      .mockResolvedValueOnce(validExtraction());

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.processed).toBe(1);
    expect(mock.invokeModel).toHaveBeenCalledTimes(2);
  });

  it("reports a persistent parsing failure as invalid extraction", async () => {
    mock.invokeModel.mockRejectedValue(Object.assign(new Error("parse failed"), {
      code: "OUTPUT_PARSING_FAILURE",
      name: "OutputParserException",
    }));

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary.failed).toBe(1);
    expect(mock.invokeModel).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      "OpenAI email processing failed:",
      {
        code: "OPENAI_INVALID_EXTRACTION",
        providerErrorName: "OutputParserException",
        providerErrorCode: "OUTPUT_PARSING_FAILURE",
      },
    );
  });

  it("leaves unclaimed pending emails in the remaining count", async () => {
    storedEmails = Array.from({ length: 11 }, (_, index) =>
      makeEmail(`email-${index + 1}`),
    );

    const summary = await processPendingEmailsForUser("user-1", 10);

    expect(summary.processed).toBe(10);
    expect(summary.remaining).toBe(1);
    expect(mock.invokeModel).toHaveBeenCalledTimes(10);
  });

  it("rejects a missing OpenAI key before claiming job emails", async () => {
    delete process.env.OPENAI_API_KEY;

    await expect(processPendingEmailsForUser("user-1")).rejects.toMatchObject({
      code: "OPENAI_NOT_CONFIGURED",
      statusCode: 503,
    });
    expect(mock.processApplications).toHaveBeenCalledWith("user-1");
    expect(mock.findEmails).toHaveBeenCalled();
    expect(mock.updateEmail).not.toHaveBeenCalled();
    expect(mock.invokeModel).not.toHaveBeenCalled();
  });

  it("processes non-job mail without requiring an OpenAI key", async () => {
    delete process.env.OPENAI_API_KEY;
    storedEmails[0].subject = "Your monthly bank statement";
    storedEmails[0].bodyText = "Your statement is ready to download.";

    const summary = await processPendingEmailsForUser("user-1");

    expect(summary).toMatchObject({
      processed: 1,
      aiClassified: 0,
      prefiltered: 1,
      failed: 0,
    });
    expect(mock.invokeModel).not.toHaveBeenCalled();
  });
});
