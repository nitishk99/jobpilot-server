import { AppDataSource } from "../../config/db.js";
import { ConnectedAccount } from "../../database/entities/ConnectedAccount.js";

export { GmailMessageWithoutBodyError, parseGmailMessage } from "./gmail.parser.js";
export { GmailSyncError } from "./gmail.client.js";
export {
  renewExpiringGmailWatches,
  startGmailWatchForUser,
} from "./gmail.watch.js";
export { type GmailSyncSummary } from "./gmail.sync.shared.js";
export { syncGmailForUser } from "./gmail.sync.recent.js";
export { syncGmailHistoryForUser } from "./gmail.sync.history.js";

export const findGoogleAccountByEmail = async (
  email: string,
): Promise<ConnectedAccount | null> =>
  AppDataSource.getRepository(ConnectedAccount).findOneBy({
    provider: "GOOGLE",
    email: email.toLowerCase(),
  });
