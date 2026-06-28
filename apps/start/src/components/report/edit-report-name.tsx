import { PencilIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Input } from '../ui/input';
import { setName } from './reportSlice';
import { useDispatch, useSelector } from '@/redux';

interface Props {
  onSubmit?: (name: string) => void;
}

const EditReportName = ({ onSubmit: onSubmitName }: Props) => {
  const reportName = useSelector((state) => state.report.name);
  const dispatch = useDispatch();
  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(reportName);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitGuardRef = useRef(false);

  useEffect(() => {
    setNewName(reportName);
  }, [reportName]);

  const onSubmit = () => {
    if (submitGuardRef.current) {
      return;
    }

    submitGuardRef.current = true;
    const nextName = newName.trim();

    if (!nextName) {
      setNewName(reportName);
      return setIsEditing(false);
    }

    if (nextName === reportName) {
      setNewName(nextName);
      return setIsEditing(false);
    }

    setNewName(nextName);
    setIsEditing(false);
    dispatch(setName(nextName));
    onSubmitName?.(nextName);
  };

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
    }
  }, [isEditing]);

  if (isEditing) {
    return (
      <div className="flex h-8">
        <Input
          onBlur={() => onSubmit()}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              onSubmit();
            }
          }}
          ref={inputRef}
          type="text"
          value={newName}
        />
      </div>
    );
  }

  return (
    <button
      className="group flex h-8 max-w-full min-w-0 cursor-pointer select-none items-center gap-2 font-medium text-xl"
      onClick={() => {
        submitGuardRef.current = false;
        setIsEditing(true);
      }}
      title={newName || 'Unnamed Report'}
      type="button"
    >
      <span className="min-w-0 truncate">{newName || 'Unnamed Report'}</span>
      <PencilIcon
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        size={16}
      />
    </button>
  );
};

export default EditReportName;
