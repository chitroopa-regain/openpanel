import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/utils/cn';
import { BookmarkIcon, LockIcon } from 'lucide-react';
import { useState } from 'react';
import {
  dateTime,
  groupUsedIn,
  type ManagedEvent,
  places,
  shortDate,
} from './format';

const MIN_REASON_LENGTH = 3;

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge className="border-transparent text-[12px] bg-emerald-500/15 text-emerald-500">
      active
    </Badge>
  ) : (
    <Badge className="border-transparent text-[12px] bg-def-200 text-muted-foreground">
      idle
    </Badge>
  );
}

function otherUseLabel(type: ManagedEvent['otherUses'][number]['type']) {
  return type === 'cohort' ? 'Cohort' : 'Custom event';
}

export function UsedInSheet({
  event,
  onClose,
}: {
  event: ManagedEvent | null;
  onClose: () => void;
}) {
  const groups = event ? groupUsedIn(event.usedIn) : [];
  const reportCount = event
    ? event.usedIn.filter((item) => item.type === 'report').length
    : 0;
  return (
    <Sheet open={event !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        onClose={onClose}
        className="w-full leading-normal sm:max-w-[560px]"
        aria-describedby={undefined}
      >
        {event && (
          <div className="space-y-5">
            <div className="pr-8">
              <div className="text-sm text-muted-foreground">
                Used in {places(event.usageCount)}
              </div>
              <h2 className="break-words font-mono text-lg font-semibold">
                {event.name}
              </h2>
            </div>

            <section>
              <div className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
                Boards and reports ({reportCount} report
                {reportCount === 1 ? '' : 's'})
              </div>
              {groups.length === 0 ? (
                <div className="text-sm text-muted-foreground">None</div>
              ) : (
                <table className="w-full leading-normal text-sm">
                  <thead>
                    <tr className="border-b text-left text-sm text-muted-foreground">
                      <th className="py-2 pr-2 font-medium">Name</th>
                      <th className="py-2 pr-2 font-medium">Type</th>
                      <th className="py-2 pr-2 font-medium">Last edited</th>
                      <th className="py-2 pr-2 font-medium">Last viewed</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map(({ board, reports }) => (
                      <BoardRows
                        key={board.id}
                        board={board}
                        reports={reports}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {event.otherUses.length > 0 && (
              <section>
                <div className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
                  Also used by
                </div>
                <table className="w-full leading-normal text-sm">
                  <tbody>
                    {event.otherUses.map((use) => (
                      <tr
                        key={`${use.type}:${use.id}`}
                        className="border-b last:border-0"
                      >
                        <td className="py-2 pr-2">{use.name}</td>
                        <td className="whitespace-nowrap py-2 text-right text-muted-foreground">
                          {otherUseLabel(use.type)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <p className="text-sm text-muted-foreground">
              Idle = board not viewed in 30 days. "Last viewed" is new tracking,
              so it is empty (—) until recording starts; until then active/idle
              uses last edited.
            </p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function BoardRows({
  board,
  reports,
}: {
  board: ManagedEvent['usedIn'][number];
  reports: ManagedEvent['usedIn'];
}) {
  return (
    <>
      <tr className="border-b align-top">
        <td className="py-2 pr-2">
          <a href={board.url} className="text-blue-500 hover:underline">
            {board.name}
          </a>
        </td>
        <td className="py-2 pr-2">Board</td>
        <td className="whitespace-nowrap py-2 pr-2 tabular-nums">
          {shortDate(board.lastEditedAt)}
        </td>
        <td className="whitespace-nowrap py-2 pr-2 tabular-nums">
          {shortDate(board.lastViewedAt)}
        </td>
        <td className="py-2 text-right">
          <ActiveBadge active={board.active} />
        </td>
      </tr>
      {reports.map((report) => (
        <tr key={report.id} className="border-b align-top">
          <td className="py-2 pr-2 pl-4">
            <a href={report.url} className="text-blue-500 hover:underline">
              {report.name}
            </a>
          </td>
          <td className="py-2 pr-2">Report</td>
          <td className="whitespace-nowrap py-2 pr-2 tabular-nums">
            {shortDate(report.lastEditedAt)}
          </td>
          <td className="whitespace-nowrap py-2 pr-2 tabular-nums">
            {report.lastViewedAt ? shortDate(report.lastViewedAt) : ''}
          </td>
          <td />
        </tr>
      ))}
    </>
  );
}

export function DropDialog({
  event,
  isPending,
  slackConfigured,
  onCancel,
  onKeepInstead,
  onConfirm,
}: {
  event: ManagedEvent;
  isPending: boolean;
  /** OPENPANEL_SLACK_WEBHOOK_URL is set on the api. */
  slackConfigured: boolean;
  onCancel: () => void;
  /** Opens the Keep dialog instead (events used outside OpenPanel). */
  onKeepInstead: () => void;
  onConfirm: (input: { confirmName: string; reason?: string }) => void;
}) {
  const [confirmName, setConfirmName] = useState('');
  const [reason, setReason] = useState('');
  const locked = event.status === 'protected';
  const anyway = event.usageCount > 0;
  const groups = groupUsedIn(event.usedIn);
  const activeBoards = groups.filter((g) => g.board.active);
  const reportCount = event.usedIn.filter((i) => i.type === 'report').length;
  const otherCount = event.otherUses.length;
  const canSubmit =
    confirmName === event.name &&
    (!anyway || reason.trim().length >= MIN_REASON_LENGTH) &&
    !isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="leading-normal sm:max-w-[540px]"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-lg">
            Drop <span className="font-mono">"{event.name}"</span>?
          </DialogTitle>
        </DialogHeader>

        {locked && (
          <div className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <LockIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <b className="text-destructive">
                Locked: this event cannot be dropped.
              </b>{' '}
              Purchase, revenue, attribution, crash, A/B, paywall, onboarding
              and session events are protected, because revenue, funnels and
              experiments depend on them.
            </div>
          </div>
        )}

        {event.keepInfo && (
          <div className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <BookmarkIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <b className="text-destructive">Marked Keep:</b>{' '}
              {event.keepInfo.note}. Something outside OpenPanel reads this
              event; dropping it breaks that.
            </div>
          </div>
        )}

        {anyway && activeBoards.length > 0 && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <b className="text-destructive">
              {activeBoards.length} active board
              {activeBoards.length > 1 ? 's' : ''} will stop getting new data:
            </b>{' '}
            {activeBoards.map((g) => g.board.name).join(', ')}
          </div>
        )}

        {anyway && (
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">
              Boards and reports that use it ({reportCount} report
              {reportCount === 1 ? '' : 's'}
              {otherCount > 0 &&
                `, plus ${otherCount} cohort/custom event use${otherCount > 1 ? 's' : ''}`}
              ):
            </div>
            {groups.length > 0 && (
              <div className="max-h-40 divide-y overflow-y-auto rounded-md border text-sm">
                {groups.map(({ board, reports }) => (
                  <div
                    key={board.id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span>
                      {board.name}{' '}
                      <span className="text-sm text-muted-foreground">
                        · {reports.length} report
                        {reports.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    <ActiveBadge active={board.active} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!locked && (
          <>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>New events of this name stop being stored.</li>
              <li>Events sent while dropped are not kept.</li>
              <li>Past data stays. Nothing is deleted from ClickHouse.</li>
              <li>
                {slackConfigured
                  ? `Logged in the audit log and posted to Slack #analytics${anyway ? ' with the board names' : ''}.`
                  : 'Logged in the audit log. Slack posting is off.'}
              </li>
            </ul>

            <div className="space-y-2">
              <label
                htmlFor="drop-confirm"
                className="text-sm text-muted-foreground"
              >
                Type{' '}
                <span className="font-mono text-foreground">{event.name}</span>{' '}
                to confirm
              </label>
              <Input
                id="drop-confirm"
                className="font-mono"
                autoComplete="off"
                autoFocus
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
              />
            </div>

            {anyway && (
              <div className="space-y-2">
                <label
                  htmlFor="drop-reason"
                  className="text-sm text-muted-foreground"
                >
                  Reason
                </label>
                <Textarea
                  id="drop-reason"
                  rows={2}
                  placeholder="Why drop an event that boards use?"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            )}
          </>
        )}

        <DialogFooter>
          {!(locked || event.keepInfo) && (
            <Button
              variant="ghost"
              size="default"
              className="sm:mr-auto"
              onClick={onKeepInstead}
            >
              <BookmarkIcon /> Keep instead
            </Button>
          )}
          <Button variant="outline" size="default" onClick={onCancel}>
            {locked ? 'Close' : 'Cancel'}
          </Button>
          {!locked && (
            <Button
              variant="destructive"
              size="default"
              disabled={!canSubmit}
              loading={isPending}
              onClick={() =>
                onConfirm({
                  confirmName,
                  reason: reason.trim() || undefined,
                })
              }
            >
              {anyway ? 'Drop anyway' : 'Drop event'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UndropDialog({
  event,
  isPending,
  slackConfigured,
  onCancel,
  onConfirm,
}: {
  event: ManagedEvent;
  isPending: boolean;
  slackConfigured: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="leading-normal sm:max-w-[540px]"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-lg">
            Undrop <span className="font-mono">"{event.name}"</span>?
          </DialogTitle>
        </DialogHeader>
        <div className="text-sm">
          New events will be stored again. Events sent while dropped are not
          recovered.
        </div>
        <div className="text-sm text-muted-foreground">
          Dropped {dateTime(event.droppedAt)}.
        </div>
        <div className="text-sm text-muted-foreground">
          {slackConfigured
            ? 'Logged in the audit log and posted to Slack #analytics.'
            : 'Logged in the audit log. Slack posting is off.'}
        </div>
        <DialogFooter>
          <Button variant="outline" size="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="default"
            disabled={isPending}
            loading={isPending}
            onClick={() => onConfirm()}
          >
            Undrop
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Used in" for an event marked Keep: the mark and its note. */
export function KeptChip({
  note,
  onClick,
}: {
  note: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={note}
      className="inline-flex max-w-[180px] items-center gap-1 text-left text-sm text-amber-500 hover:underline"
      onClick={onClick}
    >
      <BookmarkIcon className="size-3.5 shrink-0" />
      <span className="truncate">Kept · {note}</span>
    </button>
  );
}

const KEEP_NOTE_MAX = 200;

export function KeepDialog({
  event,
  isPending,
  onCancel,
  onSave,
}: {
  event: ManagedEvent;
  isPending: boolean;
  onCancel: () => void;
  onSave: (keep: boolean, note: string) => void;
}) {
  const kept = Boolean(event.keepInfo);
  const [note, setNote] = useState(event.keepInfo?.note ?? '');
  const trimmed = note.trim();
  const canSave =
    trimmed.length > 0 && trimmed.length <= KEEP_NOTE_MAX && !isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="leading-normal sm:max-w-[480px]"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-lg">
            Keep <span className="font-mono">"{event.name}"</span>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          For events read outside OpenPanel (a skill, a query, a script), which
          "Used in" cannot see. A kept event is not counted as not used.
          Nothing else changes.
        </p>
        <div className="space-y-2">
          <label htmlFor="keep-note" className="text-sm text-muted-foreground">
            What uses it?
          </label>
          <Input
            id="keep-note"
            autoComplete="off"
            autoFocus
            maxLength={KEEP_NOTE_MAX}
            placeholder="e.g. read by the review-lookup skill"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <DialogFooter>
          {kept && (
            <Button
              variant="ghost"
              size="default"
              className="text-destructive sm:mr-auto"
              disabled={isPending}
              onClick={() => onSave(false, '')}
            >
              Remove Keep
            </Button>
          )}
          <Button variant="outline" size="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="default"
            disabled={!canSave}
            loading={isPending}
            onClick={() => onSave(true, trimmed)}
          >
            {kept ? 'Save note' : 'Keep'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StatusBadge({ status }: { status: ManagedEvent['status'] }) {
  const base = 'border-transparent text-[12px]';
  if (status === 'dropped') {
    return (
      <Badge className={cn(base, 'bg-destructive/15 text-destructive')}>
        Dropped
      </Badge>
    );
  }
  if (status === 'protected') {
    return (
      <Badge className={cn(base, 'bg-def-200 text-muted-foreground')}>
        <LockIcon /> Protected
      </Badge>
    );
  }
  return (
    <Badge className={cn(base, 'bg-emerald-500/15 text-emerald-500')}>
      Active
    </Badge>
  );
}
