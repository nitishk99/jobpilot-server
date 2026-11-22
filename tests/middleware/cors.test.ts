import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { CLIENT_ORIGIN } from "../../src/config/client-origin.js";
import { corsMiddleware } from "../../src/middleware/cors.js";

const createApp = () => {
  const app = express();
  app.use(corsMiddleware);
  app.post("/api/emails/:id/associate", (_req, res) => {
    res.sendStatus(204);
  });
  return app;
};

describe("credentialed CORS", () => {
  const deployedOrigin = "https://jobpilot-ui.onrender.com";
  const originalAllowedOrigins = process.env.ALLOWED_CLIENT_ORIGINS;

  beforeEach(() => {
    process.env.ALLOWED_CLIENT_ORIGINS = deployedOrigin;
  });

  afterEach(() => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.ALLOWED_CLIENT_ORIGINS;
      return;
    }
    process.env.ALLOWED_CLIENT_ORIGINS = originalAllowedOrigins;
  });

  it("allows the deployed UI origin", async () => {
    const allowed = await request(createApp())
      .options("/api/emails/email-1/associate")
      .set("Origin", deployedOrigin)
      .set("Access-Control-Request-Method", "PATCH")
      .set("Access-Control-Request-Headers", "content-type");

    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(deployedOrigin);
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("allows supported credentialed preflights only from the configured origin", async () => {
    for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
      const allowed = await request(createApp())
        .options("/api/emails/email-1/associate")
        .set("Origin", CLIENT_ORIGIN)
        .set("Access-Control-Request-Method", method)
        .set("Access-Control-Request-Headers", "content-type");

      expect(allowed.status).toBe(204);
      expect(allowed.headers["access-control-allow-origin"]).toBe(
        CLIENT_ORIGIN,
      );
      expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
      expect(allowed.headers["access-control-allow-methods"]).toContain(method);
      expect(allowed.headers.vary).toContain("Origin");
    }

    const denied = await request(createApp())
      .options("/api/emails/email-1/associate")
      .set("Origin", "https://attacker.example")
      .set("Access-Control-Request-Method", "PATCH");

    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
