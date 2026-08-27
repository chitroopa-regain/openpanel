import {
  CustomCohortEditor,
  emptyDefinition,
  type CustomCohortForm,
} from '@/components/custom-cohorts/custom-cohort-editor';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import type { ICustomCohortDefinition } from '@openpanel/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { PlusIcon, TargetIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/settings/_tabs/custom-cohorts'
)({
  component: CustomCohortsSettings,
  // The cohort picker's "Create cohort" link arrives with ?new=1. Landing on
  // the list and making the user hunt for the button they just clicked defeats
  // the point of the link, so the create dialog opens on arrival.
  validateSearch: (search: Record<string, unknown>) => ({
    new: search.new ? 1 : undefined,
  }),
});

function CustomCohortsSettings() {
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomCohortForm | null>(null);
  const search = Route.useSearch();

  useEffect(() => {
    if (search.new) {
      setEditing({ name: '', definition: emptyDefinition });
      setDialogOpen(true);
    }
  }, [search.new]);

  const cohortsQuery = useQuery(
    trpc.customCohort.list.queryOptions({ projectId })
  );

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.customCohort.list.queryKey({ projectId }),
    });
  };

  const createMutation = useMutation(
    trpc.customCohort.create.mutationOptions({
      onSuccess() {
        toast('Custom cohort created');
        invalidate();
        setDialogOpen(false);
        setEditing(null);
      },
      onError(error) {
        toast.error(error.message);
      },
    })
  );

  const updateMutation = useMutation(
    trpc.customCohort.update.mutationOptions({
      onSuccess() {
        toast('Custom cohort updated');
        invalidate();
        setDialogOpen(false);
        setEditing(null);
      },
      onError(error) {
        toast.error(error.message);
      },
    })
  );

  const deleteMutation = useMutation(
    trpc.customCohort.delete.mutationOptions({
      onSuccess() {
        toast('Custom cohort deleted');
        invalidate();
      },
      // Deleting a referenced cohort is blocked server-side and names the
      // reports using it — surface that instead of failing silently.
      onError(error) {
        toast.error(error.message);
      },
    })
  );

  const handleCreate = () => {
    setEditing({ name: '', definition: emptyDefinition });
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!editing?.name) {
      toast.error('Name is required');
      return;
    }
    const payload = {
      name: editing.name,
      projectId,
      definition: editing.definition,
    };
    if (editing.id) {
      updateMutation.mutate({ ...payload, id: editing.id });
    } else {
      createMutation.mutate(payload);
    }
  };

  const cohorts = cohortsQuery.data ?? [];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-medium text-lg">Custom Cohorts</h3>
          <p className="text-muted-foreground text-sm">
            Reusable audiences you can apply to any report. Cohorts match
            identified app users, not accounts.
          </p>
        </div>
        <Button data-testid="create-cohort" onClick={handleCreate}>
          <PlusIcon className="mr-2 h-4 w-4" />
          Create Custom Cohort
        </Button>
      </div>

      {cohorts.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          No custom cohorts yet. Create one to reuse an audience across reports.
        </div>
      ) : (
        <div className="flex flex-col gap-2" data-testid="cohort-list">
          {cohorts.map((cohort) => {
            const openEditor = () => {
              setEditing({
                id: cohort.id,
                name: cohort.name,
                definition:
                  cohort.definition as unknown as ICustomCohortDefinition,
              });
              setDialogOpen(true);
            };
            return (
            <div
              className="flex cursor-pointer items-center justify-between rounded-lg border p-4 transition-colors hover:bg-accent"
              data-testid="cohort-card"
              key={cohort.id}
              // The whole row opens the editor. Keyboard users get the same
              // affordance — a clickable div with no role or key handler is
              // reachable by mouse only.
              onClick={openEditor}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openEditor();
                }
              }}
              role="button"
              tabIndex={0}
            >
              <div className="flex items-center gap-3">
                <TargetIcon className="h-5 w-5 text-violet-500" />
                <div>
                  <div className="font-medium">{cohort.name}</div>
                  <div className="text-muted-foreground text-sm">
                    {cohort.lastCount === null
                      ? 'Not evaluated yet'
                      : `${cohort.lastCount.toLocaleString()} users`}
                    {cohort._count.references > 0 &&
                      ` · used by ${cohort._count.references} report(s)`}
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  aria-label={`Delete ${cohort.name}`}
                  // Stop the row's own handler: without this, deleting also
                  // opens the editor for the cohort being removed.
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteMutation.mutate({ id: cohort.id });
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Trash2Icon className="h-4 w-4" />
                </Button>
              </div>
            </div>
            );
          })}
        </div>
      )}

      <Dialog modal={false} onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {editing?.id ? 'Edit Custom Cohort' : 'Create Custom Cohort'}
            </DialogTitle>
          </DialogHeader>

          {editing && (
            <CustomCohortEditor onChange={setEditing} value={editing} />
          )}

          <DialogFooter>
            <Button onClick={() => setDialogOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              data-testid="save-cohort"
              disabled={createMutation.isPending || updateMutation.isPending}
              onClick={handleSave}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
