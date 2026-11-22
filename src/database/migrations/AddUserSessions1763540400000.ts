import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserSessions1763540400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN session_token_hash VARCHAR(64),
        ADD COLUMN session_expires_at TIMESTAMPTZ;

      CREATE UNIQUE INDEX uq_users_session_token_hash
      ON users(session_token_hash);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX uq_users_session_token_hash;

      ALTER TABLE users
        DROP COLUMN session_expires_at,
        DROP COLUMN session_token_hash;
    `);
  }
}
