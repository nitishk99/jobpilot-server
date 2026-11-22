import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmailProcessingStatus1795098660000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE emails
        ADD COLUMN processing_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        ADD COLUMN processed_at TIMESTAMPTZ;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE emails
        DROP COLUMN processed_at,
        DROP COLUMN processing_status;
    `);
  }
}
