"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ConfirmOptions = string | {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type PendingConfirm = {
  options: Exclude<ConfirmOptions, string>;
  resolve: (value: boolean) => void;
};

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirm = useCallback((input: ConfirmOptions) => new Promise<boolean>((resolve) => {
    const options = typeof input === "string" ? { title: input } : input;
    setPending((current) => {
      current?.resolve(false);
      return { options, resolve };
    });
  }), []);

  const finish = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) finish(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.options.title}</AlertDialogTitle>
            {pending?.options.description && <AlertDialogDescription>{pending.options.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => finish(false)}>{pending?.options.cancelLabel ?? "Cancelar"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => finish(true)}
              className={pending?.options.destructive ? "bg-error text-white hover:brightness-95" : undefined}
            >
              {pending?.options.confirmLabel ?? "Confirmar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  // Component tests and isolated embeds can render an action without the app
  // shell. In that case the safe result is cancellation, never a browser
  // confirm() fallback.
  return confirm ?? (() => Promise.resolve(false));
}
