import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { gmail_v1 } from "googleapis";

const mock = {
  getRepository: jest.fn(),
  findAccount: jest.fn(),
  updateAccount: jest.fn(),
  accountUpdateBuilder: {
    update: jest.fn(),
    set: jest.fn(),
    where: jest.fn(),
    setParameter: jest.fn(),
    execute: jest.fn(),
  },
  findEmail: jest.fn(),
  updateEmail: jest.fn(),
  deleteEmail: jest.fn(),
  setCredentials: jest.fn(),
  getAccessToken: jest.fn(),
  gmail: {
    users: {
      messages: {
        list: jest.fn(),
        get: jest.fn(),
      },
      history: {
        list: jest.fn(),
      },
      watch: jest.fn(),
    },
  },
  insertBuilder: {
    insert: jest.fn(),
    into: jest.fn(),
    values: jest.fn(),
    orIgnore: jest.fn(),
    returning: jest.fn(),
    execute: jest.fn(),
  },
};

jest.mock("../../../src/config/db.js", () => ({
  AppDataSource: {
    getRepository: (...args) => mock.getRepository(...args),
  },
}));

jest.mock("google-auth-library", () => ({
  OAuth2Client: class {
    setCredentials(credentials: unknown) {
      mock.setCredentials(credentials);
    }

    getAccessToken() {
      return mock.getAccessToken();
    }
  },
}));

jest.mock("googleapis", () => ({
  google: {
    gmail: jest.fn(() => mock.gmail),
  },
}));

import { ConnectedAccount } from "../../../src/database/entities/ConnectedAccount.js";
import {
  GmailMessageWithoutBodyError,
  startGmailWatchForUser,
  parseGmailMessage,
  syncGmailHistoryForUser,
  syncGmailForUser,
} from "../../../src/modules/gmail/gmail.service.js";
import gmailRouter from "../../../src/modules/gmail/gmail.routes.js";

const accountRepository = {
  findOneBy: mock.findAccount,
  update: mock.updateAccount,
  createQueryBuilder: jest.fn(() => mock.accountUpdateBuilder),
};

const emailRepository = {
  findOneBy: mock.findEmail,
  update: mock.updateEmail,
  delete: mock.deleteEmail,
  createQueryBuilder: jest.fn(() => mock.insertBuilder),
};

const makeMessage = (id: string): gmail_v1.Schema$Message => ({
  id,
  threadId: `thread-${id}`,
  internalDate: "1700000000000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "JobPilot <jobs@example.com>" },
      { name: "To", value: "candidate@example.com" },
      { name: "Subject", value: `Role ${id}` },
    ],
    parts: [
      {
        mimeType: "text/html",
        body: { data: Buffer.from("<p>HTML</p>").toString("base64url") },
      },
      {
        mimeType: "text/plain",
        body: { data: Buffer.from(`Plain text ${id}`).toString("base64url") },
      },
    ],
  },
});

describe("Gmail synchronization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    delete process.env.GMAIL_PUBSUB_TOPIC;

    mock.getRepository.mockImplementation((entity: unknown) =>
      entity === ConnectedAccount ? accountRepository : emailRepository,
    );
    mock.findAccount.mockResolvedValue({
      id: "account-1",
      userId: "user-1",
      provider: "GOOGLE",
      email: "user@example.com",
      accessToken: "old-access-token",
      refreshToken: "refresh-token",
      scopes:
        "openid https://www.googleapis.com/auth/gmail.readonly",
      status: "ACTIVE",
      gmailHistoryId: null,
      gmailWatchExpiresAt: null,
      gmailInitialSyncCompleted: false,
    });
    mock.updateAccount.mockResolvedValue({ affected: 1 });
    for (const method of [
      mock.accountUpdateBuilder.update,
      mock.accountUpdateBuilder.set,
      mock.accountUpdateBuilder.where,
      mock.accountUpdateBuilder.setParameter,
    ]) {
      method.mockReturnThis();
    }
    mock.accountUpdateBuilder.execute.mockResolvedValue({ affected: 1 });
    mock.findEmail.mockResolvedValue(null);
    mock.updateEmail.mockResolvedValue({ affected: 1 });
    mock.deleteEmail.mockResolvedValue({ affected: 0 });
    mock.getAccessToken.mockResolvedValue({ token: "new-access-token" });
    mock.gmail.users.messages.list.mockResolvedValue({ data: {} });
    mock.gmail.users.messages.get.mockReset();
    mock.gmail.users.history.list.mockResolvedValue({ data: {} });
    mock.gmail.users.watch.mockReset();

    for (const method of [
      mock.insertBuilder.insert,
      mock.insertBuilder.into,
      mock.insertBuilder.values,
      mock.insertBuilder.orIgnore,
      mock.insertBuilder.returning,
    ]) {
      method.mockReturnThis();
    }
    mock.insertBuilder.execute.mockResolvedValue({ raw: [{ id: "email-1" }] });
  });

  it("extracts headers, received date, and nested plain-text body", () => {
    const parsed = parseGmailMessage(makeMessage("message-1"), "user-1");

    expect(parsed).toMatchObject({
      userId: "user-1",
      gmailMessageId: "message-1",
      gmailThreadId: "thread-message-1",
      fromEmail: "jobs@example.com",
      toEmail: "candidate@example.com",
      subject: "Role message-1",
      bodyText: "Plain text message-1",
      applicationId: null,
    });
    expect(parsed.receivedAt).toEqual(new Date(1700000000000));
  });

  it("converts HTML-only content to readable text", () => {
    const message = makeMessage("html-message");
    message.payload = {
      ...(message.payload ?? {}),
      parts: [
        {
          mimeType: "text/html",
          body: {
            data: Buffer.from(
              "<html><body><h1>Hello &amp; hi</h1><p>World&nbsp;!</p><script>hidden</script></body></html>",
            ).toString("base64url"),
          },
        },
      ],
    };

    expect(parseGmailMessage(message, "user-1").bodyText).toBe(
      "Hello & hi\nWorld !",
    );
  });

  it("sanitizes plain-text artifacts and shortens Indeed tracking URLs", () => {
    const message = makeMessage("formatted-message");
    const plainTextPart = message.payload?.parts?.find(
      (part) => part.mimeType === "text/plain",
    );
    if (!plainTextPart?.body) {
      throw new Error("Plain-text test body is missing");
    }
    plainTextPart.body.data = Buffer.from(
      "We need a \\*Full Stack Developer\\*.\r\n\r\n\r\n" +
        "Location:\tRemote\u200b\n\n" +
        "Apply: https://in.indeed.com/rc/clk/dl?jk=abc123&tk=private&" +
        "veryLongTracking=" +
        "x".repeat(240),
    ).toString("base64url");

    expect(parseGmailMessage(message, "user-1").bodyText).toBe(
      "We need a Full Stack Developer.\n\n" +
        "Location:\tRemote\n\n" +
        "Apply: https://in.indeed.com/rc/clk/dl?jk=abc123",
    );
  });

  it("does not shorten unknown long URLs because they may require tokens", () => {
    const message = makeMessage("tokenized-link");
    const longUrl = `https://meet.example/join?token=${"x".repeat(240)}`;
    const plainTextPart = message.payload?.parts?.find(
      (part) => part.mimeType === "text/plain",
    );
    if (!plainTextPart?.body) {
      throw new Error("Plain-text test body is missing");
    }
    plainTextPart.body.data = Buffer.from(longUrl).toString("base64url");

    expect(parseGmailMessage(message, "user-1").bodyText).toBe(longUrl);
  });

  it("removes layout padding and repetitive CTA-only lines", () => {
    const raw = [
      "Nitish Kumar, you're invited to apply to this job",
      ...Array.from({ length: 20 }, () => ""),
      "Java Full Stack Development",
      "",
      "Apply now",
      ...Array.from({ length: 20 }, () => ""),
      "Hyderabad, Bengaluru, Chennai",
      "",
      "Job description",
      "",
      "Build production-ready enterprise applications.",
      "",
      "Get app",
      "",
      "You have received this mail because your e-mail ID is registered with Naukri.com.",
    ].join("\n");
    const message = makeMessage("padded-message");
    const plainTextPart = message.payload?.parts?.find(
      (part) => part.mimeType === "text/plain",
    );
    if (!plainTextPart?.body) {
      throw new Error("Plain-text test body is missing");
    }
    plainTextPart.body.data = Buffer.from(raw).toString("base64url");

    expect(parseGmailMessage(message, "user-1").bodyText).toBe(
      "Nitish Kumar, you're invited to apply to this job\n\n" +
        "Java Full Stack Development\n\n" +
        "Hyderabad, Bengaluru, Chennai\n\n" +
        "Job description\n\n" +
        "Build production-ready enterprise applications.",
    );
  });

  it("removes notification-only footer after preserving interview content", () => {
    const raw =
      "Thank you for applying to the Java role.\n\nProceed\n\n" +
      "Please complete the next interview step.\n\n" +
      "This email was sent from a notification-only address that cannot accept incoming email.";
    const message = makeMessage("footer-message");
    const plainTextPart = message.payload?.parts?.find(
      (part) => part.mimeType === "text/plain",
    );
    if (!plainTextPart?.body) {
      throw new Error("Plain-text test body is missing");
    }
    plainTextPart.body.data = Buffer.from(raw).toString("base64url");

    expect(parseGmailMessage(message, "user-1").bodyText).toBe(
      "Thank you for applying to the Java role.\n\n" +
        "Please complete the next interview step.",
    );
  });

  it("chooses a cleaner HTML alternative when plain text is layout-padding heavy", () => {
    const message = makeMessage("better-html");
    const plainTextPart = message.payload?.parts?.find(
      (part) => part.mimeType === "text/plain",
    );
    const htmlPart = message.payload?.parts?.find(
      (part) => part.mimeType === "text/html",
    );
    if (!plainTextPart?.body || !htmlPart?.body) {
      throw new Error("Test MIME bodies are missing");
    }
    plainTextPart.body.data = Buffer.from(
      `Apply now${"\n".repeat(40)}View details${"\n".repeat(40)}`,
    ).toString("base64url");
    htmlPart.body.data = Buffer.from(
      "<html><body><h2>Interview invitation</h2>" +
        "<p>Please complete the next round.</p>" +
        '<ul><li>Role: Java Engineer</li><li>Date: Friday</li></ul>' +
        '<a href="https://meet.example/token-123">Join interview</a></body></html>',
    ).toString("base64url");

    expect(parseGmailMessage(message, "user-1").bodyText).toContain(
      "Interview invitation",
    );
    expect(parseGmailMessage(message, "user-1").bodyText).toContain(
      "Join interview: https://meet.example/token-123",
    );
    expect(parseGmailMessage(message, "user-1").bodyText).toContain(
      "- Role: Java Engineer",
    );
  });

  it("preserves identifiers containing underscores while removing emphasis", () => {
    const message = makeMessage("identifier-message");
    const plainTextPart = message.payload?.parts?.find(
      (part) => part.mimeType === "text/plain",
    );
    if (!plainTextPart?.body) {
      throw new Error("Plain-text test body is missing");
    }
    plainTextPart.body.data = Buffer.from(
      "Reference: APPLICATION_123\nRole: _Backend Engineer_",
    ).toString("base64url");

    expect(parseGmailMessage(message, "user-1").bodyText).toBe(
      "Reference: APPLICATION_123\nRole: Backend Engineer",
    );
  });

  it("does not parse messages without readable content", () => {
    const message = makeMessage("empty-message");
    message.payload = { ...(message.payload ?? {}), parts: [{ mimeType: "image/png" }] };

    expect(() => parseGmailMessage(message, "user-1")).toThrow(
      GmailMessageWithoutBodyError,
    );
  });

  it("ignores duplicate Gmail messages using the unique database key", async () => {
    mock.gmail.users.messages.list
      .mockResolvedValueOnce({
        data: {
          messages: [{ id: "message-1" }, { id: "message-2" }],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({ data: {} });
    mock.gmail.users.messages.get.mockImplementation(
      async ({ id }: { id: string }) => ({ data: makeMessage(id) }),
    );
    mock.insertBuilder.execute
      .mockResolvedValueOnce({ raw: [{ id: "email-1" }] })
      .mockResolvedValueOnce({ raw: [] });

    const summary = await syncGmailForUser("user-1");

    expect(summary).toEqual({
      fetched: 2,
      inserted: 1,
      updated: 0,
      skipped: 1,
      failed: 0,
    });
    expect(mock.insertBuilder.orIgnore).toHaveBeenCalledTimes(2);
    expect(mock.gmail.users.messages.list).toHaveBeenCalledTimes(2);
  });

  it("limits the initial Gmail search to the previous seven days", async () => {
    const requestTime = Date.now();

    await syncGmailForUser("user-1");

    const query = mock.gmail.users.messages.list.mock.calls[0]?.[0].q as string;
    const after = Number(query.match(/after:(\d+)/)?.[1]);
    const elapsedSeconds = Math.floor(requestTime / 1000) - after;
    expect(query).toContain("-in:sent");
    expect(elapsedSeconds).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
    expect(elapsedSeconds).toBeLessThan(7 * 24 * 60 * 60 + 2);
  });

  it("creates a Gmail watch and stores its history cursor and expiration", async () => {
    const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000;
    process.env.GMAIL_PUBSUB_TOPIC = "projects/jobpilot/topics/gmail";
    mock.gmail.users.watch.mockResolvedValueOnce({
      data: { historyId: "100", expiration: String(expiration) },
    });

    const result = await startGmailWatchForUser("user-1");

    expect(mock.gmail.users.watch).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        topicName: "projects/jobpilot/topics/gmail",
        labelIds: ["INBOX"],
        labelFilterBehavior: "include",
      },
    });
    expect(result.initialSyncRequired).toBe(true);
    const watchUpdate = mock.accountUpdateBuilder.set.mock.calls[0]?.[0];
    expect(watchUpdate).toMatchObject({
      gmailWatchExpiresAt: new Date(expiration),
    });
    expect(watchUpdate.gmailHistoryId()).toContain("COALESCE(NULLIF(gmail_history_id, '')");
    expect(mock.accountUpdateBuilder.setParameter).toHaveBeenCalledWith(
      "historyId",
      "100",
    );
  });

  it("syncs unique messages from Gmail history and advances the cursor", async () => {
    mock.findAccount.mockResolvedValue({
      id: "account-1",
      userId: "user-1",
      provider: "GOOGLE",
      email: "user@example.com",
      refreshToken: "refresh-token",
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
      status: "ACTIVE",
      gmailHistoryId: "100",
      gmailWatchExpiresAt: new Date(Date.now() + 86_400_000),
      gmailInitialSyncCompleted: true,
    });
    mock.gmail.users.history.list.mockResolvedValueOnce({
      data: {
        historyId: "105",
        history: [
          { messagesAdded: [{ message: { id: "message-1" } }] },
          { messagesAdded: [{ message: { id: "message-1" } }] },
        ],
      },
    });
    mock.gmail.users.messages.get.mockResolvedValueOnce({
      data: makeMessage("message-1"),
    });

    const summary = await syncGmailHistoryForUser("user-1", "105");

    expect(summary).toEqual({
      fetched: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
    expect(mock.gmail.users.history.list).toHaveBeenCalledWith(
      expect.objectContaining({
        startHistoryId: "100",
        historyTypes: ["messageAdded"],
      }),
    );
    const cursorUpdate = mock.accountUpdateBuilder.set.mock.calls[0]?.[0];
    expect(cursorUpdate.gmailHistoryId()).toContain("GREATEST");
    expect(mock.accountUpdateBuilder.setParameter).toHaveBeenCalledWith(
      "historyId",
      "105",
    );
  });

  it("renews an expired history cursor before scanning recent mail", async () => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/jobpilot/topics/gmail";
    mock.findAccount.mockResolvedValue({
      id: "account-1",
      userId: "user-1",
      provider: "GOOGLE",
      refreshToken: "refresh-token",
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
      status: "ACTIVE",
      gmailHistoryId: "100",
      gmailInitialSyncCompleted: true,
    });
    mock.gmail.users.history.list.mockRejectedValueOnce({ response: { status: 404 } });
    mock.gmail.users.watch.mockResolvedValueOnce({
      data: { historyId: "120", expiration: String(Date.now() + 86_400_000) },
    });

    await syncGmailHistoryForUser("user-1", "110");

    expect(mock.gmail.users.watch.mock.invocationCallOrder[0]).toBeLessThan(
      mock.gmail.users.messages.list.mock.invocationCallOrder[0],
    );
    expect(mock.accountUpdateBuilder.setParameter).toHaveBeenLastCalledWith(
      "historyId",
      "120",
    );
    expect(mock.accountUpdateBuilder.set.mock.calls[1]?.[0]).toMatchObject({
      gmailInitialSyncCompleted: true,
    });
  });

  it("does not advance an expired cursor when the recovery scan fails", async () => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/jobpilot/topics/gmail";
    mock.findAccount.mockResolvedValue({
      id: "account-1",
      userId: "user-1",
      provider: "GOOGLE",
      refreshToken: "refresh-token",
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
      status: "ACTIVE",
      gmailHistoryId: "100",
      gmailInitialSyncCompleted: true,
    });
    mock.gmail.users.history.list.mockRejectedValueOnce({ response: { status: 404 } });
    mock.gmail.users.watch.mockResolvedValueOnce({
      data: { historyId: "120", expiration: String(Date.now() + 86_400_000) },
    });
    mock.gmail.users.messages.list.mockResolvedValueOnce({
      data: { messages: [{ id: "message-failed" }] },
    });
    mock.gmail.users.messages.get.mockRejectedValueOnce({ response: { status: 404 } });
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(syncGmailHistoryForUser("user-1", "110")).rejects.toMatchObject({
      code: "GMAIL_HISTORY_SYNC_INCOMPLETE",
    });
    expect(mock.accountUpdateBuilder.set).toHaveBeenCalledTimes(1);
    expect(mock.accountUpdateBuilder.set.mock.calls[0]?.[0].gmailHistoryId())
      .toContain("COALESCE(NULLIF(gmail_history_id, '')");
    warning.mockRestore();
  });

  it("repairs an existing null body when readable content is available", async () => {
    mock.gmail.users.messages.list.mockResolvedValueOnce({
      data: { messages: [{ id: "message-1" }] },
    });
    mock.gmail.users.messages.get.mockResolvedValueOnce({
      data: makeMessage("message-1"),
    });
    mock.findEmail.mockResolvedValueOnce({
      id: "existing-email",
      bodyText: null,
    });

    const summary = await syncGmailForUser("user-1");

    expect(summary).toEqual({
      fetched: 1,
      inserted: 0,
      updated: 1,
      skipped: 0,
      failed: 0,
    });
    expect(mock.updateEmail).toHaveBeenCalledWith(
      { id: "existing-email", bodyText: expect.anything() },
      { bodyText: "Plain text message-1" },
    );
    expect(mock.insertBuilder.execute).not.toHaveBeenCalled();
  });

  it("continues syncing when an individual message cannot be fetched", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    mock.gmail.users.messages.list.mockResolvedValueOnce({
      data: { messages: [{ id: "message-failed" }, { id: "message-ok" }] },
    });
    mock.gmail.users.messages.get.mockImplementation(
      async ({ id }: { id: string }) => {
        if (id === "message-failed") {
          throw { response: { status: 404 } };
        }
        return { data: makeMessage(id) };
      },
    );

    const summary = await syncGmailForUser("user-1");

    expect(summary).toEqual({
      fetched: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
      failed: 1,
    });
    expect(mock.gmail.users.messages.get).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      "Gmail message sync failed:",
      expect.objectContaining({ messageId: "message-failed", stage: "fetch", status: 404 }),
    );
    warning.mockRestore();
  });

  it("logs safe database diagnostics when saving a message fails", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    mock.gmail.users.messages.list.mockResolvedValueOnce({
      data: { messages: [{ id: "message-1" }] },
    });
    mock.gmail.users.messages.get.mockResolvedValueOnce({
      data: makeMessage("message-1"),
    });
    mock.insertBuilder.execute.mockRejectedValueOnce({
      name: "QueryFailedError",
      driverError: { code: "23505", message: "private email content" },
    });

    const summary = await syncGmailForUser("user-1");

    expect(summary.failed).toBe(1);
    expect(warning).toHaveBeenCalledWith(
      "Gmail message sync failed:",
      expect.objectContaining({ stage: "save", databaseCode: "23505" }),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private email content");
    warning.mockRestore();
  });

  it("skips empty-body messages instead of inserting a null body", async () => {
    const message = makeMessage("empty-message");
    message.payload = { ...(message.payload ?? {}), parts: [{ mimeType: "image/png" }] };
    mock.gmail.users.messages.list.mockResolvedValueOnce({
      data: { messages: [{ id: "empty-message" }] },
    });
    mock.gmail.users.messages.get.mockResolvedValueOnce({ data: message });

    const summary = await syncGmailForUser("user-1");

    expect(summary).toEqual({
      fetched: 1,
      inserted: 0,
      updated: 0,
      skipped: 1,
      failed: 0,
    });
    expect(mock.deleteEmail).toHaveBeenCalledWith(
      {
        userId: "user-1",
        gmailMessageId: "empty-message",
        bodyText: expect.anything(),
      },
    );
    expect(mock.insertBuilder.execute).not.toHaveBeenCalled();
  });

  it("does not expose a manual Gmail sync endpoint", async () => {
    const app = express();
    app.use("/api/gmail", gmailRouter);

    const response = await request(app).post("/api/gmail/sync");

    expect(response.status).toBe(404);
    expect(mock.getRepository).not.toHaveBeenCalled();
  });
});
