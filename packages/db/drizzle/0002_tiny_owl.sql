CREATE TYPE "public"."otel_protocol" AS ENUM('http/protobuf', 'http/json');--> statement-breakpoint
CREATE TABLE "workspace_otel_endpoints" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"endpoint" text NOT NULL,
	"protocol" "otel_protocol" DEFAULT 'http/protobuf' NOT NULL,
	"headers" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_otel_endpoints" ADD CONSTRAINT "workspace_otel_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_otel_endpoints_workspace_idx" ON "workspace_otel_endpoints" USING btree ("workspace_id");