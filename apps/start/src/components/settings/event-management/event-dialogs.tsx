import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { LockIcon } from 'lucide-react';
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
              Idle = board not viewed in 30 days. "Last viewed" is new
              tracking, so it is empty (—) until recording starts; until then
              active/idle uses last edited.
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
  onCancel,
  onConfirm,
}: {
  event: ManagedEvent;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (input: { confirmName: string; reason?: string }) => void;
}) {
  const [confirmName, setConfirmName] = useState('');
  const [reason, setReason] = useState('');
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
      <DialogContent className="leading-normal sm:max-w-[540px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="text-lg">
            {anyway ? 'Drop anyway' : 'Drop'}{' '}
            <span className="font-mono">"{event.name}"</span>?
          </DialogTitle>
        </DialogHeader>

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

        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>New events go to a 24 h holding topic, not ClickHouse.</li>
          <li>Undrop within 24 h and replay them; after that they are gone.</li>
          <li>Past data stays. Nothing is deleted from ClickHouse.</li>
          <li>
            {anyway
              ? 'Logged in the audit log and posted to Slack #analytics with the board names.'
              : 'Logged in the audit log.'}
          </li>
        </ul>

        <div className="space-y-2">
          <label htmlFor="drop-confirm" className="text-sm text-muted-foreground">
            Type <span className="font-mono text-foreground">{event.name}</span>{' '}
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
            <label htmlFor="drop-reason" className="text-sm text-muted-foreground">
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

        <DialogFooter>
          <Button variant="outline" size="default" onClick={onCancel}>
            Cancel
          </Button>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UndropDialog({
  event,
  isPending,
  onCancel,
  onConfirm,
}: {
  event: ManagedEvent;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (input: { replay: boolean }) => void;
}) {
  const [replay, setReplay] = useState(true);
  const recoverable =
    event.recoverableUntil !== null &&
    new Date(event.recoverableUntil).getTime() > Date.now();
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="leading-normal sm:max-w-[540px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="text-lg">
            Undrop <span className="font-mono">"{event.name}"</span>?
          </DialogTitle>
        </DialogHeader>
        <div className="text-sm">
          New events go to ClickHouse again. Dropped {dateTime(event.droppedAt)}
          {recoverable
            ? `, recoverable until ${dateTime(event.recoverableUntil)}.`
            : '. Only the last 24 h are still held.'}
        </div>
        <label
          htmlFor="undrop-replay"
          className="flex cursor-pointer items-start gap-3 text-sm"
        >
          <Checkbox
            id="undrop-replay"
            checked={replay}
            onCheckedChange={(checked) => setReplay(checked === true)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Replay last 24 h</span>
            <span className="block text-sm text-muted-foreground">
              Events held since{' '}
              {dateTime(
                recoverable
                  ? event.droppedAt
                  : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
              )}{' '}
              are copied back. Events already stored are skipped.
            </span>
          </span>
        </label>
        <div className="text-sm text-muted-foreground">
          Logged in the audit log and posted to Slack #analytics.
        </div>
        <DialogFooter>
          <Button variant="outline" size="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="default"
            disabled={isPending}
            loading={isPending}
            onClick={() => onConfirm({ replay })}
          >
            Undrop
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
