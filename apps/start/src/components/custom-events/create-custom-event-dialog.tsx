import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  CustomEventEditor,
  type ComponentEvent,
  type CustomEventForm,
} from './custom-event-editor';

export function CreateCustomEventDialog({
  open,
  onOpenChange,
  initialValue,
  onCreated,
  onSaved,
  modal = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValue?: CustomEventForm | null;
  onCreated?: (customEvent: { id: string; name: string }) => void;
  onSaved?: (customEvent: {
    id: string;
    name: string;
    components: ComponentEvent[];
  }) => void;
  modal?: boolean;
}) {
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CustomEventForm>({
    name: '',
    components: [],
  });

  useEffect(() => {
    if (open) {
      setForm(
        initialValue ?? {
          name: '',
          components: [],
        }
      );
    }
  }, [initialValue, open]);

  const createMutation = useMutation(
    trpc.customEvent.create.mutationOptions({
      onSuccess(result) {
        toast('Custom event created');
        queryClient.invalidateQueries({
          queryKey: trpc.customEvent.list.queryKey({ projectId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.chart.events.queryKey({ projectId }),
        });
        onCreated?.({
          id: result.id,
          name: result.name,
        });
        onSaved?.({
          id: result.id,
          name: result.name,
          components: result.components as unknown as ComponentEvent[],
        });
        onOpenChange(false);
      },
    })
  );

  const updateMutation = useMutation(
    trpc.customEvent.update.mutationOptions({
      onSuccess(result) {
        toast('Custom event updated');
        queryClient.invalidateQueries({
          queryKey: trpc.customEvent.list.queryKey({ projectId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.chart.events.queryKey({ projectId }),
        });
        onSaved?.({
          id: result.id,
          name: result.name,
          components: result.components as unknown as ComponentEvent[],
        });
        onOpenChange(false);
      },
    })
  );

  const addComponentEvent = (eventName: string) => {
    setForm((prev) => ({
      ...prev,
      components: [...prev.components, { eventName, filters: [] }],
    }));
  };

  const removeComponentEvent = (index: number) => {
    setForm((prev) => ({
      ...prev,
      components: prev.components.filter((_, i) => i !== index),
    }));
  };

  const handleSave = () => {
    if (!form.name || form.components.length === 0) {
      toast.error('Name and at least one event required');
      return;
    }

    if (form.id) {
      updateMutation.mutate({
        id: form.id,
        name: form.name,
        projectId,
        components: form.components as any,
      });
    } else {
      createMutation.mutate({
        name: form.name,
        projectId,
        components: form.components as any,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {form.id ? 'Edit Custom Event' : 'Create Custom Event'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {form.id
              ? 'Edit the custom event name and component events.'
              : 'Create a custom event by naming it and selecting one or more component events.'}
          </DialogDescription>
        </DialogHeader>

        <CustomEventEditor
          value={form}
          onChange={setForm}
          onAddEvent={addComponentEvent}
          onRemoveEvent={removeComponentEvent}
          projectId={projectId}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
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
  );
}
