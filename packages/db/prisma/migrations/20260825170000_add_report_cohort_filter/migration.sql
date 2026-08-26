-- Report-level cohort filter. Additive and nullable: older code ignores the
-- column, and reports without one behave exactly as before.
-- Distinct from "audience": ids here are OR-combined, audience ids are ANDed.
ALTER TABLE "reports" ADD COLUMN "cohortFilter" JSONB;
