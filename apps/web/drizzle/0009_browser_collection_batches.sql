CREATE TABLE "browser_collection_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_connection_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"batch_size" integer NOT NULL,
	"max_pages" integer NOT NULL,
	"start_page" integer,
	"start_offset" integer,
	"next_page" integer,
	"next_offset" integer,
	"stop_reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "browser_collection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"page_number" integer NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "browser_collection_batches" ADD CONSTRAINT "browser_collection_batches_source_connection_id_source_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."source_connections"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "browser_collection_items" ADD CONSTRAINT "browser_collection_items_batch_id_browser_collection_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."browser_collection_batches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "browser_collection_batches_route_status_idx" ON "browser_collection_batches" USING btree ("source_connection_id","user_id","device_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "browser_collection_items_batch_external_unique" ON "browser_collection_items" USING btree ("batch_id","external_id");
--> statement-breakpoint
CREATE INDEX "browser_collection_items_batch_status_idx" ON "browser_collection_items" USING btree ("batch_id","status");
