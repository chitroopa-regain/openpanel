import { CreateCustomEventDialog } from '@/components/custom-events/create-custom-event-dialog';
import { ColorSquare } from '@/components/color-square';
import { ComboboxEvents } from '@/components/ui/combobox-events';
import { Input } from '@/components/ui/input';
import { InputEnter } from '@/components/ui/input-enter';
import { useAppParams } from '@/hooks/use-app-params';
import { useDebounceFn } from '@/hooks/use-debounce-fn';
import { useEventNames } from '@/hooks/use-event-names';
import { useTRPC } from '@/integrations/trpc/react';
import { useDispatch, useSelector } from '@/redux';
import { useQuery } from '@tanstack/react-query';
import { alphabetIds } from '@openpanel/constants';
import type {
  IChartCustomEvent,
  IChartEvent,
  IChartEventItem,
  IChartFormula,
} from '@openpanel/validation';
import * as React from 'react';
import {
  addSerie,
  changeEvent,
  duplicateEvent,
  removeEvent,
} from '../reportSlice';
import type { ReportEventMoreProps } from './ReportEventMore';
import { ReportEventMore } from './ReportEventMore';
import { ReportSeriesItem } from './ReportSeriesItem';
import {
  buildChangedReportEvent,
  findSelectedCustomEvent,
} from './report-series-events';

export function ReportFixedEvents({
  numberOfEvents,
}: {
  numberOfEvents: number;
}) {
  const selectedSeries = useSelector((state) => state.report.series);
  const chartType = useSelector((state) => state.report.chartType);
  const dispatch = useDispatch();
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const eventNames = useEventNames({
    projectId,
  });
  const customEvents = useQuery(
    trpc.customEvent.list.queryOptions({ projectId })
  ).data ?? [];
  const [editingCustomEvent, setEditingCustomEvent] =
    React.useState<IChartCustomEvent | null>(null);

  const showSegment = !['retention', 'funnel', 'funnel_metric', 'sankey'].includes(chartType);
  const showAddFilter = !['sankey'].includes(chartType);
  const showDisplayNameInput = !['retention', 'sankey'].includes(chartType);
  const dispatchChangeEvent = useDebounceFn((event: IChartEventItem) => {
    dispatch(changeEvent(event));
  });
  const isSelectManyEvents = chartType === 'retention';

  const handleMore = (event: IChartEventItem | IChartEvent) => {
    const callback: ReportEventMoreProps['onClick'] = (action) => {
      switch (action) {
        case 'remove': {
          return dispatch(
            removeEvent({
              id: 'type' in event ? event.id : (event as IChartEvent).id,
            })
          );
        }
        case 'duplicate': {
          const normalized =
            'type' in event ? event : { ...event, type: 'event' as const };
          return dispatch(duplicateEvent(normalized));
        }
        case 'firstTimeFilter': {
          const currentFirstTime = 'firstTimeFilter' in event
            ? !!(event as any).firstTimeFilter
            : false;
          const normalized =
            'type' in event ? event : { ...event, type: 'event' as const };
          return dispatch(
            changeEvent({
              ...normalized,
              firstTimeFilter: !currentFirstTime,
            } as any)
          );
        }
        case 'editCustomEvent': {
          if ('type' in event && event.type === 'custom_event') {
            setEditingCustomEvent(event as IChartCustomEvent);
          }
          return;
        }
      }
    };

    return callback;
  };

  const dispatchChangeFormula = useDebounceFn((formula: IChartFormula) => {
    dispatch(changeEvent(formula));
  });

  const addCustomEventSerie = (customEvent: { id: string; name: string }) => {
    dispatch(
      addSerie({
        type: 'custom_event',
        customEventId: customEvent.id,
        segment: 'event',
        displayName: customEvent.name,
        filters: [],
      })
    );
  };

  const showFormula =
    chartType !== 'conversion' &&
    chartType !== 'funnel' &&
    chartType !== 'funnel_metric' &&
    chartType !== 'retention' &&
    chartType !== 'sankey';

  return (
    <div>
      <h3 className="mb-2 font-medium">Metrics</h3>
      <div className="flex flex-col gap-4">
        {Array.from({ length: numberOfEvents }, (_, index) => ({
          slotId: `fixed-event-slot-${index}`,
          index,
        })).map(({ slotId, index }) => {
          const event = selectedSeries[index];

          // If no event exists at this index, render an empty slot
          if (!event) {
            return (
              <div key={slotId} className="rounded-lg border bg-def-100">
                <div className="flex items-center gap-2 p-2">
                  <ColorSquare>
                    <span className="block">{alphabetIds[index]}</span>
                  </ColorSquare>
                  <ComboboxEvents
                    className="flex-1"
                    searchable
                    allowCreateCustomEvent
                    multiple={isSelectManyEvents as false}
                    value={''}
                    onChange={(value) => {
                      const selectedItem = findSelectedCustomEvent(
                        value,
                        eventNames
                      );

                      if (selectedItem) {
                        dispatch(
                          addSerie({
                            type: 'custom_event',
                            customEventId: selectedItem.customEventId,
                            segment: 'event',
                            displayName: selectedItem.name,
                            filters: [],
                          })
                        );
                        return;
                      }

                      if (isSelectManyEvents) {
                        dispatch(
                          addSerie({
                            type: 'event',
                            segment: 'user',
                            name: value,
                            filters: [
                              {
                                name: 'name',
                                operator: 'is',
                                value: [value],
                              },
                            ],
                          })
                        );
                      } else {
                        dispatch(
                          addSerie({
                            type: 'event',
                            name: value,
                            segment: 'event',
                            filters: [],
                          })
                        );
                      }
                    }}
                    onCreateCustomEvent={addCustomEventSerie}
                    items={eventNames}
                    placeholder="Select event"
                  />
                </div>
              </div>
            );
          }

          const isFormula = event.type === 'formula';
          if (isFormula) {
            return null;
          }

          const isCustomEvent = event.type === 'custom_event';

          return (
            <ReportSeriesItem
              key={event.id}
              event={event}
              index={index}
              showSegment={showSegment}
              showAddFilter={showAddFilter}
              isSelectManyEvents={isSelectManyEvents}
              className="rounded-lg border bg-def-100"
            >
              <ComboboxEvents
                className="flex-1"
                searchable
                allowCreateCustomEvent
                multiple={isSelectManyEvents as false}
                value={
                  (isCustomEvent
                    ? ((event as IChartCustomEvent).displayName ?? '')
                    : isSelectManyEvents
                    ? ((
                        event as IChartEventItem & {
                          type: 'event';
                        }
                      ).filters[0]?.value ?? [])
                    : (
                        event as IChartEventItem & {
                          type: 'event';
                        }
                      ).name) as any
                }
                onChange={(value) => {
                  dispatch(
                    changeEvent(
                      buildChangedReportEvent({
                        currentEvent: event,
                        value,
                        eventNames,
                      })
                    )
                  );
                }}
                onCreateCustomEvent={(customEvent) => {
                  dispatch(
                    changeEvent({
                      id: event.id,
                      type: 'custom_event',
                      customEventId: customEvent.id,
                      segment: 'event',
                      displayName: customEvent.name,
                      filters: [],
                    })
                  );
                }}
                items={eventNames}
                placeholder="Select event"
              />
              {showDisplayNameInput && (
                <Input
                  placeholder={
                    isCustomEvent
                      ? `${(event as IChartCustomEvent).displayName ?? 'Custom Event'} (${alphabetIds[index]})`
                      : (event as IChartEventItem & { type: 'event' }).name
                        ? `${(event as IChartEventItem & { type: 'event' }).name} (${alphabetIds[index]})`
                        : 'Display name'
                  }
                  defaultValue={
                    isCustomEvent
                      ? (event as IChartCustomEvent).displayName
                      : (event as IChartEventItem & { type: 'event' }).displayName
                  }
                  onChange={(e) => {
                    dispatchChangeEvent(
                      isCustomEvent
                        ? {
                            ...(event as IChartCustomEvent),
                            displayName: e.target.value,
                          }
                        : {
                            ...(event as IChartEventItem & {
                              type: 'event';
                            }),
                            displayName: e.target.value,
                          }
                    );
                  }}
                />
              )}
              <ReportEventMore
                onClick={handleMore(event)}
                firstTimeFilter={
                  isCustomEvent
                    ? (event as IChartCustomEvent).firstTimeFilter
                    : (event as IChartEventItem & { type: 'event' })
                        .firstTimeFilter
                }
                showEditCustomEvent={isCustomEvent}
              />
            </ReportSeriesItem>
          );
        })}
      </div>
      <CreateCustomEventDialog
        open={!!editingCustomEvent}
        onOpenChange={(open) => {
          if (!open) {
            setEditingCustomEvent(null);
          }
        }}
        initialValue={
          editingCustomEvent
            ? {
                id: editingCustomEvent.customEventId,
                name:
                  customEvents.find(
                    (item) => item.id === editingCustomEvent.customEventId
                  )?.name ?? editingCustomEvent.displayName ?? 'Custom Event',
                components:
                  (customEvents.find(
                    (item) => item.id === editingCustomEvent.customEventId
                  )?.components as any) ?? [],
              }
            : null
        }
        onSaved={(customEvent) => {
          if (!editingCustomEvent) return;
          dispatch(
            changeEvent({
              ...editingCustomEvent,
              displayName: customEvent.name,
            })
          );
          setEditingCustomEvent(null);
        }}
      />
    </div>
  );
}
