import { MigrationInterface, QueryRunner } from "typeorm";
import {
  getJobTitleMatchKey,
  normalizeCompanyName,
} from "../../modules/applications/application-normalization.js";

export class AddIndexedEmailMatching1795290000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE emails ADD COLUMN matching_pending BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE applications
        ADD COLUMN normalized_company_name TEXT,
        ADD COLUMN normalized_job_title TEXT;
    `);

    let lastId: string | null = null;
    while (true) {
      const applications: Array<{ id: string; company_name: string; job_title: string }> =
        await queryRunner.query(
          `SELECT id, company_name, job_title FROM applications
           WHERE ($1::uuid IS NULL OR id > $1::uuid)
           ORDER BY id LIMIT 1000`,
          [lastId],
        );
      if (!applications.length) {
        break;
      }
      await queryRunner.query(
        `UPDATE applications AS application
         SET normalized_company_name = keys.company, normalized_job_title = keys.title
         FROM unnest($1::uuid[], $2::text[], $3::text[]) AS keys(id, company, title)
         WHERE application.id = keys.id`,
        [
          applications.map((application) => application.id),
          applications.map((application) => normalizeCompanyName(application.company_name)),
          applications.map((application) => getJobTitleMatchKey(application.job_title) || null),
        ],
      );
      lastId = applications[applications.length - 1]!.id;
    }

    // Older extracted IDs may contain any whitespace accepted by String.trim().
    await queryRunner.query(`
      CREATE FUNCTION jobpilot_trim_reference(value TEXT) RETURNS TEXT
      LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
        SELECT btrim(value, U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF')
      $$;

      CREATE INDEX idx_applications_match_company_title ON applications
        (user_id, normalized_company_name, normalized_job_title);
      CREATE INDEX idx_emails_match_pending ON emails (user_id, received_at, id)
        WHERE matching_pending = TRUE;
      CREATE INDEX idx_emails_match_thread ON emails (user_id, gmail_thread_id)
        WHERE application_id IS NOT NULL;
      CREATE INDEX idx_emails_match_job_reference ON emails
        (user_id, jobpilot_trim_reference(extracted_data ->> 'jobReferenceId'))
        WHERE application_id IS NOT NULL;
      CREATE INDEX idx_emails_match_application_reference ON emails
        (user_id, jobpilot_trim_reference(extracted_data ->> 'applicationReferenceId'))
        WHERE application_id IS NOT NULL;
      CREATE INDEX idx_emails_user_application ON emails (user_id, application_id)
        WHERE application_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX idx_emails_user_application;
      DROP INDEX idx_emails_match_application_reference;
      DROP INDEX idx_emails_match_job_reference;
      DROP INDEX idx_emails_match_thread;
      DROP INDEX idx_emails_match_pending;
      DROP INDEX idx_applications_match_company_title;
      DROP FUNCTION jobpilot_trim_reference(TEXT);
      ALTER TABLE applications
        DROP COLUMN normalized_company_name,
        DROP COLUMN normalized_job_title;
      ALTER TABLE emails DROP COLUMN matching_pending;
    `);
  }
}
