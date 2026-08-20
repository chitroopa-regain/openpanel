import sqlstring from 'sqlstring';

export function buildEventNamesQuery(
  projectId: string,
  eventNamesTable: string
) {
  return `SELECT name, sum(event_count) as count FROM ${eventNamesTable} WHERE project_id = ${sqlstring.escape(projectId)} GROUP BY name ORDER BY count DESC, name ASC`;
}
