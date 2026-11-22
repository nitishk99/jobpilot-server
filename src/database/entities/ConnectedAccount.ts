import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";

import { User } from "./User.js";

@Entity("connected_accounts")
export class ConnectedAccount {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "varchar", default: "GOOGLE" })
  provider!: string;

  @Column({ name: "provider_account_id", type: "varchar" })
  providerAccountId!: string;

  @Column({ type: "varchar" })
  email!: string;

  @Column({ name: "access_token", type: "text" })
  accessToken!: string;

  @Column({ name: "refresh_token", type: "text", nullable: true })
  refreshToken!: string | null;

  @Column({ name: "token_expires_at", type: "timestamptz", nullable: true })
  tokenExpiresAt!: Date | null;

  @Column({ type: "text", nullable: true })
  scopes!: string | null;

  @Column({ type: "varchar", default: "ACTIVE" })
  status!: string;

  @Column({ name: "gmail_history_id", type: "varchar", length: 100, nullable: true })
  gmailHistoryId!: string | null;

  @Column({ name: "gmail_watch_expires_at", type: "timestamptz", nullable: true })
  gmailWatchExpiresAt!: Date | null;

  @Column({
    name: "gmail_initial_sync_completed",
    type: "boolean",
    default: false,
  })
  gmailInitialSyncCompleted!: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}