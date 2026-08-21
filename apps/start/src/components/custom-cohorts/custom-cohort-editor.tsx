import { ComboboxEvents } from '@/components/ui/combobox-events';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import type {
  ICustomCohortCriterion,
  ICustomCohortDefinition,
} from '@openpanel/validation';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useMemo } from 'react';

export interface CustomCohortForm {
  id?: string;
  name: string;
  definition: ICustomCohortDefinition;
}

export const emptyCriterion: ICustomCohortCriterion = {
  kind: 'did',
  event: '',
  aggregate: { kind: 'total_events' },
  operator: 'gte',
  value: 1,
  window: { type: 'last', amount: 30, unit: 'day' },
  universe: 'all_identified',
  filters: [],
};

export const emptyDefinition: ICustomCohortDefinition = {
  op: 'and',
  groups: [{ op: 'and', criteria: [emptyCriterion] }],
};

export function CustomCohortEditor({
  value,
  onChange,
}: {
  value: CustomCohortForm;
  onChange: (next: CustomCohortForm) => void;
}) {
  const { projectId } = useAppParams();
  const trpc = useTRPC();

  const eventsQuery = useQuery(trpc.chart.events.queryOptions({ projectId }));
  const events = eventsQuery.data ?? [];

  // Live count for the CURRENT unsaved definition. Only fires once every
  // criterion has an event selected, so we never evaluate a half-built cohort.
  const isComplete = useMemo(
    () =>
      value.definition.groups.every((g) =>
        g.criteria.every((c) => typeof c.event === 'string' && c.event !== ''),
      ),
    [value.definition],
  );

  const previewQuery = useQuery({
    ...trpc.customCohort.preview.queryOptions({
      projectId,
      definition: value.definition,
    }),
    enabled: isComplete,
  });

  const setCriterion = (
    groupIndex: number,
    criterionIndex: number,
    next: Partial<ICustomCohortCriterion>,
  ) => {
    const groups = value.definition.groups.map((g, gi) =>
      gi !== groupIndex
        ? g
        : {
            ...g,
            criteria: g.criteria.map((c, ci) =>
              ci !== criterionIndex ? c : { ...c, ...next },
            ),
          },
    );
    onChange({ ...value, definition: { ...value.definition, groups } });
  };

  const addCriterion = (groupIndex: number) => {
    const groups = value.definition.groups.map((g, gi) =>
      gi !== groupIndex ? g : { ...g, criteria: [...g.criteria, emptyCriterion] },
    );
    onChange({ ...value, definition: { ...value.definition, groups } });
  };

  const removeCriterion = (groupIndex: number, criterionIndex: number) => {
    const groups = value.definition.groups
      .map((g, gi) =>
        gi !== groupIndex
          ? g
          : { ...g, criteria: g.criteria.filter((_, ci) => ci !== criterionIndex) },
      )
      .filter((g) => g.criteria.length > 0);
    onChange({
      ...value,
      definition: {
        ...value.definition,
        groups: groups.length ? groups : emptyDefinition.groups,
      },
    });
  };

  const addGroup = () => {
    onChange({
      ...value,
      definition: {
        ...value.definition,
        groups: [
          ...value.definition.groups,
          { op: 'and', criteria: [emptyCriterion] },
        ],
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="cohort-name">
          Name
        </label>
        <Input
          id="cohort-name"
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder="e.g. 60 min focus users"
          value={value.name}
        />
      </div>

      {value.definition.groups.map((group, groupIndex) => (
        <div
          className="rounded-lg border p-3"
          key={`group-${groupIndex}`}
        >
          <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">
            Identified users who
          </div>

          <div className="flex flex-col gap-2">
            {group.criteria.map((criterion, criterionIndex) => (
              <div
                className="flex flex-wrap items-center gap-2"
                key={`criterion-${groupIndex}-${criterionIndex}`}
              >
                <Select
                  onValueChange={(kind) =>
                    setCriterion(groupIndex, criterionIndex, {
                      kind: kind as 'did' | 'did_not',
                    })
                  }
                  value={criterion.kind}
                >
                  <SelectTrigger className="w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="did">did</SelectItem>
                    <SelectItem value="did_not">did not</SelectItem>
                  </SelectContent>
                </Select>

                <div className="min-w-[190px]">
                  <ComboboxEvents
                    items={events}
                    onChange={(event: string) =>
                      setCriterion(groupIndex, criterionIndex, { event })
                    }
                    placeholder="Select event"
                    searchable
                    value={
                      typeof criterion.event === 'string' ? criterion.event : ''
                    }
                  />
                </div>

                <Select
                  onValueChange={(kind) =>
                    setCriterion(groupIndex, criterionIndex, {
                      aggregate: { kind: kind as 'total_events' },
                    })
                  }
                  value={criterion.aggregate.kind}
                >
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="total_events">Total events</SelectItem>
                    <SelectItem value="distinct_days">Distinct days</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  onValueChange={(operator) =>
                    setCriterion(groupIndex, criterionIndex, {
                      operator: operator as 'gte',
                    })
                  }
                  value={criterion.operator}
                >
                  <SelectTrigger className="w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gte">at least</SelectItem>
                    <SelectItem value="lte">at most</SelectItem>
                    <SelectItem value="eq">exactly</SelectItem>
                  </SelectContent>
                </Select>

                <Input
                  className="w-[80px]"
                  onChange={(e) =>
                    setCriterion(groupIndex, criterionIndex, {
                      value: Number(e.target.value) || 0,
                    })
                  }
                  type="number"
                  value={criterion.value}
                />

                <Select
                  onValueChange={(amount) =>
                    setCriterion(groupIndex, criterionIndex, {
                      window:
                        amount === 'ever'
                          ? { type: 'ever' }
                          : {
                              type: 'last',
                              amount: Number(amount),
                              unit: 'day',
                            },
                    })
                  }
                  value={
                    criterion.window.type === 'last'
                      ? String(criterion.window.amount)
                      : 'ever'
                  }
                >
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">last 7 days</SelectItem>
                    <SelectItem value="30">last 30 days</SelectItem>
                    <SelectItem value="90">last 90 days</SelectItem>
                    <SelectItem value="ever">ever</SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  onClick={() => removeCriterion(groupIndex, criterionIndex)}
                  size="icon"
                  variant="ghost"
                >
                  <Trash2Icon className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <Button
            className="mt-2"
            onClick={() => addCriterion(groupIndex)}
            size="sm"
            variant="ghost"
          >
            <PlusIcon className="mr-1 h-4 w-4" />
            Filter
          </Button>
        </div>
      ))}

      <Button className="self-start" onClick={addGroup} size="sm" variant="ghost">
        <PlusIcon className="mr-1 h-4 w-4" />
        Group
      </Button>

      <div className="text-sm text-muted-foreground" data-testid="cohort-preview">
        {!isComplete
          ? 'Select an event to see the cohort size'
          : previewQuery.isFetching
            ? 'Counting…'
            : previewQuery.data?.status === 'timeout'
              ? 'Too large to preview — save and it will be evaluated in the background'
              : previewQuery.data?.status === 'error'
                ? `Preview failed: ${previewQuery.data.message ?? 'unknown error'}`
                : previewQuery.data
                  ? `${previewQuery.data.matched.toLocaleString()} of ${previewQuery.data.universe.toLocaleString()} identified users · as of ${previewQuery.data.asOf}`
                  : ''}
      </div>
    </div>
  );
}
