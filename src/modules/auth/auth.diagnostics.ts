import type { Request } from "express";
import { SESSION_COOKIE_NAME } from "./auth.service.js";
import type { SessionValidationOutcome } from "./auth.service.js";

export type SessionDiagnosticOutcome =
  | SessionValidationOutcome
  | "missing_cookie"
  | "database_failure";

export const logSessionDiagnostic = (
  req: Request,
  outcome: SessionDiagnosticOutcome,
): void => {
  if (req.originalUrl.split("?")[0] !== "/api/auth/me") {
    return;
  }

  console.info(
    JSON.stringify({
      origin: req.get("origin") ?? null,
      cookiePresent: typeof req.cookies?.[SESSION_COOKIE_NAME] === "string",
      outcome,
    }),
  );
};
