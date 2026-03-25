-- Add a correlation_id column for end-to-end request tracing.
-- Existing rows get a generated UUID; new rows require it from the application.
ALTER TABLE "webhook_deliveries" ADD COLUMN "correlation_id" text;
UPDATE "webhook_deliveries" SET "correlation_id" = gen_random_uuid()::text WHERE "correlation_id" IS NULL;
ALTER TABLE "webhook_deliveries" ALTER COLUMN "correlation_id" SET NOT NULL;
