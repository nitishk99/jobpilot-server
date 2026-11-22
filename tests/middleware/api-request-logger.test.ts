import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { apiRequestLogger } from "../../src/middleware/api-request-logger.js";

describe("API request logger", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("logs request start and completion without query strings or credentials", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const app = express();

    app.use(express.json());
    app.use(apiRequestLogger);
    app.post("/api/example", (req, res) => {
      res.status(201).json({ accepted: Boolean(req.body.value) });
    });

    const response = await request(app)
      .post("/api/example?access_token=secret")
      .set("Cookie", "session=secret")
      .send({ value: "private" });

    expect(response.status).toBe(201);
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
    expect(log).toHaveBeenCalledTimes(2);

    const events = log.mock.calls.map(([entry]) => JSON.parse(String(entry)));
    expect(events[0]).toMatchObject({
      event: "api.request.started",
      method: "POST",
      path: "/api/example",
    });
    expect(events[1]).toMatchObject({
      event: "api.request.completed",
      method: "POST",
      path: "/api/example",
      statusCode: 201,
      durationMs: expect.any(Number),
    });

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("access_token");
    expect(serializedEvents).not.toContain("secret");
    expect(serializedEvents).not.toContain("private");
  });
});
