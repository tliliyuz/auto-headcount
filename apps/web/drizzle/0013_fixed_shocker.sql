CREATE TABLE "company_landing_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_name" text NOT NULL,
	"industry_positioning" text,
	"company_scale" text,
	"benchmarks" text,
	"office_location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "company_landing_profiles_company_name_unique" ON "company_landing_profiles" USING btree ("company_name");