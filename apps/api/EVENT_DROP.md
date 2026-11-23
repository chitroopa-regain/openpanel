# Event drop (Settings → Events and /manage API): deploy runbook

Drop = event name in the Redis set `op:dropped:<projectId>` + `event_meta.droppedAt`.
Jitsu ingest reads that set every 5 s and stops storing new track/screen events of that name.
**There is no replay:** events sent while an event is dropped are gone. Undrop only lets new
events in again. ClickHouse history from before the drop is never deleted. An event can be
dropped again at any time after an undrop.

## What ships

- Postgres migration `20261123120000_event_drop_audit_views` (additive: two new tables
  `event_drop_audit`, `resource_views`; nothing existing changes).
- api: REST routes under `/manage` and `/api/manage` (below), tRPC `event.managedEvents |
  eventDropAudit | dropEvent | undropEvent | recordView | dropNotes`. `event.clearDroppedEvent` is gone.
- start (dashboard): new Settings → Events page; boards and reports record a view on open and show
  an "event dropped" note (current drop: "no new data after this date"; past gap: "dropped
  <from>–<to>; no data in that window").
- worker: nothing.

## Env (api container)

| Variable | Needed | Effect |
|---|---|---|
| `OPENPANEL_ADMIN_API_TOKEN` | for the REST API | `Authorization: Bearer <token>`; unset = every `/manage/.../events` and `/audit` request is 401. The UI does not need it. |
| `OPENPANEL_SLACK_WEBHOOK_URL` | optional | Slack incoming webhook for #analytics; unset = no post (audit `slackPosted` stays empty). |
| `DASHBOARD_URL` | already set | Base of the board/report links in "Used in" and Slack. |

Never print the token; keep it in the Maker vault / server env only.

## Order

1. Back up nothing extra: the migration only creates tables.
2. Run Prisma migrations (`pnpm migrate:deploy` from the image / migrate job, as for any release).
3. Deploy api (needs the new tables; the new routes 401 until the token is set).
4. Deploy start (the page calls the new tRPC procedures).
5. Set `OPENPANEL_ADMIN_API_TOKEN` and `OPENPANEL_SLACK_WEBHOOK_URL` on the api container, restart api.
6. Volume columns read ClickHouse `event_name_daily` (built by the regainapp rollup job, read with
   `FINAL`). Until it exists the page shows "—" and works otherwise; no deploy order between the two.

## REST API

All need `Authorization: Bearer $OPENPANEL_ADMIN_API_TOKEN`. The routes answer under both
`/manage/...` and `/api/manage/...`. Production (regainapp `server/jitsu/ha_setup/openpanel/nginx.conf`)
only forwards `/trpc/`, `/live/`, `/oauth/` and `/api/` to the api, keeping the path, so from outside use
**`https://openpanel.regainapp.ai/api/manage/...`** (prod HA: `https://openpanel-prod.regainapp.ai/api/manage/...`).

- `GET  /manage/projects/:projectId/events?filter=all|unused|used|dropped|protected|unused_high&q=`
- `POST /manage/projects/:projectId/events/drop` `{name, confirmName, reason?, source:"UI"|"Agent", requestedBy?, chatUrl?}`
  → 400 confirm mismatch / already dropped / bad input, 403 protected, 409 used and no reason
  (`REASON_REQUIRED`), 404 project. `requestedBy` is required when `source` is `Agent`.
- `POST /manage/projects/:projectId/events/undrop` `{name, confirmName, source, requestedBy?, chatUrl?, reason?}`
  → `{name, status: "active", auditId}`. `replay: true` is refused with 400 ("Replay is not
  supported: events sent while dropped are not recovered").
- `GET  /manage/projects/:projectId/audit?limit=`

## Rollback

Redeploy the previous api/start images. The two tables can stay (nothing else reads them).
Events dropped meanwhile stay in the Redis set; undrop them first (or remove the names from
`op:dropped:<projectId>` and clear `event_meta.droppedAt`) if the old UI must show them active.
