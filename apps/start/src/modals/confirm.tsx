import { ButtonContainer } from '@/components/button-container';
import { Button } from '@/components/ui/button';

import { popModal } from '.';
import { ModalContent, ModalHeader } from './Modal/Container';

export type ConfirmProps = {
  title: string;
  text: string;
  onConfirm: () => void;
  onCancel?: () => void;
  confirmVariant?: 'default' | 'destructive' | 'outline' | 'secondary';
};

export default function Confirm({
  title,
  text,
  onConfirm,
  onCancel,
  confirmVariant,
}: ConfirmProps) {
  return (
    <ModalContent>
      <ModalHeader title={title} />
      <p className="text-sm -mt-2 leading-normal text-muted-foreground">{text}</p>
      <ButtonContainer>
        <Button
          variant="outline"
          onClick={() => {
            popModal('Confirm');
            onCancel?.();
          }}
        >
          Cancel
        </Button>
        <Button
          variant={confirmVariant}
          onClick={() => {
            popModal('Confirm');
            onConfirm();
          }}
        >
          Yes
        </Button>
      </ButtonContainer>
    </ModalContent>
  );
}
