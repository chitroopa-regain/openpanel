import { cn } from '@/utils/cn';
import {
  ArrowUpLeftIcon,
  BirdIcon,
  CornerLeftUpIcon,
  Forklift,
  ForkliftIcon,
} from 'lucide-react';
import { useReportChartContext } from '../context';

export function ReportChartEmpty({
  title = 'No data',
  children,
}: {
  title?: string;
  children?: React.ReactNode;
}) {
  const {
    isEditMode,
    report: { series },
  } = useReportChartContext();

  if (!series || series.length === 0) {
    return (
      <div className="card p-4 center-center h-full w-full flex-col relative">
        <div className="row gap-2 items-end absolute top-4 left-4">
          <CornerLeftUpIcon
            strokeWidth={1.2}
            className="size-8 animate-pulse text-muted-foreground"
          />
          <div className="text-muted-foreground">Start here</div>
        </div>
        <ForkliftIcon
          strokeWidth={1.2}
          className="mb-4 size-1/3 max-w-40 animate-pulse text-muted-foreground"
        />
        <div className="font-medium text-muted-foreground">
          Ready when you're
        </div>
        <div className="text-muted-foreground mt-2">
          Pick atleast one event to start visualize
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'center-center h-full w-full flex-col',
        isEditMode && 'card p-4',
      )}
    >
      {/* Static on purpose: an endlessly pulsing SVG re-layerizes the whole
          dashboard every frame (~50 s of main-thread time per minute on a
          throttled phone with two empty widgets). */}
      <BirdIcon
        strokeWidth={1.2}
        className="mb-4 size-1/3 text-muted-foreground"
      />
      <div className="font-medium text-muted-foreground">{title}</div>
      <div className="text-muted-foreground mt-2">{children}</div>
    </div>
  );
}
