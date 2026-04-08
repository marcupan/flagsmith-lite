CREATE TABLE IF NOT EXISTS "flag_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"flag_id" integer NOT NULL REFERENCES "flags" ("id") ON DELETE CASCADE,
	"environment" text NOT NULL,
	"enabled" boolean NOT NULL,
	"rollout_percentage" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flag_overrides_flag_env_uq" UNIQUE("flag_id","environment")
);

CREATE INDEX "flag_overrides_lookup_idx" ON "flag_overrides" ("flag_id","environment");
