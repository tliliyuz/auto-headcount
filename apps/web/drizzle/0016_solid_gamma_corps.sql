ALTER TABLE "matches" ADD COLUMN "is_superseded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "matches_candidate_idx" ON "matches" USING btree ("candidate_id");