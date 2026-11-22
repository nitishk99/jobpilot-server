import type { RequestHandler } from "express";
import { AppDataSource } from "../../config/db.js";
import { User } from "../../database/entities/User.js";
import {
  AuthConfigurationError,
  authenticateGoogleCode,
  clearSession,
  createOAuthState,
  createSession,
  getGoogleAuthorizationUrl,
  isValidOAuthState,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_MAX_AGE_MS,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  getSessionCookieOptions,
  validateOAuthConfiguration,
} from "./auth.service.js";
import { initializeEmailPipelineForUser } from "../../workers/email-pipeline/bootstrap.js";
import { logSessionDiagnostic } from "./auth.diagnostics.js";
import {
  getClientUrl,
  getNodeEnvironment,
} from "../../config/env.js";
import { sendError, sendSuccess } from "../../utils/api-response.js";

const getStateCookieOptions = () => ({
  httpOnly: true,
  secure: getNodeEnvironment() === "production",
  sameSite: "lax" as const,
  path: "/api/auth",
});

export const startGoogleOAuth: RequestHandler = (_req, res) => {
  try {
    validateOAuthConfiguration();
    const state = createOAuthState();
    const authorizationUrl = getGoogleAuthorizationUrl(state);

    res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
      ...getStateCookieOptions(),
      maxAge: OAUTH_STATE_MAX_AGE_MS,
    });
    res.redirect(authorizationUrl);
  } catch (error) {
    if (error instanceof Error) {
      console.error("Google OAuth initialization failed:", error.name);
    }
    const status = error instanceof AuthConfigurationError ? 503 : 500;
    sendError(res, status, "Google authentication is unavailable");
  }
};

export const googleOAuthCallback: RequestHandler = async (req, res) => {
  const storedState = req.cookies?.[OAUTH_STATE_COOKIE_NAME];
  const receivedState =
    typeof req.query.state === "string" ? req.query.state : undefined;
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const providerError =
    typeof req.query.error === "string" ? req.query.error : undefined;

  res.clearCookie(OAUTH_STATE_COOKIE_NAME, getStateCookieOptions());

  if (!isValidOAuthState(receivedState, storedState)) {
    sendError(res, 400, "Invalid OAuth state");
    return;
  }
  if (providerError) {
    sendError(res, 400, "Google authorization was not completed");
    return;
  }
  if (!code) {
    sendError(res, 400, "Google authorization code is missing");
    return;
  }

  try {
    const session = createSession();
    const userId = await authenticateGoogleCode(
      code,
      session.tokenHash,
      session.expiresAt,
    );
    res.cookie(SESSION_COOKIE_NAME, session.token, {
      ...getSessionCookieOptions(),
      maxAge: SESSION_MAX_AGE_MS,
    });
    void initializeEmailPipelineForUser(userId).catch((error: unknown) => {
      console.error(
        "Gmail pipeline initialization failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
    res.redirect(303, getClientUrl());
  } catch (error) {
    if (error instanceof Error) {
      console.error("Google OAuth callback failed:", error.name);
    }
    sendError(res, 500, "Google authentication failed");
  }
};

export const getCurrentUser: RequestHandler = async (req, res) => {
  if (!req.authUserId) {
    sendError(res, 401, "Authentication required");
    return;
  }

  try {
    const user = await AppDataSource.getRepository(User).findOneBy({
      id: req.authUserId,
    });
    if (!user) {
      logSessionDiagnostic(req, "invalid");
      sendError(res, 401, "Invalid session");
      return;
    }

    sendSuccess(res, 200, "Current user loaded", {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        profilePicture: user.profilePicture,
      },
    });
  } catch (error) {
    logSessionDiagnostic(req, "database_failure");
    sendError(res, 500, "Unable to load current user");
  }
};

export const logout: RequestHandler = async (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions());

  const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sessionToken !== "string") {
    sendSuccess(res, 200, "Logged out");
    return;
  }

  try {
    await clearSession(sessionToken);
    sendSuccess(res, 200, "Logged out");
  } catch (error) {
    if (error instanceof Error) {
      console.error("Logout failed:", error.name);
    }
    sendError(res, 500, "Unable to complete logout");
  }
};
