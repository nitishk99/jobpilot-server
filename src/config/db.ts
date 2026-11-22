import "reflect-metadata";
import { DataSource } from "typeorm";
import { User } from "../database/entities/User.js";
import { ConnectedAccount } from "../database/entities/ConnectedAccount.js";
import { Application } from "../database/entities/Application.js";
import { Email } from "../database/entities/Email.js";
import { CreateUsersTable1763540000000 } from "../database/migrations/CreateUsersTable1763540000000.js";
import { CreateConnectedAccountsTable1763540100000 } from "../database/migrations/CreateConnectedAccountsTable1763540100000.js";
import { CreateApplicationsTable1763540200000 } from "../database/migrations/CreateApplicationsTable1763540200000.js";
import { CreateEmailsAndInterviewsTables1763540300000 } from "../database/migrations/CreateEmailsAndInterviewsTables1763540300000.js";
import { AddUserSessions1763540400000 } from "../database/migrations/AddUserSessions1763540400000.js";
import { AddEmailExtractedData1795098000000 } from "../database/migrations/AddEmailExtractedData1795098000000.js";
import { AddEmailProcessingStatus1795098660000 } from "../database/migrations/AddEmailProcessingStatus1795098660000.js";
import { AddGmailWatchState1795120000000 } from "../database/migrations/AddGmailWatchState1795120000000.js";
import { AddEmailAssociationSource1795192800000 } from "../database/migrations/AddEmailAssociationSource1795192800000.js";
import { AddIndexedEmailMatching1795290000000 } from "../database/migrations/AddIndexedEmailMatching1795290000000.js";
import { safeErrorDetails } from "../utils/safe-error-details.js";
import {
  getDatabaseUrl,
  getDatabaseUrlIfConfigured,
} from "./env.js";

export const AppDataSource = new DataSource({
  type: "postgres",
  url: getDatabaseUrlIfConfigured(),
  ssl: {
    rejectUnauthorized: false,
  },
  synchronize: false,
  logging: false,
  entities: [User, ConnectedAccount, Application, Email],
  migrations: [
    CreateUsersTable1763540000000,
    CreateConnectedAccountsTable1763540100000,
    CreateApplicationsTable1763540200000,
    CreateEmailsAndInterviewsTables1763540300000,
    AddUserSessions1763540400000,
    AddEmailExtractedData1795098000000,
    AddEmailProcessingStatus1795098660000,
    AddGmailWatchState1795120000000,
    AddEmailAssociationSource1795192800000,
    AddIndexedEmailMatching1795290000000,
  ],
});

export const connectDB = async () => {
  try {
    getDatabaseUrl();
    await AppDataSource.initialize();
    console.log("Database connected successfully");
  } catch (error) {
    console.error("Database connection failed:", safeErrorDetails(error));
    throw error;
  }
};