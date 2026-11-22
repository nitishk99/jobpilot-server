import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmailExtractedData1795098000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE emails
      ADD COLUMN extracted_data JSONB;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE emails
      DROP COLUMN extracted_data;
    `);
  }
}
