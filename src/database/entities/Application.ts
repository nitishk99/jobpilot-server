import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from "typeorm";

import { User } from "./User.js";
import {
  getJobTitleMatchKey,
  normalizeCompanyName,
} from "../../modules/applications/application-normalization.js";

export type ApplicationStatus =
  | "APPLIED"
  | "SCREENING"
  | "INTERVIEW"
  | "OFFER"
  | "REJECTED"
  | "WITHDRAWN";

@Entity("applications")
@Index(["userId", "createdAt"])
export class Application {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "company_name", type: "varchar", length: 255 })
  companyName!: string;

  @Column({ name: "job_title", type: "varchar", length: 255 })
  jobTitle!: string;

  @Column({ name: "normalized_company_name", type: "text", nullable: true })
  normalizedCompanyName!: string | null;

  @Column({ name: "normalized_job_title", type: "text", nullable: true })
  normalizedJobTitle!: string | null;

  // Application writes must use save() so these indexed keys stay in sync.
  @BeforeInsert()
  @BeforeUpdate()
  updateMatchKeys(): void {
    this.normalizedCompanyName = normalizeCompanyName(this.companyName);
    this.normalizedJobTitle = getJobTitleMatchKey(this.jobTitle) || null;
  }

  @Column({ type: "varchar", length: 30, default: "APPLIED" })
  status!: ApplicationStatus;

  @Column({ type: "varchar", length: 100, nullable: true })
  source!: string | null;

  @Column({ name: "applied_at", type: "timestamptz", nullable: true })
  appliedAt!: Date | null;

  @Column({ type: "text", nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
