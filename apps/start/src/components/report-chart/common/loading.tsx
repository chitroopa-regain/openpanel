import { cn } from '@/utils/cn';
import {
  ActivityIcon,
  AlarmClockIcon,
  BarChart2Icon,
  BarChartIcon,
  ChartLineIcon,
  ChartPieIcon,
  LineChartIcon,
  MessagesSquareIcon,
  PieChartIcon,
  TrendingUpIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useReportChartContext } from '../context';

const icons = [
  { Icon: ActivityIcon, color: 'text-chart-6' },
  { Icon: BarChart2Icon, color: 'text-chart-9' },
  { Icon: ChartLineIcon, color: 'text-chart-0' },
  { Icon: AlarmClockIcon, color: 'text-chart-1' },
  { Icon: ChartPieIcon, color: 'text-chart-2' },
  { Icon: MessagesSquareIcon, color: 'text-chart-3' },
  { Icon: BarChartIcon, color: 'text-chart-4' },
  { Icon: TrendingUpIcon, color: 'text-chart-5' },
  { Icon: PieChartIcon, color: 'text-chart-7' },
  { Icon: LineChartIcon, color: 'text-chart-8' },
];

// One icon per placeholder, faded by a CSS opacity animation on an HTML
// wrapper (runs on the compositor). The previous framer-motion spring
// carousel ran on the main thread every 1.5 s per loading widget: ~17
// loading widgets kept a phone busy for most of each second.
export function ReportChartLoading({ things }: { things?: boolean }) {
  const { isEditMode } = useReportChartContext();
  const [{ Icon, color }] = useState(
    () => icons[Math.floor(Math.random() * icons.length)]!
  );
  const [isSlow, setSlow] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setSlow(true), 4500);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <div className={cn('h-full w-full', isEditMode && 'card p-4')}>
      <div
        className={
          'relative h-full w-full rounded bg-def-100 overflow-hidden center-center flex'
        }
      >
        <div
          className={cn(
            'absolute size-1/3 animate-pulse will-change-[opacity]',
            color
          )}
          data-testid="report-chart-loading-icon"
        >
          <Icon className="w-full h-full" />
        </div>

        <div
          className={cn(
            'absolute top-3/4 opacity-0 transition-opacity text-muted-foreground',
            isSlow && 'opacity-100',
          )}
        >
          Stay calm, its coming 🙄
        </div>
      </div>
    </div>
  );
}
