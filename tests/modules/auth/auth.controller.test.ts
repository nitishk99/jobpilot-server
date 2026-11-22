import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mock = {
  authenticateGoogleCode: jest.fn(),
  clearSession: jest.fn(),
  createOAuthState: jest.fn(),
  createSession: jest.fn(),
  getGoogleAuthorizationUrl: jest.fn(),
  isValidOAuthState: jest.fn(),
  validateOAuthConfiguration: jest.fn(),
  initializeEmailPipelineForUser: jest.fn(),
};

jest.mock("../../../src/config/db.js", () => ({
  AppDataSource: {
    getRepository: jest.fn(),
  },
}));

jest.mock("../../../src/modules/auth/auth.service.js", () => ({
  AuthConfigurationError: class AuthConfigurationError extends Error {},
  authenticateGoogleCode: (...args) =>
    mock.authenticateGoogleCode(...args),
  clearSession: (...args) => mock.clearSession(...args),
  createOAuthState: (...args) => mock.createOAuthState(...args),
  createSession: (...args) => mock.createSession(...args),
  getGoogleAuthorizationUrl: (...args) =>
    mock.getGoogleAuthorizationUrl(...args),
  getSessionCookieOptions: (environment: NodeJS.ProcessEnv = process.env) => ({
    httpOnly: true,
    secure:
      (environment.SESSION_COOKIE_SAME_SITE ?? "lax").toLowerCase() ===
        "none" || environment.NODE_ENV === "production",
    sameSite: (environment.SESSION_COOKIE_SAME_SITE ?? "lax").toLowerCase(),
    path: "/",
  }),
  isValidOAuthState: (...args) => mock.isValidOAuthState(...args),
  findSessionUserId: jest.fn(),
  OAUTH_STATE_COOKIE_NAME: "jobpilot_oauth_state",
  OAUTH_STATE_MAX_AGE_MS: 600_000,
  SESSION_COOKIE_NAME: "jobpilot_session",
  SESSION_MAX_AGE_MS: 604_800_000,
  validateOAuthConfiguration: (...args) =>
    mock.validateOAuthConfiguration(...args),
}));

jest.mock("../../../src/workers/email-pipeline/bootstrap.js", () => ({
  initializeEmailPipelineForUser: (...args) =>
    mock.initializeEmailPipelineForUser(...args),
}));

import authRouter from "../../../src/modules/auth/auth.routes.js";
import { CLIENT_ORIGIN } from "../../../src/config/client-origin.js";

const app = express();
app.use(cookieParser());
app.use("/api/auth", authRouter);

const state = "S".repeat(43);
const sessionToken = "T".repeat(43);
const userId = "32fb8d25-9ae3-4f4b-a16b-77ce4b589a3f";

interface CookieResponse {
  headers: { "set-cookie"?: string[] };
}

const cookie = (response: CookieResponse, name: string) =>
  response.headers["set-cookie"]?.find((value) =>
    value.startsWith(`${name}=`),
  );

describe("Google OAuth cookie and redirect behavior", () => {
  const savedEnvironment = {
    clientUrl: process.env.CLIENT_URL,
    nodeEnv: process.env.NODE_ENV,
    sameSite: process.env.SESSION_COOKIE_SAME_SITE,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CLIENT_URL = CLIENT_ORIGIN;
    process.env.NODE_ENV = "production";
    process.env.SESSION_COOKIE_SAME_SITE = "none";
    mock.createOAuthState.mockReturnValue(state);
    mock.createSession.mockReturnValue({
      token: sessionToken,
      tokenHash: "a".repeat(64),
      expiresAt: new Date("2026-11-21T00:00:00.000Z"),
    });
    mock.isValidOAuthState.mockImplementation(
      (received: string, stored: string) => received === state && stored === state,
    );
    mock.authenticateGoogleCode.mockResolvedValue(userId);
    mock.initializeEmailPipelineForUser.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (savedEnvironment.clientUrl === undefined) {
      delete process.env.CLIENT_URL;
    } else {
      process.env.CLIENT_URL = savedEnvironment.clientUrl;
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

  it("sets a cross-site session cookie and redirects to the configured client", async () => {
    const response = await request(app)
      .get("/api/auth/google/callback")
      .query({ code: "authorization-code", state })
      .set("Cookie", `jobpilot_oauth_state=${state}`);

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(CLIENT_ORIGIN);
    expect(mock.authenticateGoogleCode).toHaveBeenCalledWith(
      "authorization-code",
      "a".repeat(64),
      new Date("2026-11-21T00:00:00.000Z"),
    );

    const sessionCookie = cookie(response, "jobpilot_session");
    expect(sessionCookie).toContain(`jobpilot_session=${sessionToken}`);
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=None");
    expect(sessionCookie).toContain("Path=/");
    expect(sessionCookie).toContain("Max-Age=604800");
    expect(sessionCookie).not.toContain("Domain=");

    const stateCookie = cookie(response, "jobpilot_oauth_state");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("Path=/api/auth");
  });

  it("keeps the OAuth state cookie Lax when starting authorization", async () => {
    mock.getGoogleAuthorizationUrl.mockReturnValue(
      "https://accounts.google.com/o/oauth2/auth",
    );

    const response = await request(app).get("/api/auth/google");

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(
      "https://accounts.google.com/o/oauth2/auth",
    );
    const stateCookie = cookie(response, "jobpilot_oauth_state");
    expect(stateCookie).toContain(`jobpilot_oauth_state=${state}`);
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("Secure");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("Path=/api/auth");
  });

  it("uses the current environment when setting the OAuth state cookie", async () => {
    process.env.NODE_ENV = "development";
    mock.getGoogleAuthorizationUrl.mockReturnValue(
      "https://accounts.google.com/o/oauth2/auth",
    );

    const response = await request(app).get("/api/auth/google");

    expect(response.status).toBe(302);
    expect(cookie(response, "jobpilot_oauth_state")).not.toContain("Secure");
  });

  it("rejects an invalid OAuth state without setting a session or redirecting", async () => {
    mock.isValidOAuthState.mockReturnValue(false);

    const response = await request(app)
      .get("/api/auth/google/callback")
      .query({ code: "authorization-code", state })
      .set("Cookie", `jobpilot_oauth_state=${state}`);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid OAuth state");
    expect(response.headers.location).toBeUndefined();
    expect(cookie(response, "jobpilot_session")).toBeUndefined();
    expect(mock.authenticateGoogleCode).not.toHaveBeenCalled();
  });

  it("clears the session cookie with the same cross-site attributes", async () => {
    const response = await request(app)
      .post("/api/auth/logout")
      .set("Origin", CLIENT_ORIGIN)
      .set("Cookie", `jobpilot_session=${sessionToken}`);

    expect(response.status).toBe(200);
    expect(mock.clearSession).toHaveBeenCalledWith(sessionToken);
    const sessionCookie = cookie(response, "jobpilot_session");
    expect(sessionCookie).toContain("jobpilot_session=;");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=None");
    expect(sessionCookie).toContain("Path=/");
    expect(sessionCookie).not.toContain("Domain=");
  });
});
