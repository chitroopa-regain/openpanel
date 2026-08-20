import {
  CameraIcon,
  CameraOffIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  onImageError?: () => void;
}

function formatPropertyValue(propertyValue: unknown) {
  if (typeof propertyValue === 'string') {
    return propertyValue;
  }

  const serializedValue = JSON.stringify(propertyValue, null, 2);
  return serializedValue ?? String(propertyValue);
}

function propertyEntries(properties: Record<string, unknown>) {
  return Object.entries(properties).map(
    ([key, propertyValue]) => [key, formatPropertyValue(propertyValue)] as const
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
    <section className="min-w-0 rounded bg-zinc-900 p-3 text-sm">
      <h3 className="mb-2 font-medium">{title}</h3>
      <dl className="grid min-w-0 gap-3">
        {entries.map(([key, value]) => (
          <div
            className="min-w-0 border-zinc-800 border-b pb-3 last:border-b-0 last:pb-0"
            key={key}
          >
            <dt className="break-words text-xs text-zinc-400 leading-relaxed">
              {key}
            </dt>
            <dd className="mt-1 min-w-0 whitespace-pre-wrap break-words rounded bg-black/20 p-2 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
              {value}
            </dd>
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
  onImageError,
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
  const [versionFilter, setVersionFilter] = useState<string | null>(null);
  const [failedUrls, setFailedUrls] = useState<Set<string>>(() => new Set());
  const notifiedFailedUrls = useRef<Set<string>>(new Set());
  const allScreenshots = useMemo(
    () => validatedScreenshots.filter((item) => !failedUrls.has(item.url)),
    [failedUrls, validatedScreenshots]
  );
  const appVersions = useMemo(
    () =>
      [
        ...new Set(
          allScreenshots
            .map((item) => item.screenshot.appVersion)
            .filter((version): version is string => !!version)
        ),
      ].sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true })
      ),
    [allScreenshots]
  );
  const safeScreenshots = useMemo(() => {
    if (!versionFilter) {
      return allScreenshots;
    }
    const matching = allScreenshots.filter(
      (item) => item.screenshot.appVersion === versionFilter
    );
    return matching.length > 0 ? matching : allScreenshots;
  }, [allScreenshots, versionFilter]);
  useEffect(() => {
    if (selectedIndex >= safeScreenshots.length) {
      setSelectedIndex(0);
    }
  }, [safeScreenshots.length, selectedIndex]);
  const screenshotUrlsKey = validatedScreenshots
    .map((item) => item.url)
    .join('\u0000');
  useEffect(() => {
    setFailedUrls(new Set());
    notifiedFailedUrls.current.clear();
  }, [screenshotUrlsKey]);

  const markFailed = (url: string) => {
    if (notifiedFailedUrls.current.has(url)) {
      return;
    }
    notifiedFailedUrls.current.add(url);
    setFailedUrls((current) => new Set(current).add(url));
    onImageError?.();
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
      {open &&
        createPortal(
          <div className="[&_[data-slot=dialog-close]]:z-20 [&_[data-slot=dialog-close]]:flex [&_[data-slot=dialog-close]]:size-9 [&_[data-slot=dialog-close]]:items-center [&_[data-slot=dialog-close]]:justify-center [&_[data-slot=dialog-close]]:rounded-full [&_[data-slot=dialog-close]]:border [&_[data-slot=dialog-close]]:border-border [&_[data-slot=dialog-close]]:bg-def-100 [&_[data-slot=dialog-close]]:opacity-100 [&_[data-slot=dialog-close]]:shadow-md [&_[data-slot=dialog-overlay]]:bg-black/85 [&_[data-slot=dialog-overlay]]:backdrop-blur-sm">
            <DialogContent
              className="grid h-[min(94dvh,64rem)] w-[min(96vw,72rem)] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden border-border bg-def-100 p-0 text-foreground shadow-2xl sm:max-w-none md:max-h-none"
              showCloseButton
            >
              <DialogHeader className="border-border border-b px-5 py-4 pr-16">
                <DialogTitle>{eventName} screenshots</DialogTitle>
                <DialogDescription>
                  {[
                    selected.screenshot.appPackage,
                    selected.screenshot.appVersion,
                    capturedAtLabel,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'Captured event screenshot'}
                </DialogDescription>
              </DialogHeader>
              <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-1">
                <div className="relative flex min-h-0 items-center justify-center overflow-hidden bg-black p-3 sm:p-5">
                  {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions lint/performance/noImgElement: image load failure updates the surrounding preview dialog */}
                  <img
                    alt={`${eventName} event screenshot`}
                    className="h-full w-full object-contain"
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
                        className="absolute left-3 bg-black/75 text-white shadow hover:bg-black/90"
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
                        className="absolute right-3 bg-black/75 text-white shadow hover:bg-black/90"
                        icon={ChevronRightIcon}
                        onClick={() =>
                          setSelectedIndex(
                            (selectedIndex + 1) % safeScreenshots.length
                          )
                        }
                        size="icon"
                        type="button"
                        variant="ghost"
                      />
                    </>
                  )}
                </div>
                <aside className="max-h-[32dvh] overflow-y-auto border-border border-t bg-def-100 p-4 lg:max-h-none lg:border-t-0 lg:border-l">
                  {appVersions.length > 1 && (
                    <div
                      aria-label="Filter screenshots by app version"
                      className="mb-4 flex flex-wrap gap-1.5"
                      role="group"
                    >
                      <Button
                        onClick={() => {
                          setVersionFilter(null);
                          setSelectedIndex(0);
                        }}
                        size="sm"
                        type="button"
                        variant={versionFilter === null ? 'default' : 'outline'}
                      >
                        All versions
                      </Button>
                      {appVersions.map((version) => (
                        <Button
                          key={version}
                          onClick={() => {
                            setVersionFilter(version);
                            setSelectedIndex(0);
                          }}
                          size="sm"
                          type="button"
                          variant={
                            versionFilter === version ? 'default' : 'outline'
                          }
                        >
                          {version}
                        </Button>
                      ))}
                    </div>
                  )}
                  {safeScreenshots.length > 1 && (
                    <div
                      aria-label="Screenshot gallery"
                      className="mb-4 flex gap-2 overflow-x-auto pb-1"
                      role="group"
                    >
                      {safeScreenshots.map((item, index) => (
                        <button
                          aria-label={`Show screenshot ${index + 1}`}
                          className={cn(
                            'h-16 w-10 shrink-0 overflow-hidden rounded border-2 bg-black',
                            index === selectedIndex
                              ? 'border-primary'
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
                            height={64}
                            onError={() => markFailed(item.url)}
                            src={item.url}
                            width={40}
                          />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="grid gap-3">
                    <PropertySection
                      properties={selected.screenshot.eventProperties}
                      title="Event properties"
                    />
                    <PropertySection
                      properties={selected.screenshot.userProperties}
                      title="User properties"
                    />
                  </div>
                </aside>
              </div>
            </DialogContent>
          </div>,
          document.body
        )}
    </Dialog>
  );
}
