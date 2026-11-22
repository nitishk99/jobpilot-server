import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getNodeEnvironment } from "../../config/env.js";
import { AppDataSource } from "../../config/db.js";
import { User } from "../../database/entities/User.js";

export const SESSION_COOKIE_NAME = "jobpilot_session";
export const OAUTH_STATE_COOKIE_NAME = "jobpilot_oauth_state";
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

export type SessionCookieSameSite = "lax" | "strict" | "none";
export type SessionValidationOutcome = "invalid" | "expired" | "valid";

export class AuthConfigurationError extends Error {}

export const getSessionCookieOptions = (
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const configuredSameSite = (environment.SESSION_COOKIE_SAME_SITE ?? "lax")
    .toLowerCase();
  if (
    configuredSameSite !== "lax" &&
    configuredSameSite !== "strict" &&
    configuredSameSite !== "none"
  ) {
    throw new AuthConfigurationError(
      "SESSION_COOKIE_SAME_SITE must be lax, strict, or none",
    );
  }

  const sameSite: SessionCookieSameSite = configuredSameSite;
  return {
    httpOnly: true,
    secure: sameSite === "none" || getNodeEnvironment(environment) === "production",
    sameSite,
    path: "/",
  };
};

export const createSession = (now = Date.now()) => {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now + SESSION_MAX_AGE_MS),
  };
};

export const isValidSessionToken = (token: string): boolean =>
  /^[A-Za-z0-9_-]{43}$/.test(token);

export const hashSessionToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const findSessionUserId = async (
  token: string,
  onValidationOutcome?: (outcome: SessionValidationOutcome) => void,
): Promise<string | null> => {
  if (!isValidSessionToken(token)) {
    onValidationOutcome?.("invalid");
    return null;
  }

  const user = await AppDataSource.getRepository(User).findOneBy({
    sessionTokenHash: hashSessionToken(token),
  });
  if (!user?.sessionExpiresAt) {
    onValidationOutcome?.("invalid");
    return null;
  }
  if (user.sessionExpiresAt.getTime() <= Date.now()) {
    onValidationOutcome?.("expired");
    return null;
  }

  onValidationOutcome?.("valid");
  return user.id;
};

export const clearSession = async (token: string): Promise<void> => {
  if (!isValidSessionToken(token)) {
    return;
  }

  await AppDataSource.getRepository(User).update(
    { sessionTokenHash: hashSessionToken(token) },
    { sessionTokenHash: null, sessionExpiresAt: null },
  );
};

export const createOAuthState = (): string =>
  randomBytes(32).toString("base64url");

export const isValidOAuthState = (
  receivedState: string | undefined,
  storedState: string | undefined,
): boolean => {
  if (
    !receivedState ||
    !storedState ||
    !/^[A-Za-z0-9_-]{43}$/.test(receivedState) ||
    !/^[A-Za-z0-9_-]{43}$/.test(storedState)
  ) {
    return false;
  }

  const received = Buffer.from(receivedState, "base64url");
  const stored = Buffer.from(storedState, "base64url");
  return received.length === stored.length && timingSafeEqual(received, stored);
};
