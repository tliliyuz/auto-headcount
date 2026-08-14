CREATE TYPE "public"."intent_option" AS ENUM('A', 'B', 'C', 'opt_out');--> statement-breakpoint
CREATE TYPE "public"."notify_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "intent_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"landing_link_id" uuid NOT NULL,
	"option" "intent_option" NOT NULL,
	"contact_ciphertext" "bytea" NOT NULL,
	"contact_nonce" "bytea" NOT NULL,
	"contact_key_version" text NOT NULL,
	"contact_phone_hmac" text,
	"contact_email_hmac" text,
	"consent_snapshot" jsonb NOT NULL,
	"notify_status" "notify_status" DEFAULT 'pending' NOT NULL,
	"notify_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landing_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intent_responses" ADD CONSTRAINT "intent_responses_landing_link_id_landing_links_id_fk" FOREIGN KEY ("landing_link_id") REFERENCES "public"."landing_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_links" ADD CONSTRAINT "landing_links_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_links" ADD CONSTRAINT "landing_links_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_links" ADD CONSTRAINT "landing_links_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_links" ADD CONSTRAINT "landing_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intent_responses_landing_link_unique" ON "intent_responses" USING btree ("landing_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "landing_links_token_hash_unique" ON "landing_links" USING btree ("token_hash");