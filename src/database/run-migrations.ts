import "dotenv/config";
import { AppDataSource } from "../config/db.js";
import { getDatabaseUrl } from "../config/env.js";
import { safeErrorDetails } from "../utils/safe-error-details.js";

const runMigrations = async () => {
  try {
    getDatabaseUrl();
    await AppDataSource.initialize();

    console.log("Database connected successfully");

    const migrations = await AppDataSource.runMigrations();

    console.log(`Migrations executed: ${migrations.length}`);
  } catch (error) {
    console.error("Migration failed:", safeErrorDetails(error));
    process.exitCode = 1;
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
};

runMigrations();