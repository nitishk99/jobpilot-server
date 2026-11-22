import { OAuth2Client } from "google-auth-library";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { z } from "zod";
import { getGmailPubSubAuthConfig } from "../../config/env.js";
import { enqueueEmailPipelineJob } from "../../workers/email-pipeline/queue.js";
import { sendError } from "../../utils/api-response.js";

const pubSubEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1),
  }),
});

const gmailHistoryIdSchema = z.preprocess(
  (value) =>
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? String(value)
      : value,
  z.string().regex(/^\d+$/),
);

const gmailNotificationSchema = z.object({
  emailAddress: z.string().email(),
  historyId: gmailHistoryIdSchema,
});

const getRequestId = (res: Response): string | undefined => {
  const requestId = res.getHeader("X-Request-Id");
  return typeof requestId === "string" ? requestId : undefined;
};

const logWebhookDiagnostic = (
  res: Response,
  stage: string,
  details: Record<string, unknown> = {},
): void => {
  const requestId = getRequestId(res);
  console.warn(JSON.stringify({
    event: "gmail.webhook.rejected",
    stage,
    ...(requestId ? { requestId } : {}),
    ...details,
  }));
};

const valueTypeAtPath = (value: unknown, path: PropertyKey[]): string => {
  let current = value;
  for (const segment of path) {
    if (
      typeof segment !== "string" ||
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = undefined;
      break;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null) {
    return "null";
  }
  return Array.isArray(current) ? "array" : typeof current;
};

const validationIssues = (
  issues: z.ZodError["issues"],
  value: unknown,
) =>
  issues.map((issue) => ({
    code: issue.code,
    fieldPath: issue.path.map(String),
    ...(issue.code === "invalid_type"
      ? {
          expected: issue.expected,
          receivedType: valueTypeAtPath(value, issue.path),
        }
      : {}),
  }));

const decodePubSubData = (data: string): Buffer | undefined => {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.match(/=*$/)?.[0].length ?? 0;
  const unpaddedLength = normalized.length - padding;
  const validCharacters = /^[A-Za-z0-9+/]*={0,2}$/.test(normalized);
  const validLength = unpaddedLength % 4 !== 1;
  const validPadding =
    padding === 0 ||
    (normalized.length % 4 === 0 &&
      ((padding === 1 && unpaddedLength % 4 === 3) ||
        (padding === 2 && unpaddedLength % 4 === 2)));

  if (!validCharacters || !validLength || !validPadding) {
    return undefined;
  }
  return Buffer.from(normalized, "base64");
};

const verifyPubSubRequest = async (authorization: string | undefined) => {
  let pubSubConfig: ReturnType<typeof getGmailPubSubAuthConfig>;
  try {
    pubSubConfig = getGmailPubSubAuthConfig();
  } catch {
    return "not-configured" as const;
  }

  const audience = pubSubConfig?.audience;
  const serviceAccountEmail = pubSubConfig?.serviceAccountEmail;
  const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!audience || !serviceAccountEmail) {
    return "not-configured" as const;
  }
  if (!bearerToken) {
    return "invalid" as const;
  }

  try {
    const ticket = await new OAuth2Client().verifyIdToken({
      idToken: bearerToken,
      audience,
    });
    const payload = ticket.getPayload();
    const audienceIsValid =
      payload?.aud === audience ||
      (Array.isArray(payload?.aud) && payload.aud.includes(audience));
    if (
      !payload ||
      !audienceIsValid ||
      payload.email?.toLowerCase() !== serviceAccountEmail ||
      payload.email_verified !== true
    ) {
      return "invalid" as const;
    }
    return "valid" as const;
  } catch {
    return "invalid" as const;
  }
};

export const receiveGmailPushNotification: RequestHandler = async (
  req,
  res,
) => {
  const authentication = await verifyPubSubRequest(req.header("authorization"));
  if (authentication === "not-configured") {
    logWebhookDiagnostic(res, "authentication.configuration_missing");
    sendError(res, 503, "Gmail push authentication is not configured");
    return;
  }
  if (authentication !== "valid") {
    logWebhookDiagnostic(res, "authentication.failed");
    sendError(res, 401, "Invalid Pub/Sub authentication");
    return;
  }

  const envelope = pubSubEnvelopeSchema.safeParse(req.body);
  if (!envelope.success) {
    logWebhookDiagnostic(res, "envelope.validation_failed", {
      issues: validationIssues(envelope.error.issues, req.body),
    });
    sendError(res, 400, "Invalid Pub/Sub notification");
    return;
  }

  const decodedData = decodePubSubData(envelope.data.message.data);
  if (!decodedData) {
    logWebhookDiagnostic(res, "payload.base64_decode_failed");
    sendError(res, 400, "Invalid Gmail notification data");
    return;
  }

  let notificationValue: unknown;
  try {
    notificationValue = JSON.parse(decodedData.toString("utf8"));
  } catch {
    logWebhookDiagnostic(res, "payload.json_parse_failed");
    sendError(res, 400, "Invalid Gmail notification data");
    return;
  }

  const notification = gmailNotificationSchema.safeParse(notificationValue);
  if (!notification.success) {
    logWebhookDiagnostic(res, "notification.validation_failed", {
      issues: validationIssues(notification.error.issues, notificationValue),
    });
    sendError(res, 400, "Invalid Gmail notification data");
    return;
  }

  try {
    await enqueueEmailPipelineJob({
      type: "gmail-history",
      emailAddress: notification.data.emailAddress,
      historyId: notification.data.historyId,
    });
    res.status(204).end();
  } catch (error) {
    logWebhookDiagnostic(res, "queue.submission_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    sendError(res, 503, "Gmail notification could not be queued");
  }
};

export const handleGmailWebhookJsonParseError: ErrorRequestHandler = (
  error,
  req,
  res,
  next,
) => {
  const errorType =
    typeof error === "object" && error !== null && "type" in error
      ? error.type
      : undefined;
  if (
    req.method !== "POST" ||
    req.path !== "/api/gmail/webhook" ||
    errorType !== "entity.parse.failed"
  ) {
    next(error);
    return;
  }

  logWebhookDiagnostic(res, "request.json_parse_failed");
  sendError(res, 400, "Invalid Pub/Sub request body");
};
