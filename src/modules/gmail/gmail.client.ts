import { OAuth2Client } from "google-auth-library";
import { google, gmail_v1 } from "googleapis";
import { AppDataSource } from "../../config/db.js";
import {
  getGoogleOAuthClientCredentials,
} from "../../config/env.js";
import { ConnectedAccount } from "../../database/entities/ConnectedAccount.js";

const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

type ErrorRecord = Record<string, unknown>;

export interface GoogleErrorDetails {
  status?: number;
  code?: string;
  error?: string;
  reasons: string[];
}

export class GmailSyncError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GmailSyncError";
  }
}

const asRecord = (value: unknown): ErrorRecord | undefined =>
  typeof value === "object" && value !== null
    ? (value as ErrorRecord)
    : undefined;

export const getGoogleErrorDetails = (error: unknown): GoogleErrorDetails => {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const responseData = asRecord(response?.data);
  const nestedError = responseData?.error;
  const nestedErrorRecord = asRecord(nestedError);
  const googleError = nestedErrorRecord ?? responseData;
  const rawReasons = googleError?.errors;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons
        .map((item) => asRecord(item)?.reason)
        .filter((reason): reason is string => typeof reason === "string")
    : [];
  const status =
    typeof response?.status === "number"
      ? response.status
      : typeof record?.status === "number"
        ? record.status
        : undefined;

  return {
    status,
    code: typeof record?.code === "string" ? record.code : undefined,
    error:
      typeof nestedError === "string"
        ? nestedError
        : typeof googleError?.status === "string"
          ? googleError.status
          : undefined,
    reasons,
  };
};

const isInvalidGrant = (error: unknown): boolean =>
  getGoogleErrorDetails(error).error === "invalid_grant";

const isRateLimitError = (details: GoogleErrorDetails): boolean =>
  details.reasons.some((reason) =>
    ["rateLimitExceeded", "userRateLimitExceeded", "backendError"].includes(
      reason,
    ),
  );

const isRetryableGoogleError = (error: unknown): boolean => {
  const details = getGoogleErrorDetails(error);
  if ([429, 500, 502, 503, 504].includes(details.status ?? 0)) {
    return true;
  }
  if (details.status === 403 && isRateLimitError(details)) {
    return true;
  }
  return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"].includes(
    details.code ?? "",
  );
};

export const isAuthorizationError = (error: unknown): boolean => {
  const details = getGoogleErrorDetails(error);
  return (
    details.status === 401 ||
    (details.status === 403 &&
      details.reasons.some((reason) =>
        ["insufficientPermissions", "forbidden", "accessNotConfigured"].includes(
          reason,
        ),
      ))
  );
};

export const retryGoogleRequest = async <T>(
  request: () => Promise<T>,
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (attempt + 1 >= MAX_RETRY_ATTEMPTS || !isRetryableGoogleError(error)) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAY_MS * 2 ** attempt),
      );
    }
  }
};

const markAccountForReconnect = async (
  account: ConnectedAccount,
): Promise<GmailSyncError> => {
  await AppDataSource.getRepository(ConnectedAccount).update(
    { id: account.id },
    { status: "REAUTH_REQUIRED" },
  );
  return new GmailSyncError(
    409,
    "GOOGLE_REAUTH_REQUIRED",
    "Google authorization expired or was revoked. Reconnect the Google account.",
  );
};

export const createGmailClientForUser = async (
  userId: string,
): Promise<gmail_v1.Gmail> => {
  const accounts = AppDataSource.getRepository(ConnectedAccount);
  const account = await accounts.findOneBy({ userId, provider: "GOOGLE" });

  if (!account) {
    throw new GmailSyncError(
      409,
      "GOOGLE_ACCOUNT_NOT_CONNECTED",
      "Connect a Google account before syncing Gmail.",
    );
  }

  if (account.status !== "ACTIVE" || !account.refreshToken) {
    throw await markAccountForReconnect(account);
  }

  const scopes = account.scopes?.split(/\s+/) ?? [];
  if (!scopes.includes(GMAIL_READONLY_SCOPE)) {
    throw await markAccountForReconnect(account);
  }

  let credentials: ReturnType<typeof getGoogleOAuthClientCredentials>;
  try {
    credentials = getGoogleOAuthClientCredentials();
  } catch {
    throw new GmailSyncError(
      503,
      "GOOGLE_OAUTH_NOT_CONFIGURED",
      "Google OAuth is not configured on the server.",
    );
  }

  const authClient = new OAuth2Client(
    credentials.clientId,
    credentials.clientSecret,
  );
  authClient.setCredentials({ refresh_token: account.refreshToken });

  try {
    const { token } = await retryGoogleRequest(() =>
      authClient.getAccessToken(),
    );
    if (!token) {
      throw new GmailSyncError(
        502,
        "GOOGLE_TOKEN_REFRESH_FAILED",
        "Google did not provide an access token.",
      );
    }
  } catch (error) {
    if (isInvalidGrant(error)) {
      throw await markAccountForReconnect(account);
    }
    if (isAuthorizationError(error)) {
      throw new GmailSyncError(
        403,
        "GMAIL_ACCESS_DENIED",
        "Google denied Gmail access. Reconnect the account and grant Gmail read access.",
      );
    }
    if (isRetryableGoogleError(error)) {
      throw new GmailSyncError(
        503,
        "GOOGLE_TEMPORARILY_UNAVAILABLE",
        "Google is temporarily unavailable. Try syncing again.",
      );
    }
    if (error instanceof GmailSyncError) {
      throw error;
    }
    throw new GmailSyncError(
      502,
      "GOOGLE_TOKEN_REFRESH_FAILED",
      "Unable to refresh Google authorization.",
    );
  }

  return google.gmail({ version: "v1", auth: authClient });
};

export const toGmailApiError = (error: unknown): GmailSyncError => {
  const details = getGoogleErrorDetails(error);
  if (details.reasons.includes("accessNotConfigured")) {
    return new GmailSyncError(
      503,
      "GMAIL_API_NOT_ENABLED",
      "The Gmail API is not enabled for this Google Cloud project.",
    );
  }
  if (isAuthorizationError(error)) {
    return new GmailSyncError(
      details.status === 401 ? 409 : 403,
      "GMAIL_ACCESS_DENIED",
      "Google denied Gmail access. Reconnect the account and grant Gmail read access.",
    );
  }
  if (isRetryableGoogleError(error)) {
    return new GmailSyncError(
      503,
      "GMAIL_TEMPORARILY_UNAVAILABLE",
      "Gmail is temporarily unavailable. Try syncing again.",
    );
  }
  return new GmailSyncError(
    502,
    "GMAIL_SYNC_FAILED",
    "Gmail could not complete the synchronization request.",
  );
};
