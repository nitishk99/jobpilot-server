import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateConnectedAccountsTable1763540100000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE connected_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        user_id UUID NOT NULL,

        provider VARCHAR(50) NOT NULL DEFAULT 'GOOGLE',

        provider_account_id VARCHAR(255) NOT NULL,

        email VARCHAR(255) NOT NULL,

        access_token TEXT NOT NULL,

        refresh_token TEXT,

        token_expires_at TIMESTAMPTZ,

        scopes TEXT,

        status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT fk_connected_accounts_user
          FOREIGN KEY (user_id)
          REFERENCES users(id)
          ON DELETE CASCADE,

        CONSTRAINT uq_connected_account_provider
          UNIQUE (provider, provider_account_id)
      );

      CREATE INDEX idx_connected_accounts_user_id
      ON connected_accounts(user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE connected_accounts;
    `);
  }
}