CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_key" text NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_audit_entity" ON "audit_events" ("entity_type","entity_key");
CREATE INDEX "idx_audit_timestamp" ON "audit_events" ("created_at");
