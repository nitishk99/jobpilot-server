import { MigrationInterface, QueryRunner } from "typeorm";

export class AddGmailWatchState1795120000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE connected_accounts
        ADD COLUMN gmail_history_id VARCHAR(100),
        ADD COLUMN gmail_watch_expires_at TIMESTAMPTZ,
        ADD COLUMN gmail_initial_sync_completed BOOLEAN NOT NULL DEFAULT FALSE;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE connected_accounts
        DROP COLUMN gmail_initial_sync_completed,
        DROP COLUMN gmail_watch_expires_at,
        DROP COLUMN gmail_history_id;
    `);
  }
}
