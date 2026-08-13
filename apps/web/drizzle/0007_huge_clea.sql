CREATE TABLE "candidate_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"experience_years" integer,
	"location" text,
	"education" text,
	"seniority" text,
	"industry" text,
	"expected_salary_min" integer,
	"expected_salary_max" integer,
	"activity_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"summary" text,
	"consent_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seniority" text,
	"education" text,
	"salary_min" integer,
	"salary_max" integer,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"score" integer,
	"evidence" text,
	"risk" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"thresholds" jsonb NOT NULL,
	"active_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"score" integer,
	"band" text,
	"status" text DEFAULT 'generated' NOT NULL,
	"rule_version" integer NOT NULL,
	"input_hash" text,
	"score_status" text DEFAULT 'local_computed' NOT NULL,
	"external_score" integer,
	"external_tier" text,
	"external_score_status" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_profiles" ADD CONSTRAINT "candidate_profiles_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requirements" ADD CONSTRAINT "job_requirements_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_dimensions" ADD CONSTRAINT "match_dimensions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_profiles_candidate_id_unique" ON "candidate_profiles" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_external_id_unique" ON "candidates" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_requirements_job_id_unique" ON "job_requirements" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "match_dimensions_match_idx" ON "match_dimensions" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_rules_version_unique" ON "match_rules" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_job_candidate_rule_unique" ON "matches" USING btree ("job_id","candidate_id","rule_version");--> statement-breakpoint
CREATE INDEX "matches_job_idx" ON "matches" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "matches_status_idx" ON "matches" USING btree ("status");