import express from "express";
import cookieParser from "cookie-parser";
import { apiRequestLogger } from "./middleware/api-request-logger.js";
import { corsMiddleware } from "./middleware/cors.js";
import authRouter from "./modules/auth/auth.routes.js";
import gmailRouter from "./modules/gmail/gmail.routes.js";
import applicationsRouter from "./modules/applications/applications.routes.js";
import emailsRouter from "./modules/emails/emails.routes.js";
import { handleGmailWebhookJsonParseError } from "./modules/gmail/gmail-webhook.controller.js";
import { sendSuccess } from "./utils/api-response.js";
import {
  handleApiError,
  handleUnknownApiRoute,
} from "./middleware/api-error-handler.js";

export const createApp = () => {
  const app = express();

  app.use(corsMiddleware);
  app.use(apiRequestLogger);
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  app.use("/api/gmail", gmailRouter);
  app.use("/api/applications", applicationsRouter);
  app.use("/api/emails", emailsRouter);

  app.get("/health", (_req, res) => {
    sendSuccess(res, 200, "JobPilot API is running");
  });

  app.use(handleGmailWebhookJsonParseError);
  app.use(handleUnknownApiRoute);
  app.use(handleApiError);
  return app;
};
