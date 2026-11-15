CREATE TABLE "tier_limits" (
	"plan" varchar(32) NOT NULL,
	"limit_key" varchar(64) NOT NULL,
	"value" integer,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tier_limits_pkey" PRIMARY KEY("plan","limit_key"),
	CONSTRAINT "tier_limits_plan_check" CHECK ("tier_limits"."plan" in ('self-hosted', 'solo', 'pro', 'team', 'enterprise'))
);

-- Seed the tier limits map (mirrors TIER_LIMIT_SEED in @hitly/core).
-- NULL value means unlimited; operators move caps with UPDATE statements;
-- DO NOTHING keeps a re-run from clobbering overrides. A missing row blocks
-- new use of that capability for that plan (fail-closed).
INSERT INTO "tier_limits" ("plan", "limit_key", "value") VALUES
  ('self-hosted', 'decisions_per_month', NULL),
  ('solo', 'decisions_per_month', 300),
  ('pro', 'decisions_per_month', 2500),
  ('team', 'decisions_per_month', 20000),
  ('enterprise', 'decisions_per_month', NULL),
  ('self-hosted', 'seats', NULL),
  ('solo', 'seats', 2),
  ('pro', 'seats', 3),
  ('team', 'seats', NULL),
  ('enterprise', 'seats', NULL),
  ('self-hosted', 'live_projects', NULL),
  ('solo', 'live_projects', 2),
  ('pro', 'live_projects', 10),
  ('team', 'live_projects', NULL),
  ('enterprise', 'live_projects', NULL),
  ('self-hosted', 'api_keys', NULL),
  ('solo', 'api_keys', 2),
  ('pro', 'api_keys', 10),
  ('team', 'api_keys', NULL),
  ('enterprise', 'api_keys', NULL),
  ('self-hosted', 'callback_endpoints_per_project', NULL),
  ('solo', 'callback_endpoints_per_project', 1),
  ('pro', 'callback_endpoints_per_project', 3),
  ('team', 'callback_endpoints_per_project', NULL),
  ('enterprise', 'callback_endpoints_per_project', NULL),
  ('self-hosted', 'api_rpm', NULL),
  ('solo', 'api_rpm', 60),
  ('pro', 'api_rpm', 300),
  ('team', 'api_rpm', NULL),
  ('enterprise', 'api_rpm', NULL),
  ('self-hosted', 'completed_retention_days', NULL),
  ('solo', 'completed_retention_days', 10),
  ('pro', 'completed_retention_days', 30),
  ('team', 'completed_retention_days', 365),
  ('enterprise', 'completed_retention_days', 1000),
  ('self-hosted', 'audit_retention_days', NULL),
  ('solo', 'audit_retention_days', 30),
  ('pro', 'audit_retention_days', 365),
  ('team', 'audit_retention_days', 365),
  ('enterprise', 'audit_retention_days', 2555)
ON CONFLICT ("plan", "limit_key") DO NOTHING;
