# Volume columns on the OpenPanel Events page are blank

## Problem
The Events page in the OpenPanel fork shows "—" for every volume column (Volume 1d, 7d, 30d, Trend, % of project, Last seen, and the top volume number). The person asked why event volume is missing.

## Goal
Show event volume on the Events page again, using the data that already exists in ClickHouse.

## Requirements
- Volume columns on the Events page show real numbers again.
- The "volume before drop" number on the Dropped events tab works too.
- Add a regression test so the alias clash can't come back.
- Ship the fix by pushing `feat/mixpanel-event-drop`, which builds the images, then swap them into the OpenPanel containers on jitsu-dashboard1.

## Decisions
- Fix: rename the alias `day` to `day_iso` in the two queries that clash with the ClickHouse 25.12 type rules. The first is in `packages/db/src/services/event-management.service.ts` (around line 159). The second is around line 407 and feeds the Dropped events tab.
- Verify the fix against the live ClickHouse before reporting. Confirmed: the renamed query returns all 30 finished days (25 Oct to 23 Nov).
- Deploy only after the person says yes. They said yes to the fix and deploy.

## Out of scope
- Changing the ClickHouse data pipeline. The data is fine; its hourly job last ran at 09:20 UTC today.
- Changing anything in this repository. Nothing has been changed here; only code was read and read-only queries were run.

## Open questions
- The typecheck shows errors. Still checking whether any are in the changed file or were already there before the change.

## Status
- Built: the rename fix in the OpenPanel fork, plus a regression test.
- Verified: the renamed query returns the 30 days on the live ClickHouse.
- Tested: all 26 tests pass on the runner (third attempt, with pnpm installed another way). The typecheck reports errors, not yet classified as new or pre-existing.
- Not yet shipped: nothing has been pushed or deployed.
- Working on: the typecheck errors, then pushing `feat/mixpanel-event-drop` once they are cleared, then the image swap on jitsu-dashboard1.
