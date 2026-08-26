import { alphabetIds } from '@openpanel/constants';
import type {
  IChartCustomEvent,
  IChartEvent,
  IChartEventItem,
} from '@openpanel/validation';
import {
  ClockIcon,
  TargetIcon,
  DatabaseIcon,
  type LucideIcon,
} from 'lucide-react';
import { ReportSegment } from '../ReportSegment';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import { useQuery } from '@tanstack/react-query';
import { changeEvent } from '../reportSlice';
import { FiltersList } from './filters/FiltersList';
import { PropertiesCombobox } from './PropertiesCombobox';
import { ColorSquare } from '@/components/color-square';
import { useDispatch } from '@/redux';
import { cn } from '@/utils/cn';

export interface ReportSeriesItemProps
  extends React.HTMLAttributes<HTMLDivElement> {
  event: IChartEventItem | IChartEvent;
  index: number;
  showSegment: boolean;
  showAddFilter: boolean;
  isSelectManyEvents: boolean;
  renderDragHandle?: (index: number) => React.ReactNode;
}

export function ReportSeriesItem({
  event,
  index,
  showSegment,
  showAddFilter,
  isSelectManyEvents,
  renderDragHandle,
  ...props
}: ReportSeriesItemProps) {
  const dispatch = useDispatch();

  // Normalize event to have type field
  const normalizedEvent: IChartEventItem =
    'type' in event ? event : { ...event, type: 'event' as const };

  const isFormula = normalizedEvent.type === 'formula';
  const isCustomEvent = normalizedEvent.type === 'custom_event';
  const customEvent = isCustomEvent
    ? (normalizedEvent as IChartCustomEvent)
    : null;
  const chartEvent =
    normalizedEvent.type === 'event'
      ? (normalizedEvent as IChartEventItem & { type: 'event' })
      : null;

  return (
    <div {...props}>
      <div className="group flex items-center gap-2 p-2">
        {renderDragHandle ? (
          renderDragHandle(index)
        ) : (
          <ColorSquare>
            <span className="block">{alphabetIds[index]}</span>
          </ColorSquare>
        )}
        {props.children}
      </div>

      {/* First time ever badge */}
      {(chartEvent?.firstTimeFilter || customEvent?.firstTimeFilter) && (
        <div className="flex items-center gap-1 px-2 pb-1 text-muted-foreground text-xs">
          <ClockIcon className="h-3 w-3 shrink-0" />
          <span>First time ever</span>
        </div>
      )}

      {/* Segment and Property picker - only for events */}
      {chartEvent && showSegment && (
        <div className="flex gap-2 p-2 pt-0">
          <ReportSegment
            onChange={(segment) => {
              dispatch(
                changeEvent({
                  ...chartEvent,
                  segment,
                })
              );
            }}
            value={chartEvent.segment}
          />

          {chartEvent.segment.startsWith('property_') && (
            <PropertiesCombobox
              event={chartEvent}
              onSelect={(item) => {
                dispatch(
                  changeEvent({
                    ...chartEvent,
                    property: item.value,
                    type: 'event',
                  })
                );
              }}
            >
              {(setOpen) => (
                <SmallButton
                  icon={DatabaseIcon}
                  onClick={() => setOpen((p) => !p)}
                >
                  {chartEvent.property
                    ? `Property: ${chartEvent.property}`
                    : 'Select property'}
                </SmallButton>
              )}
            </PropertiesCombobox>
          )}
        </div>
      )}

      {/* Filters - only for events */}
      {chartEvent && (
        <FiltersList
          event={chartEvent}
          skipEventNameFilter={isSelectManyEvents}
        />
      )}

      {/* Segment and Property picker for custom events */}
      {isCustomEvent && showSegment && (
        <div className="flex flex-wrap gap-2 p-2 pt-0">
          <ReportSegment
            onChange={(segment) => {
              dispatch(
                changeEvent({
                  ...customEvent!,
                  segment,
                })
              );
            }}
            value={customEvent!.segment}
          />
          {customEvent!.segment.startsWith('property_') && (
            <PropertiesCombobox
              customEventId={customEvent!.customEventId}
              onSelect={(item) => {
                dispatch(
                  changeEvent({
                    ...customEvent!,
                    property: item.value,
                  })
                );
              }}
            >
              {(setOpen) => (
                <SmallButton
                  icon={DatabaseIcon}
                  onClick={() => setOpen((p) => !p)}
                >
                  {customEvent!.property
                    ? `Property: ${customEvent!.property}`
                    : 'Select property'}
                </SmallButton>
              )}
            </PropertiesCombobox>
          )}
        </div>
      )}

      {/* Filters for custom events */}
      {isCustomEvent && (
        <FiltersList
          event={customEvent!}
          skipEventNameFilter={isSelectManyEvents}
        />
      )}
    </div>
  );
}

function SmallButton({
  children,
  icon: Icon,
  className,
  ...props
}: {
  children?: React.ReactNode;
  icon: LucideIcon;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-md border border-border bg-card p-1 px-2 text-left font-medium text-sm leading-none',
        !children && 'aspect-square justify-center px-1',
        className
      )}
      type="button"
      {...props}
    >
      <Icon className="shrink-0" size={12} />
      {children && <span className="truncate">{children}</span>}
    </button>
  );
}
