import { Link, useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronDownIcon,
  CogIcon,
  CreditCardIcon,
  LayoutListIcon,
  PlusIcon,
  UsersIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from './ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Tooltiper } from '@/components/ui/tooltip';
import { useAppContext } from '@/hooks/use-app-context';
import { pushModal } from '@/modals';
import type { RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';

function OrganizationSidebarLink({
  compact = false,
  to,
  icon: Icon,
  label,
  exact = true,
  children,
}: {
  compact?: boolean;
  to: string;
  icon: typeof LayoutListIcon;
  label: React.ReactNode;
  exact?: boolean;
  children?: React.ReactNode;
}) {
  const link = (
    <Link
      activeOptions={{ exact }}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 font-medium text-[13px] transition-all hover:bg-def-200',
        compact && 'lg:justify-center lg:px-0 lg:py-2.5'
      )}
      from="/$organizationId"
      to={to as any}
    >
      <Icon size={20} />
      <div className={cn('flex-1', compact && 'lg:hidden')}>{label}</div>
      <div className={cn(compact && 'lg:hidden')}>{children}</div>
    </Link>
  );

  if (!compact) return link;

  return (
    <Tooltiper align="center" asChild content={label} side="right">
      {link}
    </Tooltiper>
  );
}

export default function SidebarOrganizationMenu({
  organization,
  compact = false,
}: {
  organization: RouterOutputs['organization']['list'][number];
  compact?: boolean;
}) {
  const { isSelfHosted } = useAppContext();

  return (
    <>
      <OrganizationSidebarLink
        compact={compact}
        exact
        icon={LayoutListIcon}
        label="Projects"
        to="/$organizationId"
      />
      <OrganizationSidebarLink
        compact={compact}
        exact
        icon={CogIcon}
        label="Settings"
        to="/$organizationId/settings"
      />
      {!isSelfHosted && (
        <OrganizationSidebarLink
          compact={compact}
          exact
          icon={CreditCardIcon}
          label="Billing"
          to="/$organizationId/billing"
        >
          {organization?.isTrial && <Badge>Trial</Badge>}
          {organization?.isExpired && <Badge>Expired</Badge>}
          {organization?.isWillBeCanceled && <Badge>Canceled</Badge>}
          {organization?.isCanceled && <Badge>Canceled</Badge>}
        </OrganizationSidebarLink>
      )}
      <OrganizationSidebarLink
        compact={compact}
        exact={false}
        icon={UsersIcon}
        label="Members"
        to="/$organizationId/members"
      />
      <OrganizationSidebarLink
        compact={compact}
        exact={false}
        icon={WorkflowIcon}
        label="Integrations"
        to="/$organizationId/integrations"
      />
    </>
  );
}

export function ActionCTAButton({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();

  const ACTIONS = [
    {
      label: 'Create a project',
      icon: PlusIcon,
      onClick: () => pushModal('AddProject'),
    },
    {
      label: 'Invite a user',
      icon: UsersIcon,
      onClick: () => pushModal('CreateInvite'),
    },
    {
      label: 'Add integration',
      icon: WorkflowIcon,
      onClick: () =>
        navigate({
          to: '/$organizationId/integrations',
          from: '/$organizationId',
        }),
    },
  ];

  const [currentActionIndex, setCurrentActionIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentActionIndex((prevIndex) => (prevIndex + 1) % ACTIONS.length);
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
