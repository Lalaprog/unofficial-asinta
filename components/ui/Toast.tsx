'use client';

import React, { createContext, useCallback, useContext, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextType {
  showToast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

let nextToastId = 1;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (type: ToastType, message: string) => {
      const id = nextToastId++;
      setToasts((prev) => [...prev, { id, type, message }].slice(-4));
      const duration = type === 'error' ? 8000 : type === 'success' ? 3500 : 4500;
      setTimeout(() => dismissToast(id), duration);
    },
    [dismissToast]
  );

  const value = React.useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Toast viewport */}
      <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] right-4 z-[9999] flex flex-col gap-2 w-[min(92vw,380px)] lg:bottom-4">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`flex items-start gap-2.5 p-3.5 rounded-2xl border shadow-lg text-xs font-medium animate-in fade-in slide-in-from-bottom-2 ${
              toast.type === 'error'
                ? 'bg-status-danger-bg border-status-danger/20 text-status-danger'
                : toast.type === 'success'
                ? 'bg-status-success-bg border-status-success/20 text-status-success'
                : 'bg-white border-surface-border text-navy'
            }`}
          >
            {toast.type === 'error' ? (
              <AlertCircle className="w-4 h-4 shrink-0 text-status-danger mt-0.5" />
            ) : toast.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-status-success mt-0.5" />
            ) : (
              <Info className="w-4 h-4 shrink-0 text-navy mt-0.5" />
            )}
            <span className="min-w-0 flex-1 max-h-[40dvh] overflow-y-auto break-words [overflow-wrap:anywhere] leading-relaxed">{toast.message}</span>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg hover:bg-black/5 text-current"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};
