import {
  CustomEventEditor,
  type ComponentEvent,
  type CustomEventForm,
} from '@/components/custom-events/custom-event-editor';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { LayersIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/settings/_tabs/custom-events'
)({
  component: CustomEventsSettings,
});

function CustomEventsSettings() {
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CustomEventForm | null>(
    null
  );

  const customEventsQuery = useQuery(
    trpc.customEvent.list.queryOptions({ projectId })
  );

  const createMutation = useMutation(
    trpc.customEvent.create.mutationOptions({
      onSuccess() {
        toast('Custom event created');
        queryClient.invalidateQueries({
          queryKey: trpc.customEvent.list.queryKey({ projectId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.chart.events.queryKey({ projectId }),
        });
        setDialogOpen(false);
        setEditingEvent(null);
      },
    })
  );

  const updateMutation = useMutation(
    trpc.customEvent.update.mutationOptions({
      onSuccess() {
        toast('Custom event updated');
        queryClient.invalidateQueries({
          queryKey: trpc.customEvent.list.queryKey({ projectId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.chart.events.queryKey({ projectId }),
        });
        setDialogOpen(false);
        setEditingEvent(null);
      },
    })
  );

  const deleteMutation = useMutation(
    trpc.customEvent.delete.mutationOptions({
      onSuccess() {
        toast('Custom event deleted');
        queryClient.invalidateQueries({
          queryKey: trpc.customEvent.list.queryKey({ projectId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.chart.events.queryKey({ projectId }),
        });
      },
    })
  );

  const handleCreate = () => {
    setEditingEvent({ name: '', components: [] });
    setDialogOpen(true);
  };

  const handleEdit = (ce: {
    id: string;
    name: string;
    components: unknown;
  }) => {
    setEditingEvent({
      id: ce.id,
      name: ce.name,
      components: (ce.components as ComponentEvent[]) ?? [],
    });
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (
      !editingEvent ||
      !editingEvent.name ||
      editingEvent.components.length === 0
    ) {
      toast.error('Name and at least one event required');
      return;
    }

    if (editingEvent.id) {
      updateMutation.mutate({
        id: editingEvent.id,
        name: editingEvent.name,
        projectId,
        components: editingEvent.components as any,
      });
    } else {
      createMutation.mutate({
        name: editingEvent.name,
        projectId,
        components: editingEvent.components as any,
      });
    }
  };

  const handleDelete = (id: string) => {
    deleteMutation.mutate({ id });
  };

  const addComponentEvent = (eventName: string) => {
    if (!editingEvent) return;
    setEditingEvent({
      ...editingEvent,
      components: [...editingEvent.components, { eventName, filters: [] }],
    });
  };

  const removeComponentEvent = (index: number) => {
    if (!editingEvent) return;
    const remaining = editingEvent.components.filter((_, i) => i !== index);
    if (remaining.length === 0 && editingEvent.id) {
      // Last event removed from existing custom event — delete it
      handleDelete(editingEvent.id);
      setDialogOpen(false);
      setEditingEvent(null);
      return;
    }
    setEditingEvent({
      ...editingEvent,
      components: remaining,
    });
  };

  const customEvents = customEventsQuery.data ?? [];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">Custom Events</h3>
          <p className="text-sm text-muted-foreground">
            Create composite events that match when any of their sub-events
            fire.
          </p>
        </div>
        <Button onClick={handleCreate}>
          <PlusIcon className="mr-2 h-4 w-4" />
          Create Custom Event
        </Button>
      </div>

      {customEvents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          No custom events yet. Create one to combine multiple events into a
          single metric.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {customEvents.map((ce) => (
            <div
              key={ce.id}
              className="flex items-center justify-between rounded-lg border p-4"
            >
              <div className="flex items-center gap-3">
                <LayersIcon className="h-5 w-5 text-violet-500" />
                <div>
                  <div className="font-medium">{ce.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {(ce.components as unknown as ComponentEvent[])?.length ?? 0}{' '}
                    events
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleEdit(ce)}
                >
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDelete(ce.id)}
                >
                  <Trash2Icon className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen} modal={false}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingEvent?.id ? 'Edit Custom Event' : 'Create Custom Event'}
            </DialogTitle>
          </DialogHeader>

          {editingEvent && (
            <CustomEventEditor
              value={editingEvent}
              onChange={setEditingEvent}
              onAddEvent={addComponentEvent}
              onRemoveEvent={removeComponentEvent}
              projectId={projectId}
            />
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
