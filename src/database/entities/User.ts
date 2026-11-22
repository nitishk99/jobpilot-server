import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

@Index("uq_users_session_token_hash", ["sessionTokenHash"], { unique: true })
@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "google_sub", type: "varchar", unique: true })
  googleSub!: string;

  @Column({ type: "varchar", unique: true })
  email!: string;

  @Column({ name: "display_name", type: "varchar" })
  displayName!: string;

  @Column({
    name: "profile_picture",
    type: "text",
    nullable: true,
  })
  profilePicture!: string | null;

  @Column({
    name: "session_token_hash",
    type: "varchar",
    length: 64,
    nullable: true,
  })
  sessionTokenHash!: string | null;

  @Column({ name: "session_expires_at", type: "timestamptz", nullable: true })
  sessionExpiresAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}