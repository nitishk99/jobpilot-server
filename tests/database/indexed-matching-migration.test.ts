import { describe, expect, it, jest } from "@jest/globals";
import type { QueryRunner } from "typeorm";
import { AddIndexedEmailMatching1795290000000 } from "../../src/database/migrations/AddIndexedEmailMatching1795290000000.js";

describe("indexed email matching migration", () => {
  it("backfills application keys in batches using the matcher normalization", async () => {
    const firstBatch = Array.from({ length: 1_000 }, (_, index) => ({
      id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      company_name: "Acme, Inc.",
      job_title: "Developer - Backend",
    }));
    const lastApplication = {
      id: "00000000-0000-0000-0000-000000001000",
      company_name: "İNFO",
      job_title: "Engineer - Backend",
    };
    const query = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([lastApplication])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined);
    const runner = { query } as Pick<QueryRunner, "query">;

    await new AddIndexedEmailMatching1795290000000().up(runner as QueryRunner);

    expect(query.mock.calls[2]?.[1]).toEqual([
      firstBatch.map(({ id }) => id),
      Array(1_000).fill("acme"),
      Array(1_000).fill("developer"),
    ]);
    expect(query.mock.calls[3]?.[1]).toEqual([firstBatch[999]!.id]);
    expect(query.mock.calls[4]?.[1]).toEqual([
      [lastApplication.id],
      ["i nfo"],
      ["engineer"],
    ]);
    expect(query.mock.calls[5]?.[1]).toEqual([lastApplication.id]);
  });
});
