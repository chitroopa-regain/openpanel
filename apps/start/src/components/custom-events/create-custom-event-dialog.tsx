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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  CustomEventEditor,
  type CustomEventForm,
} from './custom-event-editor';

export function CreateCustomEventDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (customEvent: { id: string; name: string }) => void;
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
      setForm({
        name: '',
        components: [],
      });
    }
  }, [open]);

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

    createMutation.mutate({
      name: form.name,
      projectId,
      components: form.components as any,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Custom Event</DialogTitle>
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
          <Button onClick={handleSave} disabled={createMutation.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
