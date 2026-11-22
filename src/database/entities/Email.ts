import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";

import { User } from "./User.js";
import { Application } from "./Application.js";

export type EmailCategory =
  | "APPLICATION"
  | "INTERVIEW"
  | "OFFER"
  | "ASSESSMENT"
  | "HR_COMMUNICATION"
  | "OTHER";

export type ApplicationMatchOutcome =
  | "MATCHED"
  | "NEW_APPLICATION"
  | "NEEDS_REVIEW";

export type EmailAssociationSource = "AUTO" | "MANUAL";

interface EmailExtractedData {
  isJobRelated: boolean;
  category: EmailCategory;
  eventType?: string | null;
  companyName?: string | null;
  jobTitle?: string | null;
  jobReferenceId?: string | null;
  applicationReferenceId?: string | null;
  eventDate?: string | null;
  meetingLink?: string | null;
  senderName?: string | null;
  senderOrganization?: string | null;
  summary?: string | null;
  applicationMatchOutcome?: ApplicationMatchOutcome;
  [key: string]: unknown;
}

type EmailProcessingStatus =
  | "PENDING"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED";

@Entity("emails")
@Index("uq_emails_user_gmail_message", ["userId", "gmailMessageId"], {
  unique: true,
})
@Index("idx_emails_user_received_at", ["userId", "receivedAt"])
export class Email {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "application_id", type: "uuid", nullable: true })
  applicationId!: string | null;

  @Column({
    name: "association_source",
    type: "varchar",
    length: 10,
    default: "AUTO",
  })
  associationSource: EmailAssociationSource = "AUTO";

  @ManyToOne(() => Application, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "application_id" })
  application!: Application | null;

  @Column({ name: "gmail_message_id", type: "varchar" })
  gmailMessageId!: string;

  @Column({ name: "gmail_thread_id", type: "varchar" })
  gmailThreadId!: string;

  @Column({ name: "from_email", type: "varchar" })
  fromEmail!: string;

  @Column({ name: "to_email", type: "varchar", nullable: true })
  toEmail!: string | null;

  @Column({ type: "varchar", nullable: true })
  subject!: string | null;

  @Column({ name: "body_text", type: "text", nullable: true })
  bodyText!: string | null;

  @Column({ name: "extracted_data", type: "jsonb", nullable: true })
  extractedData!: EmailExtractedData | null;

  @Column({
    name: "processing_status",
    type: "varchar",
    length: 20,
    default: "PENDING",
  })
  processingStatus!: EmailProcessingStatus;

  @Column({ name: "matching_pending", type: "boolean", default: false })
  matchingPending!: boolean;

  @Column({ name: "processed_at", type: "timestamptz", nullable: true })
  processedAt!: Date | null;

  @Column({ name: "received_at", type: "timestamptz" })
  receivedAt!: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
