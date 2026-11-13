CREATE TABLE "rate_limit_buckets" (
	"bucket_key" varchar(64) PRIMARY KEY NOT NULL,
	"route" varchar(64) NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_expires_at_idx" ON "rate_limit_buckets" USING btree ("expires_at");