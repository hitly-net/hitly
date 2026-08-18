CREATE TABLE "evidence_receipts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"approval_id" varchar(36) NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"seq" integer NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"store_uri" text NOT NULL,
	"stored_at" timestamp (3) with time zone NOT NULL,
	"evidence_durable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "evidence_sink_type" varchar(16) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "evidence_sink_config" jsonb;--> statement-breakpoint
ALTER TABLE "evidence_receipts" ADD CONSTRAINT "evidence_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_receipts" ADD CONSTRAINT "evidence_receipts_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_receipts_approval_idx" ON "evidence_receipts" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "evidence_receipts_event_id_idx" ON "evidence_receipts" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "evidence_receipts_workspace_idx" ON "evidence_receipts" USING btree ("workspace_id");