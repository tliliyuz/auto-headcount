CREATE TYPE "public"."connection_environment" AS ENUM('development', 'test', 'production');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('disabled', 'active', 'error');--> statement-breakpoint
CREATE TYPE "public"."raw_record_status" AS ENUM('captured', 'normalized', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_connection_id" uuid NOT NULL,
	"raw_record_id" uuid,
	"external_id" text NOT NULL,
	"mapping_version" text NOT NULL,
	"title" text NOT NULL,
	"company_name" text NOT NULL,
	"category" text NOT NULL,
	"city" text NOT NULL,
	"detailed_location" text,
	"salary_min" integer,
	"salary_max" integer,
	"status" text NOT NULL,
	"published_at" timestamp with time zone,
	"days_without_recommendation" integer NOT NULL,
	"valid_recommendation_count" integer,
	"eligibility_evidence" jsonb NOT NULL,
	"portal_url" text NOT NULL,
	"source_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"source_connection_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"payload_ciphertext" bytea NOT NULL,
	"payload_nonce" bytea NOT NULL,
	"key_version" text NOT NULL,
	"payload_hash" text NOT NULL,
	"processing_status" "raw_record_status" DEFAULT 'captured' NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"environment" "connection_environment" NOT NULL,
	"status" "connection_status" DEFAULT 'disabled' NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_connection_id" uuid NOT NULL,
	"sync_type" text NOT NULL,
	"cursor" text,
	"status" "sync_run_status" DEFAULT 'pending' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_connection_id_source_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."source_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_raw_record_id_raw_records_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "public"."raw_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_records" ADD CONSTRAINT "raw_records_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_records" ADD CONSTRAINT "raw_records_source_connection_id_source_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."source_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_source_connection_id_source_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."source_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_connection_id_external_id_unique" ON "jobs" USING btree ("source_connection_id","external_id");--> statement-breakpoint
CREATE INDEX "jobs_under_served_idx" ON "jobs" USING btree ("status","days_without_recommendation");--> statement-breakpoint
CREATE INDEX "jobs_raw_record_idx" ON "jobs" USING btree ("raw_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_records_source_external_hash_unique" ON "raw_records" USING btree ("source_connection_id","external_id","payload_hash");--> statement-breakpoint
CREATE INDEX "raw_records_sync_run_idx" ON "raw_records" USING btree ("sync_run_id");--> statement-breakpoint
CREATE INDEX "raw_records_retention_idx" ON "raw_records" USING btree ("processing_status","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_connections_provider_environment_unique" ON "source_connections" USING btree ("provider","environment");--> statement-breakpoint
CREATE INDEX "sync_runs_source_created_idx" ON "sync_runs" USING btree ("source_connection_id","created_at");--> statement-breakpoint
CREATE INDEX "sync_runs_status_idx" ON "sync_runs" USING btree ("status");
