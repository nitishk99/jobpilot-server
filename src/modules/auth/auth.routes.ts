import { Router } from "express";
import { requireAuth, requireSameOrigin } from "./auth.middleware.js";
import {
  getCurrentUser,
  googleOAuthCallback,
  logout,
  startGoogleOAuth,
} from "./auth.controller.js";

const authRouter = Router();

authRouter.get("/google", startGoogleOAuth);
authRouter.get("/google/callback", googleOAuthCallback);
authRouter.get("/me", requireAuth, getCurrentUser);
authRouter.post("/logout", requireSameOrigin, logout);

export default authRouter;
