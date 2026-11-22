import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mock = {
  syncGmailForUser: jest.fn(),
  syncGmailHistoryForUser: jest.fn(),
  processPendingEmailsForUser: jest.fn(),
};

jest.mock("../../../src/modules/gmail/gmail.service.js", () => ({
  GmailSyncError: class GmailSyncError extends Error {},
  startGmailWatchForUser: jest.fn(),
  syncGmailForUser: (...args) => mock.syncGmailForUser(...args),
  syncGmailHistoryForUser: (...args) =>
    mock.syncGmailHistoryForUser(...args),
}));

jest.mock("../../../src/modules/emails/processor.js", () => ({
  processPendingEmailsForUser: (...args) =>
    mock.processPendingEmailsForUser(...args),
}));

import { runEmailPipelineForUser } from "../../../src/workers/email-pipeline/pipeline.js";

describe("email pipeline", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mock.syncGmailForUser.mockResolvedValue({
      fetched: 2,
      inserted: 2,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
    mock.processPendingEmailsForUser.mockReset()
      .mockResolvedValueOnce({
        processed: 10,
        jobRelated: 7,
        notJobRelated: 3,
        failed: 0,
        remaining: 12,
        aiClassified: 7,
        prefiltered: 3,
      })
      .mockResolvedValueOnce({
        processed: 10,
        jobRelated: 5,
        notJobRelated: 5,
        failed: 0,
        remaining: 2,
        aiClassified: 5,
        prefiltered: 5,
      })
      .mockResolvedValueOnce({
        processed: 2,
        jobRelated: 1,
        notJobRelated: 1,
        failed: 0,
        remaining: 0,
        aiClassified: 1,
        prefiltered: 1,
      });
  });

  it("runs ingestion and drains pending email batches through one pipeline", async () => {
    const result = await runEmailPipelineForUser("user-1", { type: "recent" });

    expect(mock.syncGmailForUser).toHaveBeenCalledWith("user-1");
    expect(mock.processPendingEmailsForUser).toHaveBeenNthCalledWith(
      1,
      "user-1",
    );
    expect(mock.processPendingEmailsForUser).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      sync: {
        fetched: 2,
        inserted: 2,
        updated: 0,
        skipped: 0,
        failed: 0,
      },
      processing: {
        processed: 22,
        jobRelated: 13,
        notJobRelated: 9,
        failed: 0,
        remaining: 0,
        aiClassified: 13,
        prefiltered: 9,
      },
    });
  });

  it("uses the Gmail history cursor for webhook-triggered ingestion", async () => {
    mock.syncGmailHistoryForUser.mockResolvedValueOnce({
      fetched: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
    mock.processPendingEmailsForUser.mockReset().mockResolvedValueOnce({
      processed: 1,
      jobRelated: 1,
      notJobRelated: 0,
      failed: 0,
      remaining: 0,
    });

    const result = await runEmailPipelineForUser("user-1", {
      type: "history",
      historyId: "12345",
    });

    expect(mock.syncGmailHistoryForUser).toHaveBeenCalledWith("user-1", "12345");
    expect(mock.syncGmailForUser).not.toHaveBeenCalled();
    expect(result.processing.processed).toBe(1);
  });

  it("processes saved emails before retrying an incomplete Gmail sync", async () => {
    const syncError = new Error("Gmail sync failed");
    mock.syncGmailHistoryForUser.mockRejectedValueOnce(syncError);
    mock.processPendingEmailsForUser.mockReset().mockResolvedValueOnce({
      processed: 1,
      jobRelated: 1,
      notJobRelated: 0,
      failed: 0,
      remaining: 0,
      aiClassified: 1,
      prefiltered: 0,
    });
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runEmailPipelineForUser("user-1", {
      type: "history",
      historyId: "12345",
    })).rejects.toBe(syncError);
    expect(mock.processPendingEmailsForUser).toHaveBeenCalledWith("user-1");
    warning.mockRestore();
  });

  it("processes saved emails before retrying a partially successful initial sync", async () => {
    mock.syncGmailForUser.mockResolvedValueOnce({
      fetched: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
      failed: 1,
    });
    mock.processPendingEmailsForUser.mockReset().mockResolvedValueOnce({
      processed: 1,
      jobRelated: 1,
      notJobRelated: 0,
      failed: 0,
      remaining: 0,
      aiClassified: 1,
      prefiltered: 0,
    });
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runEmailPipelineForUser("user-1", { type: "recent" }))
      .rejects.toBeInstanceOf(Error);
    expect(mock.processPendingEmailsForUser).toHaveBeenCalledWith("user-1");
    warning.mockRestore();
  });
});
