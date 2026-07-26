import {
  CameraIcon,
  CameraOffIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { getAllowedEventScreenshotUrl } from './event-screenshot-url';
import type { RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';

type ChartEvent = RouterOutputs['chart']['events'][number];
type EventScreenshots = ChartEvent['screenshots'];
type EventScreenshot = NonNullable<EventScreenshots>[number];

interface EventScreenshotPreviewProps {
  eventName: string;
  screenshots: EventScreenshots;
  className?: string;
  compact?: boolean;
  showNoMatch?: boolean;
}

function propertyEntries(properties: Record<string, unknown>) {
  return Object.entries(properties).map(
    ([key, propertyValue]) =>
      [
        key,
        typeof propertyValue === 'string'
          ? propertyValue
          : JSON.stringify(propertyValue),
      ] as const
  );
}

function PropertySection({
  properties,
  title,
}: {
  properties: Record<string, unknown>;
  title: string;
}) {
  const entries = propertyEntries(properties);
  if (!entries.length) {
    return null;
  }
  return (
    <section className="rounded bg-zinc-900 p-3 text-sm">
      <h3 className="mb-2 font-medium">{title}</h3>
      <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-3 gap-y-1">
        {entries.map(([key, value]) => (
          <div className="contents" key={key}>
            <dt className="truncate text-zinc-400">{key}</dt>
            <dd className="break-all font-mono">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function EventScreenshotPreview({
  eventName,
  screenshots,
  className,
  compact = false,
  showNoMatch = false,
}: EventScreenshotPreviewProps) {
  const validatedScreenshots = useMemo(
    () =>
      (screenshots ?? [])
        .map((screenshot) => ({
          screenshot,
          url: getAllowedEventScreenshotUrl(screenshot.url),
        }))
        .filter(
          (item): item is { screenshot: EventScreenshot; url: string } =>
            item.url !== null
        ),
    [screenshots]
  );
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [failedUrls, setFailedUrls] = useState<Set<string>>(() => new Set());
  const safeScreenshots = useMemo(
    () => validatedScreenshots.filter((item) => !failedUrls.has(item.url)),
    [failedUrls, validatedScreenshots]
  );
  useEffect(() => {
    if (selectedIndex >= safeScreenshots.length) {
      setSelectedIndex(0);
    }
  }, [safeScreenshots.length, selectedIndex]);

  const markFailed = (url: string) => {
    setFailedUrls((current) => new Set(current).add(url));
  };

  if (!safeScreenshots.length) {
    if (showNoMatch) {
      return (
        <span
          aria-label="No matching screenshot sampled yet"
          className={cn(
            'inline-flex shrink-0 items-center justify-center text-muted-foreground',
            compact ? 'size-6' : 'h-10 w-16',
            className
          )}
          role="status"
          title="No matching screenshot sampled yet"
        >
          <CameraOffIcon className="size-3.5" />
        </span>
      );
    }
    return null;
  }

  const selected = safeScreenshots[selectedIndex] ?? safeScreenshots[0];
  const capturedAt = selected.screenshot.capturedAtMs
    ? new Date(selected.screenshot.capturedAtMs)
    : null;
  const capturedAtLabel =
    capturedAt && !Number.isNaN(capturedAt.getTime())
      ? capturedAt.toLocaleString()
      : null;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Button
        aria-haspopup="dialog"
        aria-label={`Preview screenshots for ${eventName}`}
        className={cn(
          'relative shrink-0 overflow-hidden border bg-muted p-0',
          compact ? 'size-6 rounded' : 'h-10 w-16 rounded-md',
          className
        )}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        size="icon"
        type="button"
        variant="ghost"
      >
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions lint/performance/noImgElement: image load failure updates the surrounding preview control */}
        <img
          alt=""
          className="size-full object-cover"
          height={40}
          loading="lazy"
          onError={() => markFailed(safeScreenshots[0].url)}
          referrerPolicy="no-referrer"
          src={safeScreenshots[0].url}
          width={64}
        />
        <CameraIcon className="absolute size-3 text-white drop-shadow" />
        {safeScreenshots.length > 1 && (
          <span className="absolute right-0 bottom-0 bg-black/75 px-1 text-[9px] text-white leading-3">
            {safeScreenshots.length}
          </span>
        )}
      </Button>
      <DialogContent
        className="max-h-[95vh] max-w-[min(96vw,90rem)] gap-3 overflow-y-auto bg-black p-3 text-white"
        showCloseButton
      >
        <DialogHeader className="pr-10">
          <DialogTitle>{eventName} screenshots</DialogTitle>
          <DialogDescription className="text-zinc-300">
            {[
              selected.screenshot.appPackage,
              selected.screenshot.appVersion,
              capturedAtLabel,
            ]
              .filter(Boolean)
              .join(' · ') || 'Captured event screenshot'}
          </DialogDescription>
        </DialogHeader>
        <div className="relative flex min-h-0 items-center justify-center">
          {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions lint/performance/noImgElement: image load failure updates the surrounding preview dialog */}
          <img
            alt={`${eventName} event screenshot`}
            className="max-h-[calc(95vh-15rem)] w-full rounded object-contain"
            height={1600}
            onError={() => markFailed(selected.url)}
            referrerPolicy="no-referrer"
            src={selected.url}
            width={900}
          />
          {safeScreenshots.length > 1 && (
            <>
              <Button
                aria-label="Previous screenshot"
                className="absolute left-2 bg-black/70"
                icon={ChevronLeftIcon}
                onClick={() =>
                  setSelectedIndex(
                    (selectedIndex - 1 + safeScreenshots.length) %
                      safeScreenshots.length
                  )
                }
                size="icon"
                type="button"
                variant="ghost"
              />
              <Button
                aria-label="Next screenshot"
                className="absolute right-2 bg-black/70"
                icon={ChevronRightIcon}
                onClick={() =>
                  setSelectedIndex((selectedIndex + 1) % safeScreenshots.length)
                }
                size="icon"
                type="button"
                variant="ghost"
              />
            </>
          )}
        </div>
        {safeScreenshots.length > 1 && (
          <div
            aria-label="Screenshot gallery"
            className="flex gap-2 overflow-x-auto"
            role="group"
          >
            {safeScreenshots.map((item, index) => (
              <button
                aria-label={`Show screenshot ${index + 1}`}
                className={cn(
                  'h-12 w-20 shrink-0 overflow-hidden rounded border-2',
                  index === selectedIndex
                    ? 'border-white'
                    : 'border-transparent'
                )}
                key={item.screenshot.captureId ?? item.url}
                onClick={() => setSelectedIndex(index)}
                type="button"
              >
                {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions lint/performance/noImgElement: image load failure updates the surrounding gallery control */}
                <img
                  alt=""
                  className="size-full object-cover"
                  height={48}
                  onError={() => markFailed(item.url)}
                  src={item.url}
                  width={80}
                />
              </button>
            ))}
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          <PropertySection
            properties={selected.screenshot.eventProperties}
            title="Event properties"
          />
          <PropertySection
            properties={selected.screenshot.userProperties}
            title="User properties"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
