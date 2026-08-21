import { Button } from '@/components/ui/button';
import { SheetClose, SheetFooter } from '@/components/ui/sheet';
import { cn } from '@/utils/cn';
import { useSelector } from '@/redux';

import { ReportAudience } from './ReportAudience';
import { ReportBreakdowns } from './ReportBreakdowns';
import { ReportSeries } from './ReportSeries';
import { ReportSettings } from './ReportSettings';
import { ReportFixedEvents } from './report-fixed-events';

interface ReportSidebarProps {
  className?: string;
  showFooter?: boolean;
}

export function ReportSidebar({
  className,
  showFooter = true,
}: ReportSidebarProps) {
  const { chartType, options, series } = useSelector((state) => state.report);
  const hasFrequencyDistribution = series.some(
    (s) => s.type !== 'formula' && s.segment === 'frequency_distribution'
  );
  const showBreakdown = chartType !== 'sankey' && !hasFrequencyDistribution;
  const showFixedEvents = chartType === 'sankey';
  return (
    <>
      <div className={cn('flex flex-col gap-8', className)}>
        {showFixedEvents ? (
          <ReportFixedEvents
            numberOfEvents={
              options?.type === 'sankey' && options.mode === 'between' ? 2 : 1
            }
          />
        ) : (
          <ReportSeries />
        )}
        {showBreakdown && <ReportBreakdowns />}
        <ReportAudience />
        <ReportSettings />
      </div>
      {showFooter && (
        <SheetFooter>
          <SheetClose asChild>
            <Button className="w-full">Done</Button>
          </SheetClose>
        </SheetFooter>
      )}
    </>
  );
}
