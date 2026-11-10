CREATE TABLE "account_security_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"type" varchar(64) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mfa" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"totp_ciphertext" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_used_step" integer,
	"failed_verify_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mfa_challenges" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"cookies_ciphertext" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mfa_recovery_codes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_security_events" ADD CONSTRAINT "account_security_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa_challenges" ADD CONSTRAINT "user_mfa_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa_challenges" ADD CONSTRAINT "user_mfa_challenges_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa_recovery_codes" ADD CONSTRAINT "user_mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_security_events_user_id_idx" ON "account_security_events" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_mfa_user_id_idx" ON "user_mfa" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_mfa_challenges_token_hash_idx" ON "user_mfa_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "user_mfa_challenges_user_id_idx" ON "user_mfa_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_mfa_recovery_codes_hash_idx" ON "user_mfa_recovery_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "user_mfa_recovery_codes_user_id_idx" ON "user_mfa_recovery_codes" USING btree ("user_id");