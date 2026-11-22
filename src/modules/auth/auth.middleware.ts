import type { RequestHandler } from "express";
import { findSessionUserId, SESSION_COOKIE_NAME } from "./auth.session.js";
import { logSessionDiagnostic } from "./auth.diagnostics.js";
import { isAllowedClientOrigin } from "../../config/env.js";
import { sendError } from "../../utils/api-response.js";

const isSameOriginRequest = (origin: string | undefined): boolean => {
  return isAllowedClientOrigin(origin);
};

const isStateChangingMethod = (method: string): boolean =>
  method === "POST" ||
  method === "PATCH" ||
  method === "PUT" ||
  method === "DELETE";

export const requireSameOrigin: RequestHandler = (req, res, next) => {
  if (!isSameOriginRequest(req.get("origin"))) {
    sendError(res, 403, "Invalid request origin");
    return;
  }
  next();
};

declare global {
  namespace Express {
    interface Request {
      authUserId?: string;
    }
  }
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  if (req.method === "OPTIONS") {
    next();
    return;
  }

  if (
    isStateChangingMethod(req.method) &&
    !isSameOriginRequest(req.get("origin"))
  ) {
    sendError(res, 403, "Invalid request origin");
    return;
  }

  const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sessionToken !== "string") {
    logSessionDiagnostic(req, "missing_cookie");
    sendError(res, 401, "Authentication required");
    return;
  }

  try {
    const userId = await findSessionUserId(sessionToken, (outcome) => {
      logSessionDiagnostic(req, outcome);
    });
    if (!userId) {
      sendError(res, 401, "Invalid or expired session");
      return;
    }

    req.authUserId = userId;
    next();
  } catch (error) {
    logSessionDiagnostic(req, "database_failure");
    sendError(res, 500, "Authentication service unavailable");
  }
};
