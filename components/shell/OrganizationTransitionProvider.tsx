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
  // Aviso que ESTA aba já tratou: ela navegou logo depois — gravando o aviso ela
  // mesma (#1879) ou na recarga que ele acabou de disparar (#2800) —, então este
  // documento já é o novo. O relógio não separa os dois (o início fica a menos de
  // 1 ms do carimbo) e a inbox se recarregava sozinha ao sair do acompanhamento.
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
    // A aba que reage ao aviso — pela comparação do mount ou pelo evento
    // `storage` — marca em sessionStorage QUAL carimbo ela já tratou, para o
    // documento que ela abre em seguida nascer com `aviso === desta` e não
    // recarregar de novo. Sem a marca, a aba VIZINHA caía na comparação de
    // relógio: `Date.now()` em ms inteiro não separa o início do documento do
    // carimbo (margem de −0,2 a 0,00 ms medida no run 38125887558, do #2800),
    // a recarga do `storage` abria um documento que se recarregava outra vez e
    // a aba vizinha carregava duas vezes. sessionStorage é por aba e sobrevive
    // à recarga — o mesmo desenho do #1879, que a prodora grava para si.
    const reload = () => {
      try {
        const consumido = localStorage.getItem(AVISO);
        if (consumido !== null) sessionStorage.setItem(AVISO, consumido);
      } catch { /* armazenamento bloqueado: a aba segue sem o carimbo */ }
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
