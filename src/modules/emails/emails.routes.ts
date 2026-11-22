import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware.js";
import {
  associateEmail,
  createApplicationFromEmail,
  dismissReviewEmail,
  getEmailDetails,
  listEmailsForReview,
  reassignEmail,
  unassociateEmail,
} from "./emails.controller.js";

const emailsRouter = Router();

emailsRouter.get("/review", requireAuth, listEmailsForReview);
emailsRouter.get("/:id", requireAuth, getEmailDetails);
emailsRouter.patch("/:id/associate", requireAuth, associateEmail);
emailsRouter.patch("/:id/reassign", requireAuth, reassignEmail);
emailsRouter.patch("/:id/unassociate", requireAuth, unassociateEmail);
emailsRouter.post("/:id/create-application", requireAuth, createApplicationFromEmail);
emailsRouter.delete("/:id/review", requireAuth, dismissReviewEmail);

export default emailsRouter;
