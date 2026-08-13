CREATE TABLE "candidate_match_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"generator_version" text NOT NULL,
	"redaction_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"source_snapshot_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"display_summary" text NOT NULL,
	"profile" jsonb NOT NULL,
	"redacted_detail_ciphertext" "bytea" NOT NULL,
	"redacted_detail_nonce" "bytea" NOT NULL,
	"key_version" text NOT NULL,
	"redacted_detail_hash" text NOT NULL,
	"redaction_report" jsonb NOT NULL,
	"status" text DEFAULT 'consumable' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_match_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"generator_type" text NOT NULL,
	"generator_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"source_snapshot_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"display_summary" text NOT NULL,
	"requirements" jsonb NOT NULL,
	"status" text DEFAULT 'consumable' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_score_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filter_result_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"adapter_id" text,
	"adapter_version" text,
	"model_id" text,
	"model_revision" text,
	"prompt_version" text,
	"schema_version" text,
	"request_hash" text,
	"response_ciphertext" "bytea",
	"response_nonce" "bytea",
	"key_version" text,
	"output_hash" text,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_filter_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_projection_id" uuid NOT NULL,
	"candidate_projection_id" uuid NOT NULL,
	"filter_rule_version" text NOT NULL,
	"combined_input_hash" text NOT NULL,
	"passed" boolean NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_dimensions" ADD COLUMN "assessable" boolean;--> statement-breakpoint
ALTER TABLE "match_dimensions" ADD COLUMN "confidence" double precision;--> statement-breakpoint
ALTER TABLE "match_dimensions" ADD COLUMN "llm_score_run_id" uuid;--> statement-breakpoint
ALTER TABLE "match_dimensions" ADD COLUMN "output_hash" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "job_projection_id" uuid;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "candidate_projection_id" uuid;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "filter_result_id" uuid;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "llm_score_run_id" uuid;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "aggregation_rule_version" text;--> statement-breakpoint
ALTER TABLE "candidate_match_projections" ADD CONSTRAINT "candidate_match_projections_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_match_projections" ADD CONSTRAINT "job_match_projections_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_score_runs" ADD CONSTRAINT "llm_score_runs_filter_result_id_match_filter_results_id_fk" FOREIGN KEY ("filter_result_id") REFERENCES "public"."match_filter_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_filter_results" ADD CONSTRAINT "match_filter_results_job_projection_id_job_match_projections_id_fk" FOREIGN KEY ("job_projection_id") REFERENCES "public"."job_match_projections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_filter_results" ADD CONSTRAINT "match_filter_results_candidate_projection_id_candidate_match_projections_id_fk" FOREIGN KEY ("candidate_projection_id") REFERENCES "public"."candidate_match_projections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_match_projections_immutable_unique" ON "candidate_match_projections" USING btree ("candidate_id","schema_version","generator_version","redaction_version","input_hash");--> statement-breakpoint
CREATE INDEX "candidate_match_projections_candidate_idx" ON "candidate_match_projections" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_match_projections_immutable_unique" ON "job_match_projections" USING btree ("job_id","schema_version","generator_version","input_hash");--> statement-breakpoint
CREATE INDEX "job_match_projections_job_idx" ON "job_match_projections" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "llm_score_runs_filter_result_idx" ON "llm_score_runs" USING btree ("filter_result_id");--> statement-breakpoint
CREATE INDEX "llm_score_runs_status_idx" ON "llm_score_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "match_filter_results_immutable_unique" ON "match_filter_results" USING btree ("job_projection_id","candidate_projection_id","filter_rule_version");--> statement-breakpoint
CREATE INDEX "match_filter_results_job_proj_idx" ON "match_filter_results" USING btree ("job_projection_id");--> statement-breakpoint
CREATE INDEX "match_filter_results_cand_proj_idx" ON "match_filter_results" USING btree ("candidate_projection_id");--> statement-breakpoint
ALTER TABLE "match_dimensions" ADD CONSTRAINT "match_dimensions_llm_score_run_id_llm_score_runs_id_fk" FOREIGN KEY ("llm_score_run_id") REFERENCES "public"."llm_score_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_job_projection_id_job_match_projections_id_fk" FOREIGN KEY ("job_projection_id") REFERENCES "public"."job_match_projections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_candidate_projection_id_candidate_match_projections_id_fk" FOREIGN KEY ("candidate_projection_id") REFERENCES "public"."candidate_match_projections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_filter_result_id_match_filter_results_id_fk" FOREIGN KEY ("filter_result_id") REFERENCES "public"."match_filter_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_llm_score_run_id_llm_score_runs_id_fk" FOREIGN KEY ("llm_score_run_id") REFERENCES "public"."llm_score_runs"("id") ON DELETE set null ON UPDATE no action;