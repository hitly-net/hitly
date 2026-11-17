CREATE TABLE "support_requests" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"workspace_id" varchar(36),
	"type" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_requests_status_check" CHECK ("support_requests"."status" in ('open', 'fulfilled', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_requests_user_id_idx" ON "support_requests" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_requests_open_user_type_idx" ON "support_requests" USING btree ("user_id","type") WHERE "support_requests"."status" = 'open';