import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockDatabase = {
  getRepository: jest.fn(),
  findOneBy: jest.fn(),
  update: jest.fn(),
};

jest.mock("../../../src/config/db.js", () => ({
  AppDataSource: {
    getRepository: (...args) => mockDatabase.getRepository(...args),
  },
}));

import authRouter from "../../../src/modules/auth/auth.routes.js";
import { requireAuth } from "../../../src/modules/auth/auth.middleware.js";
import { CLIENT_ORIGIN } from "../../../src/config/client-origin.js";
import {
  createOAuthState,
  createSession,
  getSessionCookieOptions,
  hashSessionToken,
  isValidOAuthState,
  isValidSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
} from "../../../src/modules/auth/auth.service.js";

const app = express();
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.all("/test-mutation", requireAuth, (_req, res) => {
  res.sendStatus(204);
});

const userId = "32fb8d25-9ae3-4f4b-a16b-77ce4b589a3f";
const clientOrigin = CLIENT_ORIGIN;
const deployedOrigin = "https://jobpilot-ui.onrender.com";
const savedEnvironment = {
  clientUrl: process.env.CLIENT_URL,
  allowedOrigins: process.env.ALLOWED_CLIENT_ORIGINS,
  nodeEnv: process.env.NODE_ENV,
  sameSite: process.env.SESSION_COOKIE_SAME_SITE,
};

describe("mockDatabase-backed authentication sessions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CLIENT_URL = clientOrigin;
    process.env.ALLOWED_CLIENT_ORIGINS = deployedOrigin;
    process.env.NODE_ENV = "development";
    process.env.SESSION_COOKIE_SAME_SITE = "lax";
    mockDatabase.getRepository.mockReturnValue({
      findOneBy: mockDatabase.findOneBy,
      update: mockDatabase.update,
    });
    mockDatabase.findOneBy.mockResolvedValue(null);
    mockDatabase.update.mockResolvedValue({ affected: 1 });
  });

  afterEach(() => {
    if (savedEnvironment.clientUrl === undefined) {
      delete process.env.CLIENT_URL;
    } else {
      process.env.CLIENT_URL = savedEnvironment.clientUrl;
    }
    if (savedEnvironment.allowedOrigins === undefined) {
      delete process.env.ALLOWED_CLIENT_ORIGINS;
    } else {
      process.env.ALLOWED_CLIENT_ORIGINS = savedEnvironment.allowedOrigins;
    }
    if (savedEnvironment.nodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedEnvironment.nodeEnv;
    }
    if (savedEnvironment.sameSite === undefined) {
      delete process.env.SESSION_COOKIE_SAME_SITE;
    } else {
      process.env.SESSION_COOKIE_SAME_SITE = savedEnvironment.sameSite;
    }
  });

  it("creates random login sessions and hashes only the mockDatabase value", () => {
    const now = 1_000_000;
    const first = createSession(now);
    const second = createSession(now);

    expect(isValidSessionToken(first.token)).toBe(true);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toBe(hashSessionToken(first.token));
    expect(first.tokenHash).not.toBe(first.token);
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.expiresAt.getTime()).toBe(now + SESSION_MAX_AGE_MS);
  });

  it("validates OAuth state values", () => {
    const state = createOAuthState();

    expect(isValidOAuthState(state, state)).toBe(true);
    expect(isValidOAuthState(createOAuthState(), state)).toBe(false);
    expect(isValidOAuthState(undefined, state)).toBe(false);
  });

  it("uses the configured SameSite mode and requires Secure for None", () => {
    expect(
      getSessionCookieOptions({
        NODE_ENV: "development",
        SESSION_COOKIE_SAME_SITE: "lax",
      }),
    ).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
    expect(
      getSessionCookieOptions({
        NODE_ENV: "production",
        SESSION_COOKIE_SAME_SITE: "none",
      }),
    ).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
    });
    expect(
      getSessionCookieOptions({
        NODE_ENV: "development",
        SESSION_COOKIE_SAME_SITE: "none",
      }),
    ).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
    });
    expect(() =>
      getSessionCookieOptions({
        NODE_ENV: "production",
        SESSION_COOKIE_SAME_SITE: "invalid",
      }),
    ).toThrow("SESSION_COOKIE_SAME_SITE must be lax, strict, or none");
  });

  it("rejects a missing session cookie", async () => {
    const response = await request(app).get("/api/auth/me");

    expect(response.status).toBe(401);
    expect(mockDatabase.findOneBy).not.toHaveBeenCalled();
  });

  it("rejects invalid tokens and expired mockDatabase sessions", async () => {
    const invalidResponse = await request(app)
      .get("/api/auth/me")
      .set("Cookie", `${SESSION_COOKIE_NAME}=not-a-session-token`);

    expect(invalidResponse.status).toBe(401);
    expect(mockDatabase.findOneBy).not.toHaveBeenCalled();

    const session = createSession();
    mockDatabase.findOneBy.mockResolvedValueOnce({
      id: userId,
      sessionExpiresAt: new Date(Date.now() - 1_000),
    });

    const expiredResponse = await request(app)
      .get("/api/auth/me")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.token}`);

    expect(expiredResponse.status).toBe(401);
  });

  it("accepts a matching unexpired mockDatabase session", async () => {
    const session = createSession();
    mockDatabase.findOneBy.mockResolvedValue({
      id: userId,
      email: "user@example.com",
      displayName: "JobPilot User",
      profilePicture: null,
      sessionExpiresAt: session.expiresAt,
    });

    const response = await request(app)
      .get("/api/auth/me")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.user.id).toBe(userId);
    expect(mockDatabase.findOneBy).toHaveBeenNthCalledWith(1, {
      sessionTokenHash: hashSessionToken(session.token),
    });
  });

  it("clears the stored session hash and browser cookie on logout", async () => {
    const session = createSession();

    const response = await request(app)
      .post("/api/auth/logout")
      .set("Origin", clientOrigin)
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.token}`);

    expect(response.status).toBe(200);
    expect(mockDatabase.update).toHaveBeenCalledWith(
      { sessionTokenHash: session.tokenHash },
      { sessionTokenHash: null, sessionExpiresAt: null },
    );
    expect(response.headers["set-cookie"][0]).toContain(
      `${SESSION_COOKIE_NAME}=;`,
    );
    expect(response.headers["set-cookie"][0]).toContain("Path=/");
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"][0]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"][0]).not.toContain("Domain=");
  });

  it("rejects state-changing authenticated requests with a missing or foreign Origin", async () => {
    const session = createSession();

    const missingOrigin = await request(app)
      .post("/test-mutation")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.token}`);
    const foreignOrigin = await request(app)
      .post("/test-mutation")
      .set("Origin", "https://attacker.example")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.token}`);

    expect(missingOrigin.status).toBe(403);
    expect(foreignOrigin.status).toBe(403);
    expect(mockDatabase.findOneBy).not.toHaveBeenCalled();
  });

  it("accepts state-changing authenticated requests from the configured Origin", async () => {
    const session = createSession();
    mockDatabase.findOneBy.mockResolvedValue({
      id: userId,
      sessionExpiresAt: session.expiresAt,
    });

    const response = await request(app)
      .post("/test-mutation")
      .set("Origin", clientOrigin)
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.token}`);

    expect(response.status).toBe(204);
    expect(mockDatabase.findOneBy).toHaveBeenCalledWith({
      sessionTokenHash: hashSessionToken(session.token),
    });
  });

  it("accepts state-changing authenticated requests from an allowlisted UI origin", async () => {
    const session = createSession();
    mockDatabase.findOneBy.mockResolvedValue({
      id: userId,
      sessionExpiresAt: session.expiresAt,
    });

    const response = await request(app)
      .post("/test-mutation")
      .set("Origin", deployedOrigin)
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.token}`);

    expect(response.status).toBe(204);
    expect(mockDatabase.findOneBy).toHaveBeenCalledWith({
      sessionTokenHash: hashSessionToken(session.token),
    });
  });

  it("rejects cross-origin POST, PATCH, PUT, and DELETE requests", async () => {
    const session = createSession();
    for (const method of ["post", "patch", "put", "delete"] as const) {
      const response = await request(app)
        [method]("/test-mutation")
        .set("Origin", "https://attacker.example")
        .set("Cookie", `${SESSION_COOKIE_NAME}=${session.token}`);

      expect(response.status).toBe(403);
    }
    expect(mockDatabase.findOneBy).not.toHaveBeenCalled();
  });

  it("does not require a session for OPTIONS preflight", async () => {
    const response = await request(app).options("/test-mutation");

    expect(response.status).toBe(204);
    expect(mockDatabase.findOneBy).not.toHaveBeenCalled();
  });

  it("logs safe /me diagnostics for missing, invalid, expired, valid, and mockDatabase-failure outcomes", async () => {
    const diagnosticLog = jest
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const session = createSession();
    const validUser = {
      id: userId,
      email: "user@example.com",
      displayName: "JobPilot User",
      profilePicture: null,
      sessionExpiresAt: session.expiresAt,
    };
    mockDatabase.findOneBy
      .mockResolvedValueOnce({
        id: userId,
        sessionExpiresAt: new Date(Date.now() - 1_000),
      })
      .mockResolvedValueOnce(validUser)
      .mockResolvedValueOnce(validUser)
      .mockRejectedValueOnce(new Error("mockDatabase unavailable"));

    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/auth/me")
          .set("Cookie", `${SESSION_COOKIE_NAME}=not-a-session-token`)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/auth/me")
          .set("Cookie", `${SESSION_COOKIE_NAME}=${createSession().token}`)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/auth/me")
          .set("Origin", clientOrigin)
          .set("Cookie", `${SESSION_COOKIE_NAME}=${session.token}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get("/api/auth/me")
          .set("Cookie", `${SESSION_COOKIE_NAME}=${createSession().token}`)
      ).status,
    ).toBe(500);

    const diagnostics = diagnosticLog.mock.calls.map(([message]) =>
      JSON.parse(String(message)),
    );
    expect(diagnostics).toEqual([
      { origin: null, cookiePresent: false, outcome: "missing_cookie" },
      { origin: null, cookiePresent: true, outcome: "invalid" },
      { origin: null, cookiePresent: true, outcome: "expired" },
      {
        origin: clientOrigin,
        cookiePresent: true,
        outcome: "valid",
      },
      { origin: null, cookiePresent: true, outcome: "database_failure" },
    ]);
    jest.restoreAllMocks();
  });

  it("rejects logout requests from a foreign Origin", async () => {
    const response = await request(app)
      .post("/api/auth/logout")
      .set("Origin", "https://attacker.example");

    expect(response.status).toBe(403);
    expect(mockDatabase.update).not.toHaveBeenCalled();
  });
});
