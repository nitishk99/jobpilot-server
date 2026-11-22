import { Router } from "express";
import { receiveGmailPushNotification } from "./gmail-webhook.controller.js";

const gmailRouter = Router();

gmailRouter.post("/webhook", receiveGmailPushNotification);

export default gmailRouter;
