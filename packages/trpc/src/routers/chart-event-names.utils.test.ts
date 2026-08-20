import { describe, expect, it } from 'vitest';
import { buildEventNamesQuery } from './chart-event-names.utils';

describe('buildEventNamesQuery', () => {
  it('sums event counts across unmerged materialized-view parts', () => {
    expect(
      buildEventNamesQuery('regain-app', 'distinct_event_names_mv')
    ).toBe(
      "SELECT name, sum(event_count) as count FROM distinct_event_names_mv WHERE project_id = 'regain-app' GROUP BY name ORDER BY count DESC, name ASC"
    );
  });

  it('escapes the project id', () => {
    expect(
      buildEventNamesQuery("project'id", 'distinct_event_names_mv')
    ).toContain(
      "WHERE project_id = 'project\\'id'"
    );
  });
});
