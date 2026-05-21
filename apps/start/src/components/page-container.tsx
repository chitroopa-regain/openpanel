import { cn } from '@/utils/cn';

interface PageContainerProps {
  className?: string;
  children: React.ReactNode;
  /** Drop the max-width cap so the page fills ultrawide viewports. */
  fluid?: boolean;
}

export function PageContainer({
  className,
  children,
  fluid,
  ...props
}: PageContainerProps) {
  return (
    <div
      className={cn(fluid ? 'w-full p-8' : 'container p-8', className)}
      {...props}
    >
      {children}
    </div>
  );
}
