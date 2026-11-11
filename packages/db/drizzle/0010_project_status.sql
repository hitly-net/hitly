CREATE TYPE "public"."project_status" AS ENUM('live', 'paused', 'archived');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "status" "project_status" DEFAULT 'live' NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_workspace_status_idx" ON "projects" USING btree ("workspace_id","status");