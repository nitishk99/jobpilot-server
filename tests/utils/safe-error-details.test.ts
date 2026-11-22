import { describe, expect, it } from "@jest/globals";
import { safeErrorDetails } from "../../src/utils/safe-error-details.js";

describe("safeErrorDetails", () => {
  it("includes useful database diagnostics without query parameters", () => {
    const details = safeErrorDetails({
      name: "QueryFailedError",
      query: "SELECT * FROM connected_accounts WHERE token = $1",
      parameters: ["private-token"],
      driverError: {
        code: "42703",
        message: 'column "gmail_watch_expires_at" does not exist',
        table: "connected_accounts",
        column: "gmail_watch_expires_at",
      },
    });

    expect(details).toEqual({
      errorName: "QueryFailedError",
      databaseCode: "42703",
      databaseMessage: 'column "gmail_watch_expires_at" does not exist',
      table: "connected_accounts",
      column: "gmail_watch_expires_at",
    });
    expect(JSON.stringify(details)).not.toContain("private-token");
    expect(JSON.stringify(details)).not.toContain("SELECT");
  });
});
