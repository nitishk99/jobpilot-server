import { describe, expect, it } from "@jest/globals";
import {
  getAllowedClientOrigins,
  getClientOrigin,
} from "../../src/config/env.js";

describe("client origin configuration", () => {
  it("uses the client URL origin and includes configured additional origins", () => {
    const env = {
      CLIENT_URL: "https://client.example/app",
      ALLOWED_CLIENT_ORIGINS: "https://admin.example, https://preview.example",
    };

    expect(getClientOrigin(env)).toBe("https://client.example");
    expect(getAllowedClientOrigins(env)).toEqual([
      "https://client.example",
      "https://admin.example",
      "https://preview.example",
    ]);
  });

  it.each([
    ["path", "https://client.example/app"],
    ["query", "https://client.example?mode=test"],
    ["unsupported protocol", "ftp://client.example"],
    ["empty entry", "https://client.example,"],
  ])("rejects malformed allowlist entries (%s)", (_case, origin) => {
    expect(() =>
      getAllowedClientOrigins({
        CLIENT_URL: "http://localhost:5173",
        ALLOWED_CLIENT_ORIGINS: origin,
      }),
    ).toThrow();
  });
});
