ALTER TABLE "account_security_events" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_security_events" ADD COLUMN "user_id_hmac" varchar(64);--> statement-breakpoint
ALTER TABLE "account_security_events" ADD COLUMN "email_hmac" varchar(64);--> statement-breakpoint
ALTER TABLE "account_security_events" ADD COLUMN "ip_truncated" varchar(45);--> statement-breakpoint
ALTER TABLE "account_security_events" ADD COLUMN "retention_expires_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "account_security_events_retention_idx" ON "account_security_events" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE INDEX "decision_records_actor_user_idx" ON "decision_records" USING btree ("actor_user_id");