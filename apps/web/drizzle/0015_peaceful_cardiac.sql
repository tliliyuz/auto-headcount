CREATE TABLE "job_jd_backfills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"source_connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"outcome" text NOT NULL,
	"jd_length" integer DEFAULT 0 NOT NULL,
	"content_hash" text,
	"error_code" text,
	"raw_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_jd_backfills" ADD CONSTRAINT "job_jd_backfills_outcome_check" CHECK ("outcome" IN ('filled','no_provider_jd','failed'));
--> statement-breakpoint
ALTER TABLE "job_jd_backfills" ADD CONSTRAINT "job_jd_backfills_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_jd_backfills" ADD CONSTRAINT "job_jd_backfills_source_connection_id_source_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."source_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_jd_backfills" ADD CONSTRAINT "job_jd_backfills_raw_record_id_raw_records_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "public"."raw_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_jd_backfills_job_created_idx" ON "job_jd_backfills" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "job_jd_backfills_source_created_idx" ON "job_jd_backfills" USING btree ("source_connection_id","created_at");