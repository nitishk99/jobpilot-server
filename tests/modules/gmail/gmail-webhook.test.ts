import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { apiRequestLogger } from "../../../src/middleware/api-request-logger.js";

const mock = {
  verifyIdToken: jest.fn(),
  enqueueEmailPipelineJob: jest.fn(),
};

jest.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken(input: unknown) {
      return mock.verifyIdToken(input);
    }
  },
}));

jest.mock("../../../src/workers/email-pipeline/queue.js", () => ({
  enqueueEmailPipelineJob: (...args) =>
    mock.enqueueEmailPipelineJob(...args),
}));

import {
  handleGmailWebhookJsonParseError,
  receiveGmailPushNotification,
} from "../../../src/modules/gmail/gmail-webhook.controller.js";

const audience = "https://api.jobpilot.example/api/gmail/webhook";
const serviceAccountEmail = "gmail-push@jobpilot.iam.gserviceaccount.com";

const createPushBody = (notification: unknown) => ({
  message: {
    data: Buffer.from(JSON.stringify(notification)).toString("base64"),
    messageId: "123456789",
  },
  subscription: "projects/jobpilot/subscriptions/gmail-push",
});

const createApp = () => {
  const app = express();
  app.use(apiRequestLogger);
  app.use(express.json());
  app.post("/api/gmail/webhook", receiveGmailPushNotification);
  app.use(handleGmailWebhookJsonParseError);
  return app;
};

const postPush = (body: object) =>
  request(createApp())
    .post("/api/gmail/webhook")
    .set("Authorization", "Bearer signed-push-token")
    .send(body);

const loggedDiagnostics = () =>
  jest.mocked(console.warn).mock.calls.map(([message]) =>
    typeof message === "string" ? JSON.parse(message) as unknown : message
  );

describe("Gmail Pub/Sub webhook", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.GMAIL_PUBSUB_AUDIENCE = audience;
    process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL = serviceAccountEmail;
    mock.verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        aud: audience,
        email: serviceAccountEmail,
        email_verified: true,
      }),
    });
    mock.enqueueEmailPipelineJob.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("authenticates and queues a wrapped Gmail notification before returning 204", async () => {
    const response = await postPush(createPushBody({
      emailAddress: "User@Example.com",
      historyId: "12345",
    }));

    expect(response.status).toBe(204);
    expect(mock.verifyIdToken).toHaveBeenCalledWith({
      idToken: "signed-push-token",
      audience,
    });
    expect(mock.enqueueEmailPipelineJob).toHaveBeenCalledWith({
      type: "gmail-history",
      emailAddress: "User@Example.com",
      historyId: "12345",
    });
  });

  it.each([
    ["missing message object", { subscription: "projects/p/subscriptions/s" }],
    ["missing message.data", { message: {}, subscription: "projects/p/subscriptions/s" }],
  ])("rejects an envelope with %s and logs only validation metadata", async (_case, body) => {
    const response = await postPush(body);

    expect(response.status).toBe(400);
    expect(mock.enqueueEmailPipelineJob).not.toHaveBeenCalled();
    expect(loggedDiagnostics()).toEqual([
      expect.objectContaining({
        event: "gmail.webhook.rejected",
        stage: "envelope.validation_failed",
        requestId: response.headers["x-request-id"],
        issues: expect.arrayContaining([
          expect.objectContaining({ code: expect.any(String), fieldPath: expect.any(Array) }),
        ]),
      }),
    ]);
  });

  it("rejects malformed base64 without logging its contents", async () => {
    const response = await postPush({
      message: { data: "%%%sensitive-data%%%" },
    });

    expect(response.status).toBe(400);
    expect(loggedDiagnostics()).toContainEqual(
      expect.objectContaining({
        stage: "payload.base64_decode_failed",
        requestId: response.headers["x-request-id"],
      }),
    );
    expect(JSON.stringify(loggedDiagnostics())).not.toContain("sensitive-data");
  });

  it("rejects invalid JSON inside valid base64 data", async () => {
    const response = await postPush({
      message: { data: Buffer.from("not-json").toString("base64") },
    });

    expect(response.status).toBe(400);
    expect(loggedDiagnostics()).toContainEqual(
      expect.objectContaining({ stage: "payload.json_parse_failed" }),
    );
  });

  it("rejects missing Gmail emailAddress without logging the address", async () => {
    const response = await postPush(createPushBody({ historyId: "12345" }));

    expect(response.status).toBe(400);
    expect(loggedDiagnostics()).toContainEqual(
      expect.objectContaining({
        stage: "notification.validation_failed",
        issues: expect.arrayContaining([
          expect.objectContaining({
            fieldPath: ["emailAddress"],
            expected: "string",
            receivedType: "undefined",
          }),
        ]),
      }),
    );
  });

  it("normalizes a safe numeric Gmail historyId to a decimal string", async () => {
    const response = await postPush(createPushBody({
      emailAddress: "private@example.com",
      historyId: 12345,
    }));

    expect(response.status).toBe(204);
    expect(mock.enqueueEmailPipelineJob).toHaveBeenCalledWith({
      type: "gmail-history",
      emailAddress: "private@example.com",
      historyId: "12345",
    });
  });

  it("rejects unsafe numeric Gmail historyId values", async () => {
    const response = await postPush(createPushBody({
      emailAddress: "private@example.com",
      historyId: 9007199254740992,
    }));

    expect(response.status).toBe(400);
    expect(loggedDiagnostics()).toContainEqual(
      expect.objectContaining({
        stage: "notification.validation_failed",
        issues: expect.arrayContaining([
          expect.objectContaining({
            fieldPath: ["historyId"],
            expected: "string",
            receivedType: "number",
          }),
        ]),
      }),
    );
    expect(JSON.stringify(loggedDiagnostics())).not.toContain("private@example.com");
  });

  it("rejects a non-numeric Gmail historyId without logging notification data", async () => {
    const response = await postPush(createPushBody({
      emailAddress: "private@example.com",
      historyId: "not-a-number",
    }));

    expect(response.status).toBe(400);
    expect(loggedDiagnostics()).toContainEqual(
      expect.objectContaining({
        stage: "notification.validation_failed",
        issues: expect.arrayContaining([
          expect.objectContaining({ fieldPath: ["historyId"] }),
        ]),
      }),
    );
    expect(JSON.stringify(loggedDiagnostics())).not.toContain("private@example.com");
  });

  it("returns 400 and a diagnostic when the HTTP JSON body is malformed", async () => {
    const response = await request(createApp())
      .post("/api/gmail/webhook")
      .set("Content-Type", "application/json")
      .send("{");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      message: "Invalid Pub/Sub request body",
      data: null,
      error: "Invalid Pub/Sub request body",
    });
    expect(mock.verifyIdToken).not.toHaveBeenCalled();
    expect(loggedDiagnostics()).toContainEqual(
      expect.objectContaining({
        stage: "request.json_parse_failed",
        requestId: response.headers["x-request-id"],
      }),
    );
  });

  it("rejects an invalid OIDC token", async () => {
    mock.verifyIdToken.mockRejectedValueOnce(new Error("token details"));

    const response = await postPush(createPushBody({
      emailAddress: "user@example.com",
      historyId: "12345",
    }));

    expect(response.status).toBe(401);
    expect(mock.enqueueEmailPipelineJob).not.toHaveBeenCalled();
    expect(loggedDiagnostics()).toContainEqual(
      expect.objectContaining({ stage: "authentication.failed" }),
    );
    expect(JSON.stringify(loggedDiagnostics())).not.toContain("token details");
  });

  it.each([
    ["incorrect audience", { aud: "https://wrong.example/webhook", email: serviceAccountEmail }],
    ["incorrect service-account email", { aud: audience, email: "other@example.com" }],
  ])("rejects an OIDC token with %s", async (_case, payload) => {
    mock.verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ ...payload, email_verified: true }),
    });

    const response = await postPush(createPushBody({
      emailAddress: "user@example.com",
      historyId: "12345",
    }));

    expect(response.status).toBe(401);
    expect(mock.enqueueEmailPipelineJob).not.toHaveBeenCalled();
  });

  it("returns 503 when Pub/Sub authentication configuration is missing", async () => {
    delete process.env.GMAIL_PUBSUB_AUDIENCE;

    const response = await postPush(createPushBody({
      emailAddress: "user@example.com",
      historyId: "12345",
    }));

    expect(response.status).toBe(503);
    expect(mock.verifyIdToken).not.toHaveBeenCalled();
    expect(loggedDiagnostics()).toContainEqual(
      expect.objectContaining({ stage: "authentication.configuration_missing" }),
    );
  });

  it("returns 503 when queue submission fails so Pub/Sub can retry", async () => {
    mock.enqueueEmailPipelineJob.mockRejectedValueOnce(
      new Error("sensitive broker details"),
    );

    const response = await postPush(createPushBody({
      emailAddress: "user@example.com",
      historyId: "12345",
    }));

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      message: "Gmail notification could not be queued",
      data: null,
      error: "Gmail notification could not be queued",
    });
    expect(loggedDiagnostics()).toContainEqual(
      expect.objectContaining({
        stage: "queue.submission_failed",
        errorName: "Error",
      }),
    );
    expect(JSON.stringify(loggedDiagnostics())).not.toContain("sensitive broker details");
  });

  it("accepts duplicate notifications for idempotent downstream history processing", async () => {
    const body = createPushBody({
      emailAddress: "user@example.com",
      historyId: "12345",
    });

    const first = await postPush(body);
    const duplicate = await postPush(body);

    expect(first.status).toBe(204);
    expect(duplicate.status).toBe(204);
    expect(mock.enqueueEmailPipelineJob).toHaveBeenCalledTimes(2);
  });
});
