import { ColorSquare } from '@/components/color-square';
import { useDispatch } from '@/redux';
import { shortId } from '@openpanel/common';
import { alphabetIds } from '@openpanel/constants';
import type {
  IChartCustomEvent,
  IChartEvent,
  IChartEventItem,
} from '@openpanel/validation';
import { DatabaseIcon, FilterIcon, type LucideIcon } from 'lucide-react';
import { ReportSegment } from '../ReportSegment';
import { changeEvent } from '../reportSlice';
import { PropertiesCombobox } from './PropertiesCombobox';
import { FiltersList } from './filters/FiltersList';

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
      <div className="flex items-center gap-2 p-2 group">
        {renderDragHandle ? (
          renderDragHandle(index)
        ) : (
          <ColorSquare>
            <span className="block">{alphabetIds[index]}</span>
          </ColorSquare>
        )}
        {props.children}
      </div>

      {/* Segment and Filter buttons - only for events */}
      {chartEvent && (showSegment || showAddFilter) && (
        <div className="flex gap-2 p-2 pt-0">
          {showSegment && (
            <ReportSegment
              value={chartEvent.segment}
              onChange={(segment) => {
                dispatch(
                  changeEvent({
                    ...chartEvent,
                    segment,
                  })
                );
              }}
            />
          )}
          {showAddFilter && (
            <PropertiesCombobox
              event={chartEvent}
              onSelect={(action) => {
                dispatch(
                  changeEvent({
                    ...chartEvent,
                    filters: [
                      ...chartEvent.filters,
                      {
                        id: shortId(),
                        name: action.value,
                        operator: 'is',
                        value: [],
                      },
                    ],
                  })
                );
              }}
            >
              {(setOpen) => (
                <SmallButton
                  onClick={() => setOpen((p) => !p)}
                  icon={FilterIcon}
                >
                  Add filter
                </SmallButton>
              )}
            </PropertiesCombobox>
          )}

          {showSegment && chartEvent.segment.startsWith('property_') && (
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

      {/* Segment, Filter, and Property picker for custom events */}
      {isCustomEvent && (showSegment || showAddFilter) && (
        <div className="flex gap-2 p-2 pt-0 flex-wrap">
          {showSegment && (
            <ReportSegment
              value={customEvent!.segment}
              onChange={(segment) => {
                dispatch(
                  changeEvent({
                    ...customEvent!,
                    segment,
                  })
                );
              }}
            />
          )}
          {showAddFilter && (
            <PropertiesCombobox
              customEventId={customEvent!.customEventId}
              onSelect={(action) => {
                dispatch(
                  changeEvent({
                    ...customEvent!,
                    filters: [
                      ...(customEvent!.filters ?? []),
                      {
                        id: shortId(),
                        name: action.value,
                        operator: 'is',
                        value: [],
                      },
                    ],
                  })
                );
              }}
            >
              {(setOpen) => (
                <SmallButton
                  onClick={() => setOpen((p) => !p)}
                  icon={FilterIcon}
                >
                  Add filter
                </SmallButton>
              )}
            </PropertiesCombobox>
          )}
          {showSegment && customEvent!.segment.startsWith('property_') && (
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
  ...props
}: {
  children: React.ReactNode;
  icon: LucideIcon;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded-md border border-border bg-card p-1 px-2 text-sm font-medium leading-none text-left min-w-0"
      {...props}
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{children}</span>
    </button>
  );
}
