-- Add optional pin timestamp for dashboard list ordering.
ALTER TABLE "dashboards" ADD COLUMN "pinnedAt" TIMESTAMP(3);
