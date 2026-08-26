-- Custom Cohorts v3 — phase 0 deploy gate. Every check must return 0 rows.
-- Run AFTER cohort_v3_cutover.sql and AFTER every cleared report has been
-- repaired (re-picked as cohortFilters) or explicitly retired.
--
-- The gate asserts what the APPLICATION will require, not merely that the
-- columns are gone: a row that parses as JSON but violates the zod schema, or
-- names a cohort that does not exist, fails at query time with the feature
-- looking "migrated". Anything this file silently tolerates is a report that
-- breaks after deploy.

WITH filter_rows AS (
  SELECT r.id, r.name,
         row.value AS row_value,
         jsonb_array_length(COALESCE(r."cohortFilters", '[]'::jsonb)) AS row_count
  FROM "reports" r
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r."cohortFilters", '[]'::jsonb)) AS row(value)
),
referenced_ids AS (
  SELECT r.id AS report_id, r.name AS report_name, r."projectId" AS project_id, ids.id AS cohort_id
  FROM "reports" r
  CROSS JOIN LATERAL (
    SELECT jsonb_array_elements_text(row.value -> 'cohortIds') AS id
    FROM jsonb_array_elements(COALESCE(r."cohortFilters", '[]'::jsonb)) AS row(value)
    UNION
    SELECT jsonb_array_elements_text(COALESCE(r."cohortBreakdown" -> 'cohortIds', '[]'::jsonb))
  ) ids
)
-- 1. No legacy state survives.
SELECT 'legacy_column_still_set' AS check, id::text AS id, name FROM "reports"
WHERE "audience" IS NOT NULL OR "cohortFilter" IS NOT NULL
UNION ALL
-- 2. No inline series filter survives.
SELECT 'inline_filter_still_set', r.id::text, r.name FROM "reports" r
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(COALESCE(r.events, '[]'::jsonb)) AS e(value)
  WHERE e.value ? 'cohortFilter'
)
UNION ALL
-- 3. Every cleared restriction has been handled by a human, per (report, reason).
SELECT 'cleared_report_unhandled', "reportId"::text, "reportName" || ' [' || "reason" || ']'
FROM "cohort_v3_cutover_cleared" WHERE NOT "handled"
UNION ALL
-- 4. Stored rows satisfy the SHAPE the zod schema enforces.
SELECT 'malformed_cohort_filters', r.id::text, r.name FROM "reports" r
WHERE r."cohortFilters" IS NOT NULL AND jsonb_typeof(r."cohortFilters") <> 'array'
UNION ALL
SELECT DISTINCT 'row_not_an_object_or_bad_operator', f.id::text, f.name FROM filter_rows f
WHERE jsonb_typeof(f.row_value) <> 'object'
   OR COALESCE(f.row_value ->> 'operator', 'in') NOT IN ('in', 'not_in')
UNION ALL
SELECT DISTINCT 'row_cohort_ids_not_a_nonempty_array', f.id::text, f.name FROM filter_rows f
WHERE jsonb_typeof(f.row_value -> 'cohortIds') <> 'array'
   OR jsonb_array_length(f.row_value -> 'cohortIds') = 0
UNION ALL
-- 5. The schema's own limits: max 5 rows, max 5 ids per row, no duplicate ids
--    within a row. A report over the limit is rejected by zod on the next save
--    and by the query input on the next read.
SELECT DISTINCT 'too_many_filter_rows', f.id::text, f.name FROM filter_rows f WHERE f.row_count > 5
UNION ALL
SELECT DISTINCT 'too_many_cohort_ids_in_row', f.id::text, f.name FROM filter_rows f
WHERE jsonb_typeof(f.row_value -> 'cohortIds') = 'array'
  AND jsonb_array_length(f.row_value -> 'cohortIds') > 5
UNION ALL
SELECT DISTINCT 'duplicate_cohort_ids_in_row', f.id::text, f.name FROM filter_rows f
WHERE jsonb_typeof(f.row_value -> 'cohortIds') = 'array'
  AND jsonb_array_length(f.row_value -> 'cohortIds') <> (
    SELECT count(DISTINCT v) FROM jsonb_array_elements_text(f.row_value -> 'cohortIds') v
  )
UNION ALL
-- 6. Every referenced id is a real, same-project cohort. Previously these rows
--    were FILTERED OUT before comparison, so a report pointing at a deleted or
--    foreign cohort passed the gate and then failed when the app resolved it.
SELECT 'cohort_id_not_a_uuid', ri.report_id::text, ri.report_name FROM referenced_ids ri
WHERE ri.cohort_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
UNION ALL
SELECT 'cohort_missing_or_foreign_project', ri.report_id::text, ri.report_name FROM referenced_ids ri
WHERE ri.cohort_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND NOT EXISTS (
    SELECT 1 FROM "custom_cohorts" c
    WHERE c.id = ri.cohort_id::uuid AND c."projectId" = ri.project_id
  )
UNION ALL
-- 7. custom_cohort_references matches what the reports reference, both
--    directions. Compared over ALL referenced ids — nothing is filtered away
--    first, or the check would excuse exactly the broken rows check 6 catches.
SELECT 'reference_mismatch', r.id::text, r.name FROM "reports" r
WHERE (
  SELECT COALESCE(array_agg(DISTINCT ri.cohort_id ORDER BY ri.cohort_id), '{}')
  FROM referenced_ids ri WHERE ri.report_id = r.id
) IS DISTINCT FROM (
  SELECT COALESCE(array_agg(DISTINCT ref."cohortId"::text ORDER BY ref."cohortId"::text), '{}')
  FROM "custom_cohort_references" ref WHERE ref."reportId" = r.id
);
