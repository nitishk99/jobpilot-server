import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateEmailsAndInterviewsTables1763540300000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE emails (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        application_id UUID,
        gmail_message_id VARCHAR NOT NULL,
        gmail_thread_id VARCHAR NOT NULL,
        from_email VARCHAR NOT NULL,
        to_email VARCHAR,
        subject VARCHAR,
        body_text TEXT,
        received_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_emails_user
          FOREIGN KEY (user_id)
          REFERENCES users(id)
          ON DELETE CASCADE,
        CONSTRAINT fk_emails_application
          FOREIGN KEY (application_id)
          REFERENCES applications(id)
          ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX uq_emails_user_gmail_message
      ON emails(user_id, gmail_message_id);

      CREATE INDEX idx_emails_user_received_at
      ON emails(user_id, received_at);

      CREATE TABLE interviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        application_id UUID NOT NULL,
        round_name VARCHAR NOT NULL,
        interview_type VARCHAR,
        scheduled_at TIMESTAMPTZ,
        meeting_link VARCHAR,
        status VARCHAR NOT NULL DEFAULT 'SCHEDULED',
        outcome VARCHAR,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_interviews_user
          FOREIGN KEY (user_id)
          REFERENCES users(id)
          ON DELETE CASCADE,
        CONSTRAINT fk_interviews_application
          FOREIGN KEY (application_id)
          REFERENCES applications(id)
          ON DELETE CASCADE
      );

      CREATE INDEX idx_interviews_user_scheduled_at
      ON interviews(user_id, scheduled_at);

      CREATE INDEX idx_interviews_application_id
      ON interviews(application_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE interviews;
      DROP TABLE emails;
    `);
  }
}
