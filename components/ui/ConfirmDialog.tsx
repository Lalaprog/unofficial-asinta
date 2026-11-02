'use client';

import React from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm action in the destructive style. */
  destructive?: boolean;
  /** Keep the dialog and controls locked while an action is being confirmed. */
  isPending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app replacement for window.confirm(). Native dialogs block the main
 * thread, cannot be styled, and look out of place beside the custom Modal —
 * especially on mobile, where this renders as a bottom sheet.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  isPending = false,
  onConfirm,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      description={message}
      maxWidth="sm"
      role="alertdialog"
      dismissOnBackdrop={false}
      dismissOnEscape={!isPending}
      showCloseButton={!isPending}
    >
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={destructive ? 'danger' : 'primary'}
          size="sm"
          onClick={onConfirm}
          isLoading={isPending}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
};

ConfirmDialog.displayName = 'ConfirmDialog';
