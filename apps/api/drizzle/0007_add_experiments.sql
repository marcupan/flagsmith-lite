CREATE TABLE IF NOT EXISTS "experiments" (
	"id" serial PRIMARY KEY NOT NULL,
	"flag_key" text NOT NULL,
	"name" text NOT NULL,
	"hypothesis" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"control_percentage" integer DEFAULT 50 NOT NULL,
	"variant_percentage" integer DEFAULT 50 NOT NULL,
	"primary_metric" text NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"conclusion" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "experiments" ADD CONSTRAINT "experiments_flag_key_flags_key_fk" FOREIGN KEY ("flag_key") REFERENCES "flags"("key") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX "idx_experiments_flag_key" ON "experiments" ("flag_key");
CREATE INDEX "idx_experiments_status" ON "experiments" ("status");
