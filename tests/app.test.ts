import request from "supertest";
import { describe, expect, it } from "@jest/globals";
import { createApp } from "../src/app.js";

describe("Express app factory", () => {
  it("serves health checks without starting process resources", async () => {
    const response = await request(createApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      message: "JobPilot API is running",
      data: null,
      error: null,
    });
  });

  it("returns the global format for unknown routes", async () => {
    const response = await request(createApp()).get("/missing");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      message: "Route not found",
      data: null,
      error: "Route not found",
    });
  });

  it("returns the global format for malformed JSON", async () => {
    const response = await request(createApp())
      .post("/api/auth/logout")
      .set("Content-Type", "application/json")
      .send("{");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      message: "Invalid JSON request body",
      data: null,
      error: "Invalid JSON request body",
    });
  });
});
