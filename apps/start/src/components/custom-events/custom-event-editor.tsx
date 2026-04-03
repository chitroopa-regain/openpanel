import { ComboboxEvents } from '@/components/ui/combobox-events';
import { Input } from '@/components/ui/input';
import { useEventNames } from '@/hooks/use-event-names';
import { XIcon } from 'lucide-react';

export interface ComponentEvent {
  eventName: string;
  filters: Array<{
    name: string;
    operator: string;
    value: (string | number | boolean | null)[];
  }>;
}

export interface CustomEventForm {
  id?: string;
  name: string;
  components: ComponentEvent[];
}

export function CustomEventEditor({
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
              key={`${component.eventName}-${index}`}
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
