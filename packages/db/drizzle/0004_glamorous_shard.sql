ALTER TABLE "approvals" ADD COLUMN "presented_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "presented_by_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN "client" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_presented_by_user_id_users_id_fk" FOREIGN KEY ("presented_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;