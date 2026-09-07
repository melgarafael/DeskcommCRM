"use client";
import { createContext, useContext, useMemo, useState, useEffect, type ReactNode } from "react";
import { resetRealtimeAuthentication } from "@/lib/supabase/browser";
import { createPortal } from "react-dom";

const Context = createContext<{ begin: (label: string) => void; cancel: () => void } | null>(null);

/** Fica acima do limite user/org: a atualização RSC do cookie não remove a guarda. */
export function OrganizationTransitionProvider({ children }: { children: ReactNode }) {
  const parent = useContext(Context);
  const [pending, setPending] = useState<string | null>(null);
  const controls = useMemo(() => ({ begin: (label: string) => { resetRealtimeAuthentication(); setPending(label); }, cancel: () => setPending(null) }), []);
  useEffect(() => {
    if (parent) return;
    const changed = (event: StorageEvent) => {
      if (event.key !== "support-context-transition") return;
      resetRealtimeAuthentication();
      setPending("Atualizando acompanhamento…");
      window.location.reload();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [parent]);
  // Providers autenticados podem estar aninhados; só a raiz é dona da transição.
  if (parent) return children;
  return <Context.Provider value={controls}>
    {children}
    {pending !== null && createPortal(<div role="status" aria-live="polite" data-testid="organization-transition"
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-background text-foreground">
      {pending}
    </div>, document.body)}
  </Context.Provider>;
}

export function useOrganizationTransition() {
  const value = useContext(Context);
  if (!value) throw new Error("OrganizationTransitionProvider ausente");
  return value;
}
