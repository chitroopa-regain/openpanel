import { ColorSquare } from '@/components/color-square';
import { useDispatch, useSelector } from '@/redux';
import { ChevronsUpDownIcon, SplitIcon } from 'lucide-react';

import type {
  IChartBreakdown,
  IChartCustomEvent,
  IChartEvent,
  IChartEventItem,
} from '@openpanel/validation';

import { Button } from '@/components/ui/button';
import { addBreakdown, changeBreakdown, removeBreakdown } from '../reportSlice';
import { PropertiesCombobox } from './PropertiesCombobox';
import { ReportBreakdownMore } from './ReportBreakdownMore';
import type { ReportEventMoreProps } from './ReportEventMore';

export function ReportBreakdowns() {
  const selectedBreakdowns = useSelector((state) => state.report.breakdowns);
  const chartType = useSelector((state) => state.report.chartType);
  const options = useSelector((state) => state.report.options);
  const series = useSelector((state) => state.report.series);
  const dispatch = useDispatch();

  let scopedBreakdownSource: IChartEventItem | undefined;
  if (chartType === 'retention') {
    scopedBreakdownSource = series[0];
  } else if (
    (chartType === 'funnel' || chartType === 'funnel_metric') &&
    options?.type === 'funnel' &&
    options.breakdownStep !== undefined &&
    options.breakdownStep >= 0 &&
    options.breakdownStep < series.length
  ) {
    scopedBreakdownSource = series[options.breakdownStep];
  }

  const scopedBreakdownProps = getScopedBreakdownProps(scopedBreakdownSource);

  const handleMore = (breakdown: IChartBreakdown) => {
    const callback: ReportEventMoreProps['onClick'] = (action) => {
      switch (action) {
        case 'remove': {
          return dispatch(removeBreakdown(breakdown));
        }
      }
    };

    return callback;
  };

  return (
    <div>
      <h3 className="mb-2 font-medium">Breakdown</h3>
      <div className="flex flex-col gap-4">
        {selectedBreakdowns.map((item, index) => {
          return (
            <div key={item.name} className="rounded-lg border bg-def-100">
              <div className="flex min-w-0 items-center gap-2 p-2 px-4">
                <ColorSquare className="shrink-0">{index}</ColorSquare>
                <PropertiesCombobox
                  {...scopedBreakdownProps}
                  onSelect={(action) => {
                    dispatch(
                      changeBreakdown({
                        ...item,
                        name: action.value,
                      })
                    );
                  }}
                >
                  {(setOpen) => (
                    <Button
                      variant={'outline'}
                      onClick={() => setOpen((prev) => !prev)}
                      size={'sm'}
                      autoHeight
                      className="min-w-0 flex-1"
                    >
                      <div className="row min-w-0 flex-1 gap-2 items-center">
                        <SplitIcon className="size-4 shrink-0" />
                        <span className="min-w-0 truncate">{item.name}</span>
                      </div>
                      <ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  )}
                </PropertiesCombobox>
                <div className="shrink-0">
                  <ReportBreakdownMore onClick={handleMore(item)} />
                </div>
              </div>
            </div>
          );
        })}

        <PropertiesCombobox
          {...scopedBreakdownProps}
          onSelect={(action) => {
            dispatch(
              addBreakdown({
                name: action.value,
              })
            );
          }}
        >
          {(setOpen) => (
            <Button
              variant={'outline'}
              onClick={() => setOpen((prev) => !prev)}
              size={'sm'}
              autoHeight
              className="min-w-0 flex-1"
            >
              <div className="row min-w-0 flex-1 gap-2 items-center">
                <SplitIcon className="size-4 shrink-0" />
                <span className="min-w-0 truncate">Select breakdown</span>
              </div>
              <ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          )}
        </PropertiesCombobox>
      </div>
    </div>
  );
}

function getScopedBreakdownProps(source?: IChartEventItem): {
  event?: IChartEvent;
  customEventId?: string;
} {
  if (!source || source.type === 'formula') {
    return {};
  }

  if (source.type === 'custom_event') {
    return {
      customEventId: (source as IChartCustomEvent).customEventId,
    };
  }

  return {
    event: source as IChartEvent,
  };
}
