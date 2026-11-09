ALTER TABLE "invites" ADD COLUMN "token_hash" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_idx" ON "invites" USING btree ("token_hash");