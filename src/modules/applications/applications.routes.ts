import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware.js";
import {
  getApplicationTimeline,
  listApplications,
} from "./applications.controller.js";

const applicationsRouter = Router();

applicationsRouter.get("/", requireAuth, listApplications);
applicationsRouter.get("/:id/timeline", requireAuth, getApplicationTimeline);

export default applicationsRouter;
