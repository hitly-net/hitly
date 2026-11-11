CREATE TABLE "passkeys" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255),
	"public_key" text NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"credential_id" varchar(255) NOT NULL,
	"counter" integer NOT NULL,
	"device_type" varchar(32) NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"aaguid" varchar(36),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkeys_user_id_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkeys_credential_id_idx" ON "passkeys" USING btree ("credential_id");