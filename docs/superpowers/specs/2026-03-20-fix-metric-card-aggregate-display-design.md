# Fix Metric Card Aggregate Display

## Problem

When a user selects any segment other than "Unique users" (e.g., "All events", "Sum of property", "Average of property"), the metric card's primary number still shows unique user count instead of the value matching the selected segment.

**Example:** User selects "Sum of property: value_inr" for "Server: Purchase" events. The metric card shows 242 (unique users) instead of 50,828 (sum of value_inr).

## Root Cause

The `total_count` subquery in `chart.service.ts` always computes `uniq(profile_id)` regardless of the selected segment. This value flows through the pipeline unchanged:

1. **SQL** (`chart.service.ts` lines 306-341): `total_count` = `uniq(profile_id)` always
2. **Grouping** (`group-by-labels.ts`): passes `total_count` through
3. **Formatting** (`format.ts` line 60): `metrics.count = total_count`
4. **Rendering** (`metric/chart.tsx` line 30): hardcodes `metric={'count'}`
5. **Display** (`metric-card.tsx` line 140): shows `serie.metrics['count']` = 242

The `count` field (per-time-bucket aggregate) is computed correctly for all segment types — only `total_count` (the global aggregate used as the big number) is wrong.

## Solution

Modify the `total_count` subquery in `chart.service.ts` to use the same aggregate function as `count`, applied globally (without GROUP BY date).

### File Changed

`packages/db/src/services/chart.service.ts` — lines 306-341

### Aggregate Mapping

| Segment | `count` (per bucket, already correct) | `total_count` (global, to fix) |
|---------|---------------------------------------|-------------------------------|
| `event` (default) | `count(*)` | `count(*)` |
| `user` | `countDistinct(profile_id)` | `uniq(profile_id)` (unchanged) |
| `session` | `countDistinct(session_id)` | `uniq(session_id)` |
| `user_average` | `count(*) / countDistinct(profile_id)` | `count(*) / uniq(profile_id)` |
| `property_sum` | `sum(toFloat64OrNull(prop))` | `sum(toFloat64OrNull(prop))` |
| `property_average` | `avg(toFloat64OrNull(prop))` | `avg(toFloat64OrNull(prop))` |
| `property_max` | `max(toFloat64OrNull(prop))` | `max(toFloat64OrNull(prop))` |
| `property_min` | `min(toFloat64OrNull(prop))` | `min(toFloat64OrNull(prop))` |

Note: `one_event_per_user` returns early before the `total_count` code (line 302), so it needs no handling.

### Implementation

Before the `total_count` subquery block (line 306), determine the aggregate expression based on `event.segment` and `event.property`:

```typescript
// Determine the aggregate expression for total_count based on segment type
let totalCountAggregate = 'uniq(profile_id)'; // default for 'user' segment
switch (event.segment) {
  case 'event':
    totalCountAggregate = 'count(*)';
    break;
  case 'user':
    totalCountAggregate = 'uniq(profile_id)';
    break;
  case 'session':
    totalCountAggregate = 'uniq(session_id)';
    break;
  case 'user_average':
    totalCountAggregate = 'count(*) / uniq(profile_id)';
    break;
  case 'property_sum':
  case 'property_average':
  case 'property_max':
  case 'property_min': {
    const fn = { property_sum: 'sum', property_average: 'avg', property_max: 'max', property_min: 'min' }[event.segment];
    if (event.property) {
      const propKey = getSelectPropertyKey(event.property);
      if (isNumericColumn(event.property)) {
        totalCountAggregate = `${fn}(${propKey})`;
      } else {
        totalCountAggregate = `${fn}(toFloat64OrNull(${propKey}))`;
      }
    }
    break;
  }
}
```

Then replace `uniq(profile_id)` with `${totalCountAggregate}` in both the breakdown and non-breakdown subquery templates.

For property segments, the property IS NOT NULL filter is already propagated automatically via `getWhereWithoutBar()` (which includes `sb.where.property` set at lines 281/284). No manual filter injection needed.

### No Other Changes Needed

- **`group-by-labels.ts`**: Already passes `total_count` through — no change
- **`format.ts`**: Already maps `total_count` to `metrics.count` — no change
- **`metric/chart.tsx`**: Already uses `metric={'count'}` — no change
- **`metric-card.tsx`**: Already renders `serie.metrics[metric]` — no change

## Testing

1. Create a metric chart with segment "All events" → big number should show total event count
2. Change to "Unique users" → big number should show unique user count (unchanged)
3. Change to "Unique sessions" → big number should show unique session count
4. Change to "Sum of property: value_inr" → big number should show total sum of value_inr
5. Change to "Average of property: value_inr" → big number should show global average
6. Verify sparkline tooltip still shows per-day values correctly
7. Test with breakdowns to ensure correlated subquery still works
