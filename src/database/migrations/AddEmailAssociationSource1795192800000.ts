import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmailAssociationSource1795192800000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE emails
      ADD COLUMN association_source VARCHAR(10) NOT NULL DEFAULT 'AUTO';

      ALTER TABLE emails
      ADD CONSTRAINT chk_emails_association_source
      CHECK (association_source IN ('AUTO', 'MANUAL'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE emails
      DROP CONSTRAINT chk_emails_association_source;

      ALTER TABLE emails
      DROP COLUMN association_source;
    `);
  }
}
