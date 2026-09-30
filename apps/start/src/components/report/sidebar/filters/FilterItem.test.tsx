// @vitest-environment jsdom

import type { IChartEvent, IChartEventFilter } from '@openpanel/validation';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createContext, useContext, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditProjectFilters from '@/components/settings/edit-project-filters';
import { FilterItem } from './FilterItem';
import { TooltipProvider } from '@/components/ui/tooltip';

const wrapper = TooltipProvider;

vi.mock('@/hooks/use-app-params', () => ({
  useAppParams: () => ({ projectId: 'project' }),
}));
vi.mock('@/hooks/use-property-values', () => ({ usePropertyValues: () => [] }));
vi.mock('@/components/ui/combobox-events', () => ({
  ComboboxEvents: () => null,
}));
vi.mock('@/hooks/use-event-names', () => ({ useEventNames: () => [] }));
vi.mock('@/components/report/sidebar/PropertiesCombobox', () => ({
  PropertiesCombobox: () => null,
}));
vi.mock('@/integrations/trpc/react', () => ({
  handleError: vi.fn(),
  useTRPC: () => ({ project: { update: { mutationOptions: () => ({}) } } }),
}));
const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate, isPending: false }),
}));

// Feed actual dispatched event payloads back into the controlled report item.
// The production handler, operator dropdown and value picker are not mocked.
const DispatchContext = createContext(
  (_action: { payload: IChartEvent }) => {}
);
vi.mock('@/redux', () => ({ useDispatch: () => useContext(DispatchContext) }));

const values = ['meta-ads', 'apps.facebook.com', 'apps.instagram.com'];
const otherFilter: IChartEventFilter = {
  id: 'other',
  name: 'country',
  operator: 'is',
  value: ['US', 'GB'],
};
function makeFilter(
  operator: 'is' | 'isNot',
  value = values
): IChartEventFilter {
  return { id: 'source', name: 'referrer', operator, value };
}
function ReportHarness({ filter }: { filter: IChartEventFilter }) {
  const [event, setEvent] = useState<IChartEvent>({
    id: 'event',
    name: 'screen_view',
    segment: 'event',
    filters: [filter, otherFilter],
  } as IChartEvent);
  return (
    <DispatchContext.Provider value={(action) => setEvent(action.payload)}>
      <FilterItem event={event} filter={event.filters[0]!} />
      <output aria-label="report filters">
        {JSON.stringify(event.filters)}
      </output>
    </DispatchContext.Provider>
  );
}
function mountEditor(editor: 'report' | 'project', filter: IChartEventFilter) {
  if (editor === 'report')
    return render(<ReportHarness filter={filter} />, { wrapper });
  return render(
    <EditProjectFilters
      project={
        {
          id: 'project',
          filters: [
            {
              type: 'event',
              name: 'screen_view',
              segment: 'event',
              filters: [filter, otherFilter],
            },
          ],
        } as Parameters<typeof EditProjectFilters>[0]['project']
      }
    />,
    { wrapper }
  );
}
async function changeOperator(from: string, to: string) {
  // Keyboard opening exercises the real Radix dropdown without pointer shims.
  fireEvent.keyDown(screen.getAllByRole('button', { name: from })[0]!, {
    key: 'ArrowDown',
  });
  fireEvent.click(await screen.findByRole('menuitem', { name: to }));
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

for (const editor of ['report', 'project'] as const) {
  describe(`${editor} filter operator`, () => {
    for (const initial of ['is', 'isNot'] as const) {
      it(`preserves all three values from ${initial} and back`, async () => {
        const filter = makeFilter(initial);
        mountEditor(editor, filter);
        const labels = initial === 'is' ? ['Is', 'Is not'] : ['Is not', 'Is'];
        for (const [from, to] of [
          [labels[0]!, labels[1]!],
          [labels[1]!, labels[0]!],
        ]) {
          await changeOperator(from!, to!);
          for (const value of values)
            expect(screen.getByText(value)).toBeTruthy();
          const operator = to === 'Is' ? 'is' : 'isNot';
          const expected = [{ ...filter, operator }, otherFilter];
          if (editor === 'report') {
            expect(
              JSON.parse(screen.getByLabelText('report filters').textContent!)
            ).toEqual(expected);
          } else {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await waitFor(() =>
              expect(mutate).toHaveBeenLastCalledWith({
                id: 'project',
                filters: [
                  {
                    type: 'event',
                    name: 'screen_view',
                    segment: 'event',
                    filters: expected,
                  },
                ],
              })
            );
          }
        }
      });
    }
    it('retains existing single-value behavior for Contains', async () => {
      mountEditor(editor, makeFilter('is'));
      await changeOperator('Is', 'Contains');
      expect(
        (screen.getByDisplayValue(values[0]!) as HTMLInputElement).value
      ).toBe(values[0]);
      expect(screen.queryByText(values[1]!)).toBeNull();
    });
  });
}
