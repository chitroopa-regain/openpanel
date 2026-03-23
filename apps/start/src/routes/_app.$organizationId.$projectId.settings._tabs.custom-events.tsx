import { Button } from '@/components/ui/button';
import { ComboboxEvents } from '@/components/ui/combobox-events';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAppParams } from '@/hooks/use-app-params';
import { useEventNames } from '@/hooks/use-event-names';
import { useTRPC } from '@/integrations/trpc/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { LayersIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/settings/_tabs/custom-events'
)({
  component: CustomEventsSettings,
});

interface ComponentEvent {
  eventName: string;
  filters: Array<{
    name: string;
    operator: string;
    value: (string | number | boolean | null)[];
  }>;
}

interface CustomEventForm {
  id?: string;
  name: string;
  components: ComponentEvent[];
}

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
        components: editingEvent.components,
      });
    } else {
      createMutation.mutate({
        name: editingEvent.name,
        projectId,
        components: editingEvent.components,
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
                    {(ce.components as ComponentEvent[])?.length ?? 0} events
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
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

function CustomEventEditor({
  value,
  onChange,
  onAddEvent,
  onRemoveEvent,
  projectId,
}: {
  value: CustomEventForm;
  onChange: (value: CustomEventForm) => void;
  onAddEvent: (eventName: string) => void;
  onRemoveEvent: (index: number) => void;
  projectId: string;
}) {
  const eventNames = useEventNames({ projectId, anyEvents: false });

  // Filter out custom events from the picker (avoid circular references)
  const realEvents = eventNames.filter(
    (e) => !('isCustomEvent' in e && e.isCustomEvent)
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1 block text-sm font-medium">Name</label>
        <Input
          placeholder="e.g., Active User Event"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium">
          Match when any of these events happen:
        </label>

        <div className="flex flex-col gap-2">
          {value.components.map((component, index) => (
            <div
              key={index}
              className="flex items-center gap-2 rounded-md border bg-def-100 px-3 py-2"
            >
              <span className="flex-1 truncate text-sm font-medium">
                {component.eventName}
              </span>
              <button
                type="button"
                onClick={() => onRemoveEvent(index)}
                className="text-muted-foreground hover:text-foreground"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>

        <div className="mt-2">
          <ComboboxEvents
            items={realEvents}
            value=""
            searchable
            onChange={(eventName) => onAddEvent(eventName)}
            placeholder="+ Add event"
          />
        </div>
      </div>
    </div>
  );
}
