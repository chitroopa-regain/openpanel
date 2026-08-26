-- Custom Cohorts v3 — phase 0 step 2: backfill, in ONE transaction.
--
-- Converts every legacy cohort restriction into `reports.cohortFilters`, and
-- records what could NOT be converted so it can be repaired before the new
-- readers are deployed (step 3's gate). Printing is not a gate; the
-- `cohort_v3_cutover_cleared` table is, because the deploy check asserts every
-- row in it has been handled.
--
-- Composition rule, and the reason this is not a one-liner: the engine today
-- ANDs a legacy `audience` with a report-level `cohortFilter`
-- (engine/fetch.ts). A report carrying BOTH must therefore become TWO rows —
-- audience row first, then the filter row — because rows AND together in the
-- new representation. Overwriting either would change the report's number.
BEGIN;

-- Keyed by (report, reason), NOT by report alone. One report can lose BOTH a
-- multi-cohort audience AND its inline series filters; a report-level primary
-- key silently dropped the second one via ON CONFLICT DO NOTHING, so a human
-- could mark the surviving entry handled and the gate would pass with an
-- unacknowledged population change still in place.
CREATE TABLE IF NOT EXISTS "cohort_v3_cutover_cleared" (
  "reportId"   UUID NOT NULL,
  "reportName" TEXT,
  "reason"     TEXT NOT NULL,
  "removed"    JSONB NOT NULL,
  "handled"    BOOLEAN NOT NULL DEFAULT FALSE,
  "clearedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("reportId", "reason")
);

-- 1. Representable legacy state -> cohortFilters rows.
--    - single-cohort audience  -> {"operator":"in","cohortIds":[x]}  (AND and OR
--      are identical at n = 1, so this conversion is lossless)
--    - singular cohortFilter   -> itself, appended AFTER any audience row
UPDATE "reports" r
SET "cohortFilters" = COALESCE(
      (
        SELECT jsonb_agg(row ORDER BY ord)
        FROM (
          SELECT 0 AS ord,
                 jsonb_build_object(
                   'operator', 'in',
                   'cohortIds', r."audience" -> 'cohortIds'
                 ) AS row
          WHERE jsonb_array_length(COALESCE(r."audience" -> 'cohortIds', '[]'::jsonb)) = 1
          UNION ALL
          SELECT 1 AS ord,
                 jsonb_build_object(
                   'operator', COALESCE(r."cohortFilter" ->> 'operator', 'in'),
                   'cohortIds', r."cohortFilter" -> 'cohortIds'
                 ) AS row
          WHERE jsonb_array_length(COALESCE(r."cohortFilter" -> 'cohortIds', '[]'::jsonb)) > 0
        ) rows
      ),
      r."cohortFilters"
    )
WHERE jsonb_array_length(COALESCE(r."audience" -> 'cohortIds', '[]'::jsonb)) = 1
   OR jsonb_array_length(COALESCE(r."cohortFilter" -> 'cohortIds', '[]'::jsonb)) > 0;

-- 2. Unrepresentable state -> recorded for repair.
--    (a) multi-cohort audience: AND-of-several is not OR-of-several, so there is
--        no lossless row for it.
INSERT INTO "cohort_v3_cutover_cleared" ("reportId", "reportName", "reason", "removed")
SELECT r.id, r.name, 'multi_cohort_audience', r."audience"
FROM "reports" r
WHERE jsonb_array_length(COALESCE(r."audience" -> 'cohortIds', '[]'::jsonb)) > 1
ON CONFLICT ("reportId", "reason") DO NOTHING;

--    (b) per-metric inline filters: the scope itself is gone in v3.
INSERT INTO "cohort_v3_cutover_cleared" ("reportId", "reportName", "reason", "removed")
SELECT r.id, r.name, 'inline_series_filter',
       jsonb_agg(e.value -> 'cohortFilter')
FROM "reports" r
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.events, '[]'::jsonb)) AS e(value)
WHERE e.value ? 'cohortFilter'
  AND jsonb_array_length(COALESCE(e.value -> 'cohortFilter' -> 'cohortIds', '[]'::jsonb)) > 0
GROUP BY r.id, r.name
ON CONFLICT ("reportId", "reason") DO NOTHING;

-- 3. Strip the inline field from every series.
UPDATE "reports" r
SET events = (
  SELECT jsonb_agg(e.value - 'cohortFilter' ORDER BY e.ord)
  FROM jsonb_array_elements(r.events) WITH ORDINALITY AS e(value, ord)
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(COALESCE(r.events, '[]'::jsonb)) AS e(value)
  WHERE e.value ? 'cohortFilter'
);

-- 4. Rebuild references from the RESULT, so delete-protection matches what the
--    reports now actually reference.
DELETE FROM "custom_cohort_references";
INSERT INTO "custom_cohort_references" ("cohortId", "reportId")
SELECT DISTINCT ids.id::uuid, r.id
FROM "reports" r
CROSS JOIN LATERAL (
  SELECT jsonb_array_elements_text(row.value -> 'cohortIds') AS id
  FROM jsonb_array_elements(COALESCE(r."cohortFilters", '[]'::jsonb)) AS row(value)
  UNION
  SELECT jsonb_array_elements_text(COALESCE(r."cohortBreakdown" -> 'cohortIds', '[]'::jsonb))
) ids
WHERE ids.id IS NOT NULL
  -- Ids live in JSON as text while the columns are uuid, so the comparison and
  -- the insert both cast explicitly. The guard is a REAL uuid pattern: a
  -- "36 chars of hex-and-dashes" test accepts '----...' and the cast then
  -- aborts the whole transaction instead of skipping the row.
  AND ids.id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND EXISTS (SELECT 1 FROM "custom_cohorts" c WHERE c.id = ids.id::uuid);

-- 5. Clear the legacy columns. Nothing reads them after step 4's deploy; the
--    columns themselves are dropped by the follow-up migration.
UPDATE "reports" SET "audience" = NULL, "cohortFilter" = NULL
WHERE "audience" IS NOT NULL OR "cohortFilter" IS NOT NULL;

COMMIT;

-- Report what needs hands-on repair before deploying step 4.
SELECT "reportId", "reportName", "reason", "removed"
FROM "cohort_v3_cutover_cleared"
WHERE NOT "handled"
ORDER BY "reason", "reportName";
