-- Custom Cohorts v3, phase 0 step 1: additive schema.
-- The column is added FIRST and the old ones are left in place, so a running
-- deployment that still reads `audience` / `cohortFilter` keeps working while
-- the backfill (step 2) and the new readers (step 4) roll out. The drop is a
-- separate migration applied only after every reader is on `cohortFilters`.
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "cohortFilters" JSONB;
