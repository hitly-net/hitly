CREATE TYPE "public"."approval_status" AS ENUM('pending', 'decided', 'expired', 'failed_resume', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('email', 'slack', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."decision" AS ENUM('accept', 'reject', 'edit', 'respond', 'ignore', 'cancel');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."housekeeping_schedule" AS ENUM('hourly', 'daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."plugin_id" AS ENUM('mastra', 'http', 'langgraph', 'temporal', 'hermes');--> statement-breakpoint
CREATE TYPE "public"."project_role" AS ENUM('admin', 'user', 'reader');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"provider_id" varchar(255) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp (3) with time zone,
	"refresh_token_expires_at" timestamp (3) with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"assigned_user_id" varchar(36),
	"plugin" "plugin_id" NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"action_name" varchar(255) NOT NULL,
	"envelope" jsonb NOT NULL,
	"origin" jsonb NOT NULL,
	"idempotency_key" varchar(255),
	"expires_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_records" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"approval_id" varchar(36) NOT NULL,
	"actor_user_id" varchar(36),
	"decision" "decision" NOT NULL,
	"payload" jsonb NOT NULL,
	"resume_error" text,
	"resume_response" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "housekeeping_jobs" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"schedule" "housekeeping_schedule" NOT NULL,
	"last_started_at" timestamp (3) with time zone,
	"last_finished_at" timestamp (3) with time zone,
	"last_error" text,
	"last_result" jsonb
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" "workspace_role" DEFAULT 'member' NOT NULL,
	"invited_by_user_id" varchar(36),
	"accepted_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"role" "workspace_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_api_keys" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"hashed_key" varchar(255) NOT NULL,
	"prefix" varchar(32) NOT NULL,
	"last_used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_api_keys_hashed_key_unique" UNIQUE("hashed_key")
);
--> statement-breakpoint
CREATE TABLE "project_channels" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"type" "channel_type" NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"approval_id" varchar(36),
	"level" varchar(16) DEFAULT 'info' NOT NULL,
	"type" varchar(64) NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"role" "project_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_rules" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"match" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"plugin" "plugin_id" NOT NULL,
	"credentials" jsonb NOT NULL,
	"default_assignee_user_id" varchar(36),
	"default_sla_minutes" varchar(16) DEFAULT '60' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token" varchar(255) NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"expo_push_token" varchar(255) NOT NULL,
	"platform" "device_platform" NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_devices_expo_push_token_unique" UNIQUE("expo_push_token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"default_sla_minutes" varchar(16) DEFAULT '60' NOT NULL,
	"stripe_customer_id" varchar(255),
	"stripe_subscription_id" varchar(255),
	"plan" varchar(64) DEFAULT 'self-hosted' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_api_keys" ADD CONSTRAINT "project_api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_api_keys" ADD CONSTRAINT "project_api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_channels" ADD CONSTRAINT "project_channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_channels" ADD CONSTRAINT "project_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_rules" ADD CONSTRAINT "project_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_rules" ADD CONSTRAINT "project_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_assignee_user_id_users_id_fk" FOREIGN KEY ("default_assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "approvals_workspace_status_idx" ON "approvals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "approvals_workspace_status_updated_idx" ON "approvals" USING btree ("workspace_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "approvals_project_status_idx" ON "approvals" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "approvals_created_at_idx" ON "approvals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "approvals_project_idempotency_idx" ON "approvals" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "decision_records_approval_idx" ON "decision_records" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "decision_records_workspace_idx" ON "decision_records" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invites_workspace_idx" ON "invites" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invites_email_idx" ON "invites" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_workspace_user_idx" ON "memberships" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "project_api_keys_project_idx" ON "project_api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_api_keys_workspace_idx" ON "project_api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "project_channels_project_idx" ON "project_channels" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_channels_workspace_idx" ON "project_channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "project_events_project_idx" ON "project_events" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_events_approval_idx" ON "project_events" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "project_events_created_at_idx" ON "project_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "project_events_workspace_idx" ON "project_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_memberships_project_user_idx" ON "project_memberships" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_memberships_workspace_idx" ON "project_memberships" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "project_rules_project_idx" ON "project_rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_rules_workspace_idx" ON "project_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "projects_workspace_idx" ON "projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_devices_user_id_idx" ON "user_devices" USING btree ("user_id");