import type { IServiceDashboards } from '@openpanel/db';
import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BellIcon,
  BookOpenIcon,
  ChartLineIcon,
  ChevronDownIcon,
  CogIcon,
  GanttChartIcon,
  Globe2Icon,
  GridIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LayoutPanelTopIcon,
  PlusIcon,
  SparklesIcon,
  TrendingUpDownIcon,
  UndoDotIcon,
  UsersIcon,
  WallpaperIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { SidebarLink } from './sidebar-link';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { pushModal } from '@/modals';
import { Tooltiper } from './ui/tooltip';

interface SidebarProjectMenuProps {
  dashboards: IServiceDashboards;
  compact?: boolean;
}

export default function SidebarProjectMenu({
  dashboards,
  compact = false,
}: SidebarProjectMenuProps) {
  return (
    <>
      <div className="mb-2 font-medium text-muted-foreground text-sm lg:hidden">
        Analytics
      </div>
      <SidebarLink
        compact={compact}
        href={'/dashboards'}
        icon={LayoutPanelTopIcon}
        label="Dashboards"
      />
      <SidebarLink
        compact={compact}
        href={'/overview'}
        icon={WallpaperIcon}
        label="Overview"
      />
      <SidebarLink
        compact={compact}
        href={'/insights'}
        icon={TrendingUpDownIcon}
        label="Insights"
      />
      <SidebarLink compact={compact} href={'/pages'} icon={LayersIcon} label="Pages" />
      <SidebarLink compact={compact} href={'/realtime'} icon={Globe2Icon} label="Realtime" />
      <SidebarLink compact={compact} href={'/events'} icon={GanttChartIcon} label="Events" />
      <SidebarLink compact={compact} href={'/sessions'} icon={UsersIcon} label="Sessions" />
      <SidebarLink compact={compact} href={'/profiles'} icon={UsersIcon} label="Profiles" />
      <div className="mt-4 mb-2 font-medium text-muted-foreground text-sm lg:hidden">
        Manage
      </div>
      <SidebarLink
        compact={compact}
        exact={false}
        href={'/settings'}
        icon={CogIcon}
        label="Settings"
      />
      <SidebarLink compact={compact} href={'/references'} icon={GridIcon} label="References" />
      <SidebarLink
        compact={compact}
        exact={false}
        href={'/notifications'}
        icon={BellIcon}
        label="Notifications"
      />
      <SidebarLink compact={compact} href={'..'} icon={UndoDotIcon} label="Back to workspace" />
    </>
  );
}

export function ActionCTAButton({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();

  const ACTIONS = [
    {
      label: 'Create report',
      icon: ChartLineIcon,
      onClick: () =>
        navigate({
          to: '/$organizationId/$projectId/reports',
          from: '/$organizationId/$projectId',
        }),
    },
    {
      label: 'Create reference',
      icon: BookOpenIcon,
      onClick: () => pushModal('AddReference'),
    },
    {
      label: 'Ask AI',
      icon: SparklesIcon,
      onClick: () =>
        navigate({
          to: '/$organizationId/$projectId/chat',
          from: '/$organizationId/$projectId',
        }),
    },
    {
      label: 'Create dashboard',
      icon: LayoutDashboardIcon,
      onClick: () => pushModal('AddDashboard'),
    },
    {
      label: 'Create notification rule',
      icon: BellIcon,
      onClick: () =>
        navigate({
          to: '/$organizationId/$projectId/notifications/rules',
          from: '/$organizationId/$projectId',
        }),
    },
  ];

  const [currentActionIndex, setCurrentActionIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentActionIndex((prevIndex) => {
        const nextIndex = (prevIndex + 1) % ACTIONS.length;
        if (nextIndex === 0 && prevIndex !== 0) {
          clearInterval(interval);
          return 0;
        }
        return nextIndex;
      });
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="mb-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {compact ? (
            <Button
              className="w-full justify-between lg:size-10 lg:justify-center lg:px-0"
              size="default"
              title={ACTIONS[currentActionIndex].label}
            >
              <PlusIcon size={16} />
              <div className="relative flex h-5 items-center lg:hidden">
                <AnimatePresence mode="popLayout">
                  <motion.span
                    animate={{ y: 0, opacity: 1 }}
                    className="absolute whitespace-nowrap"
                    exit={{ y: -20, opacity: 0 }}
                    initial={{ y: 20, opacity: 0 }}
                    key={currentActionIndex}
                    transition={{
                      type: 'spring',
                      stiffness: 300,
                      damping: 25,
                      duration: 0.3,
                    }}
                  >
                    {ACTIONS[currentActionIndex].label}
                  </motion.span>
                </AnimatePresence>
              </div>
              <ChevronDownIcon className="lg:hidden" size={16} />
            </Button>
          ) : (
            <Button className="w-full justify-between" size="default">
              <div className="flex items-center gap-2">
                <PlusIcon size={16} />
                <div className="relative flex h-5 items-center">
                  <AnimatePresence mode="popLayout">
                    <motion.span
                      animate={{ y: 0, opacity: 1 }}
                      className="absolute whitespace-nowrap"
                      exit={{ y: -20, opacity: 0 }}
                      initial={{ y: 20, opacity: 0 }}
                      key={currentActionIndex}
                      transition={{
                        type: 'spring',
                        stiffness: 300,
                        damping: 25,
                        duration: 0.3,
                      }}
                    >
                      {ACTIONS[currentActionIndex].label}
                    </motion.span>
                  </AnimatePresence>
                </div>
              </div>
              <ChevronDownIcon size={16} />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {ACTIONS.map((action) => (
            <DropdownMenuItem
              className="cursor-pointer"
              key={action.label}
              onClick={action.onClick}
            >
              <action.icon className="mr-2 h-4 w-4" />
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
