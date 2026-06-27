// cache-bust: force rebuild for retention filter fix

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { shortId } from '@openpanel/common';
import { alphabetIds } from '@openpanel/constants';
import type {
  IChartCustomEvent,
  IChartEvent,
  IChartEventItem,
  IChartFormula,
} from '@openpanel/validation';
import { useQuery } from '@tanstack/react-query';
import {
  FilterIcon,
  HandIcon,
  LayersIcon,
  PiIcon,
  PlusIcon,
} from 'lucide-react';
import * as React from 'react';
import {
  addSerie,
  changeEvent,
  duplicateEvent,
  removeEvent,
  reorderEvents,
} from '../reportSlice';
import type { ReportEventMoreProps } from './ReportEventMore';
import { ReportEventMore } from './ReportEventMore';
import { PropertiesCombobox } from './PropertiesCombobox';
import {
  ReportSeriesItem,
  type ReportSeriesItemProps,
} from './ReportSeriesItem';
import { ColorSquare } from '@/components/color-square';
import { CreateCustomEventDialog } from '@/components/custom-events/create-custom-event-dialog';
import { Button } from '@/components/ui/button';
import { ComboboxEvents } from '@/components/ui/combobox-events';
import { InputEnter } from '@/components/ui/input-enter';
import { useAppParams } from '@/hooks/use-app-params';
import { useDebounceFn } from '@/hooks/use-debounce-fn';
import { useEventNames } from '@/hooks/use-event-names';
import { useTRPC } from '@/integrations/trpc/react';
import { useDispatch, useSelector } from '@/redux';

function SortableReportSeriesItem({
  event,
  index,
  showSegment,
  showAddFilter,
  isSelectManyEvents,
  ...props
}: Omit<ReportSeriesItemProps, 'renderDragHandle'>) {
  const eventId = 'type' in event ? event.id : (event as IChartEvent).id;
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: eventId ?? '' });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <ReportSeriesItem
        event={event}
        index={index}
        isSelectManyEvents={isSelectManyEvents}
        renderDragHandle={(index) => (
          <button className="cursor-grab active:cursor-grabbing" {...listeners}>
            <ColorSquare className="relative">
              <HandIcon className="absolute inset-1 size-3 scale-50 opacity-0 transition-all group-hover:scale-100 group-hover:opacity-100" />
              <span className="block transition-all group-hover:scale-0 group-hover:opacity-0">
                {alphabetIds[index]}
              </span>
            </ColorSquare>
          </button>
        )}
        showAddFilter={showAddFilter}
        showSegment={showSegment}
        {...props}
      />
    </div>
  );
}

function AddFilterAction({
  event,
}: {
  event: IChartEventItem | IChartEvent | IChartCustomEvent;
}) {
  const dispatch = useDispatch();

  if ('type' in event && event.type === 'custom_event') {
    return (
      <PropertiesCombobox
        customEventId={event.customEventId}
        onSelect={(action) => {
          dispatch(
            changeEvent({
              ...event,
              filters: [
                ...(event.filters ?? []),
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
          <Button
            aria-label="Add filter"
            className="text-muted-foreground hover:text-foreground"
            icon={FilterIcon}
            onClick={() => setOpen((p) => !p)}
            size="icon"
            title="Add filter"
            variant="ghost"
          />
        )}
      </PropertiesCombobox>
    );
  }

  const chartEvent =
    'type' in event ? event : { ...event, type: 'event' as const };

  if (chartEvent.type !== 'event') {
    return null;
  }

  return (
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
        <Button
          aria-label="Add filter"
          className="text-muted-foreground hover:text-foreground"
          icon={FilterIcon}
          onClick={() => setOpen((p) => !p)}
          size="icon"
          title="Add filter"
          variant="ghost"
        />
      )}
    </PropertiesCombobox>
  );
}

export function ReportSeries() {
  const selectedSeries = useSelector((state) => state.report.series);
  const chartType = useSelector((state) => state.report.chartType);
  const dispatch = useDispatch();
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const eventNames = useEventNames({
    projectId,
  });
  const customEvents = (useQuery(
    trpc.customEvent.list.queryOptions({ projectId })
  ).data ?? []) as Array<{ id: string; name: string; components?: unknown }>;
  const [editingCustomEvent, setEditingCustomEvent] =
    React.useState<IChartCustomEvent | null>(null);

  const showSegment = ![
    'retention',
    'funnel',
    'funnel_metric',
    'sankey',
  ].includes(chartType);
  const showAddFilter = !['sankey'].includes(chartType);
  const options = useSelector((state) => state.report.options);
  const isSankey = chartType === 'sankey';
  const isAddEventDisabled =
    (chartType === 'retention' || chartType === 'conversion') &&
    selectedSeries.length >= 2;
  const isSankeyEventLimitReached =
    isSankey &&
    options &&
    ((options.type === 'sankey' &&
      options.mode === 'between' &&
      selectedSeries.length >= 2) ||
      (options.type === 'sankey' &&
        options.mode !== 'between' &&
        selectedSeries.length >= 1));
  const dispatchChangeEvent = useDebounceFn((event: IChartEventItem) => {
    dispatch(changeEvent(event));
  });
  const isSelectManyEvents = chartType === 'retention';

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = selectedSeries.findIndex((e) => e.id === active.id);
      const newIndex = selectedSeries.findIndex((e) => e.id === over.id);

      dispatch(reorderEvents({ fromIndex: oldIndex, toIndex: newIndex }));
    }
  };

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
          const currentFirstTime =
            'firstTimeFilter' in event
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
      <DndContext
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        sensors={sensors}
      >
        <SortableContext
          items={selectedSeries.map((e) => ({
            id: ('type' in e ? e.id : (e as IChartEvent).id) ?? '',
          }))}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-4">
            {selectedSeries.map((event, index) => {
              const isFormula = event.type === 'formula';
              const isCustomEvent = event.type === 'custom_event';

              return (
                <SortableReportSeriesItem
                  className="rounded-lg border bg-def-100"
                  event={event}
                  index={index}
                  isSelectManyEvents={isSelectManyEvents}
                  key={event.id}
                  showAddFilter={showAddFilter}
                  showSegment={showSegment}
                >
                  {isCustomEvent ? (
                    <>
                      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
                        <LayersIcon className="h-4 w-4 flex-shrink-0 text-violet-500" />
                        <span className="min-w-0 truncate font-medium">
                          {(event as IChartCustomEvent).displayName ??
                            'Custom Event'}
                        </span>
                        <span className="shrink-0 font-medium text-violet-500 text-xs">
                          Custom
                        </span>
                      </div>
                      {showAddFilter && <AddFilterAction event={event} />}
                      <ReportEventMore
                        displayName={(event as IChartCustomEvent).displayName}
                        displayNamePlaceholder={`Display name (${alphabetIds[index]})`}
                        firstTimeFilter={
                          (event as IChartCustomEvent).firstTimeFilter
                        }
                        onClick={handleMore(event)}
                        onDisplayNameChange={(value) => {
                          dispatchChangeEvent({
                            ...(event as IChartCustomEvent),
                            displayName: value,
                          } as IChartEventItem);
                        }}
                        showEditCustomEvent
                      />
                    </>
                  ) : isFormula ? (
                    <>
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <InputEnter
                          onChangeValue={(value) => {
                            dispatchChangeFormula({
                              ...event,
                              formula: value,
                            });
                          }}
                          placeholder="eg: A+B"
                          value={event.formula}
                        />
                      </div>
                      <ReportEventMore
                        displayName={event.displayName}
                        displayNamePlaceholder={`Display name (${alphabetIds[index]})`}
                        hideFirstTimeFilter
                        onClick={handleMore(event)}
                        onDisplayNameChange={(value) => {
                          dispatchChangeFormula({
                            ...event,
                            displayName: value,
                          });
                        }}
                      />
                    </>
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <ComboboxEvents
                          allowCreateCustomEvent
                          className="w-full min-w-0 shrink justify-between"
                          items={eventNames}
                          multiple={isSelectManyEvents as false}
                          onChange={(value) => {
                            const selectedItem = Array.isArray(value)
                              ? null
                              : eventNames.find((e) => e.name === value);

                            dispatch(
                              changeEvent(
                                selectedItem &&
                                  'isCustomEvent' in selectedItem &&
                                  selectedItem.isCustomEvent &&
                                  'customEventId' in selectedItem &&
                                  selectedItem.customEventId
                                  ? {
                                      id: event.id,
                                      type: 'custom_event',
                                      customEventId: selectedItem.customEventId,
                                      segment: 'event',
                                      displayName: selectedItem.name,
                                      filters: [],
                                    }
                                  : Array.isArray(value)
                                    ? {
                                        id: event.id,
                                        type: 'event',
                                        segment: 'user',
                                        filters: [
                                          {
                                            name: 'name',
                                            operator: 'is',
                                            value,
                                          },
                                        ],
                                        name: '*',
                                      }
                                    : {
                                        ...event,
                                        type: 'event',
                                        name: value,
                                        filters: [],
                                      }
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
                          placeholder="Select event"
                          searchable
                          value={
                            (isSelectManyEvents
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
                        />
                      </div>
                      {showAddFilter && <AddFilterAction event={event} />}
                      <ReportEventMore
                        displayName={
                          (event as IChartEventItem & { type: 'event' })
                            .displayName
                        }
                        displayNamePlaceholder={`Display name (${alphabetIds[index]})`}
                        firstTimeFilter={
                          (event as IChartEventItem & { type: 'event' })
                            .firstTimeFilter
                        }
                        onClick={handleMore(event)}
                        onDisplayNameChange={(value) => {
                          dispatchChangeEvent({
                            ...(event as IChartEventItem & { type: 'event' }),
                            displayName: value,
                          });
                        }}
                      />
                    </>
                  )}
                </SortableReportSeriesItem>
              );
            })}

            <div className="flex min-w-0 gap-2">
              <ComboboxEvents
                allowCreateCustomEvent
                className="min-w-0 flex-1"
                disabled={isAddEventDisabled || isSankeyEventLimitReached}
                items={eventNames}
                onChange={(value) => {
                  const selectedItem = eventNames.find((e) => e.name === value);
                  if (
                    selectedItem &&
                    'isCustomEvent' in selectedItem &&
                    selectedItem.isCustomEvent &&
                    'customEventId' in selectedItem &&
                    selectedItem.customEventId
                  ) {
                    dispatch(
                      addSerie({
                        type: 'custom_event',
                        customEventId: selectedItem.customEventId,
                        segment: 'event',
                        displayName: selectedItem.name,
                        filters: [],
                      })
                    );
                  } else if (isSelectManyEvents) {
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
                placeholder="Select event"
                searchable
                value={''}
              />
              {showFormula && (
                <Button
                  className="flex-1 justify-start px-4 text-left"
                  icon={PiIcon}
                  onClick={() => {
                    dispatch(
                      addSerie({
                        type: 'formula',
                        formula: '',
                        displayName: '',
                      })
                    );
                  }}
                  type="button"
                  variant="outline"
                >
                  Add Formula
                  <PlusIcon className="ml-auto size-4 text-muted-foreground" />
                </Button>
              )}
            </div>
          </div>
        </SortableContext>
      </DndContext>
      <CreateCustomEventDialog
        initialValue={
          editingCustomEvent
            ? {
                id: editingCustomEvent.customEventId,
                name:
                  customEvents.find(
                    (item) => item.id === editingCustomEvent.customEventId
                  )?.name ??
                  editingCustomEvent.displayName ??
                  'Custom Event',
                components:
                  (customEvents.find(
                    (item) => item.id === editingCustomEvent.customEventId
                  )?.components as any) ?? [],
              }
            : null
        }
        onOpenChange={(open) => {
          if (!open) {
            setEditingCustomEvent(null);
          }
        }}
        onSaved={(customEvent) => {
          if (!editingCustomEvent) {
            return;
          }
          dispatch(
            changeEvent({
              ...editingCustomEvent,
              displayName: customEvent.name,
            })
          );
          setEditingCustomEvent(null);
        }}
        open={!!editingCustomEvent}
      />
    </div>
  );
}
