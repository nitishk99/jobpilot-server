import type { ErrorRequestHandler, RequestHandler } from "express";
import { safeErrorDetails } from "../utils/safe-error-details.js";
import { sendError } from "../utils/api-response.js";

export const handleUnknownApiRoute: RequestHandler = (_req, res) => {
  sendError(res, 404, "Route not found");
};

export const handleApiError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const isJsonParseError =
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed";

  if (!isJsonParseError) {
    console.error("Unhandled API error:", safeErrorDetails(error));
  }
  sendError(
    res,
    isJsonParseError ? 400 : 500,
    isJsonParseError ? "Invalid JSON request body" : "Internal server error",
  );
};
