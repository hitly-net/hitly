CREATE TABLE "pending_email_changes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"pending_email" varchar(255) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_email_changes" ADD CONSTRAINT "pending_email_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_email_changes_user_id_idx" ON "pending_email_changes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_email_changes_token_hash_idx" ON "pending_email_changes" USING btree ("token_hash");