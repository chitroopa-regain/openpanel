# Tech Debt

## `has_profile` breakdown ambiguity with trait CTEs

**File:** `packages/db/src/services/chart.service.ts:186`

The `has_profile` breakdown expression uses unqualified `profile_id`:
```ts
return `if(profile_id != device_id, 'true', 'false')`;
```

When a chart combines a `has_profile` breakdown with a trait breakdown (e.g., `profile.properties.show_monthly_back_press_offer`), the trait CTE JOIN introduces a second `profile_id` column, making the reference ambiguous and causing a ClickHouse `AMBIGUOUS_IDENTIFIER` error.

**Fix:** Qualify as `e.profile_id` when trait CTEs are present, or always qualify it unconditionally since events is always aliased `e`.

**Impact:** Only affects charts that combine `has_profile` breakdown with a user-trait breakdown — rare but possible.
