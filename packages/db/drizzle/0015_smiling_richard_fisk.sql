CREATE TABLE "tier_entitlements" (
	"feature" varchar(64) PRIMARY KEY NOT NULL,
	"min_plan" varchar(32) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tier_entitlements_min_plan_check" CHECK ("tier_entitlements"."min_plan" in ('self-hosted', 'solo', 'pro', 'team', 'enterprise'))
);

-- Seed the tier entitlements map (mirrors TIER_ENTITLEMENT_SEED in @hitly/core).
-- min_plan 'self-hosted' means "all plans". Operators move features between
-- tiers with UPDATE statements; DO NOTHING keeps a re-run from clobbering
-- overrides. Deleting a row denies the feature everywhere (fail-closed).
INSERT INTO "tier_entitlements" ("feature", "min_plan") VALUES
  ('mfa', 'self-hosted'),
  ('sso_google', 'team'),
  ('sso_slack', 'team'),
  ('sso_microsoft', 'enterprise'),
  ('sso_github', 'enterprise'),
  ('sso_saml', 'enterprise'),
  ('sso', 'enterprise'),
  ('project_lifecycle', 'self-hosted')
ON CONFLICT ("feature") DO NOTHING;
