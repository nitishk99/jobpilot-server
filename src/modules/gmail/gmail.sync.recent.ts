import { AppDataSource } from "../../config/db.js";
import { ConnectedAccount } from "../../database/entities/ConnectedAccount.js";
import { createGmailClientForUser } from "./gmail.client.js";
import { type GmailSyncSummary, syncRecentMail } from "./gmail.sync.shared.js";

export const syncGmailForUser = async (
  userId: string,
): Promise<GmailSyncSummary> => {
  const summary = await syncRecentMail(
    await createGmailClientForUser(userId),
    userId,
  );
  if (summary.failed === 0) {
    await AppDataSource.getRepository(ConnectedAccount).update(
      { userId, provider: "GOOGLE" },
      { gmailInitialSyncCompleted: true },
    );
  }
  return summary;
};
