"use client";
import { createContext, useContext, useMemo, useState, useEffect, type ReactNode } from "react";
import { resetRealtimeAuthentication } from "@/lib/supabase/browser";
import { createPortal } from "react-dom";

const Context = createContext<{ begin: (label: string) => void; cancel: () => void } | null>(null);
export const AVISO = "support-context-transition";

/** Aviso gravado depois de ESTE documento começar a carregar: ele pode ter sido renderizado com o contexto anterior. */
function avisoPosteriorAoDocumento() {
  let aviso: string | null, desta: string | null;
  // Armazenamento bloqueado: ninguém conseguiu gravar o aviso, então não há o que perder.
  try { aviso = localStorage.getItem(AVISO); desta = sessionStorage.getItem(AVISO); } catch { return false; }
  // Aviso que ESTA aba gravou: ela navegou logo depois, então este documento já é o novo.
  // O relógio não separa os dois (o início fica a menos de 1 ms do carimbo) e a inbox
  // se recarregava sozinha ao sair do acompanhamento (#1879).
  if (aviso === desta) return false;
  // Mesmo relógio (`Date.now`) de quem grava; `performance.timeOrigin` pode divergir dele.
  return Number(aviso) > Date.now() - performance.now();
}

/** Fica acima do limite user/org: a atualização RSC do cookie não remove a guarda. */
export function OrganizationTransitionProvider({ children }: { children: ReactNode }) {
  const parent = useContext(Context);
  const [pending, setPending] = useState<string | null>(null);
  const controls = useMemo(() => ({ begin: (label: string) => { resetRealtimeAuthentication(); setPending(label); }, cancel: () => setPending(null) }), []);
  useEffect(() => {
    if (parent) return;
    const reload = () => {
      resetRealtimeAuthentication();
      setPending("Atualizando acompanhamento…");
      window.location.reload();
    };
    const changed = (event: StorageEvent) => { if (event.key === AVISO) reload(); };
    window.addEventListener("storage", changed);
    // `storage` só chega a quem já ouve: o aviso dado entre o início do carregamento e a
    // hidratação se perdia, e a aba ficava na organização anterior (#2471). O documento
    // novo começa depois do aviso, então não recarrega de novo.
    if (avisoPosteriorAoDocumento()) reload();
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
