"use client";
import { useT } from "@/hooks/i18n/useT";
import { useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AVISO,
  useOrganizationTransition,
} from "@/components/shell/OrganizationTransitionProvider";

const assinarHidratacao = () => () => {};
const hidratadoNoCliente = () => true;
const hidratadoNoServidor = () => false;

export interface ImpersonatingInfo {
  agencyId?: string;
  tenantId: string;
  tenantName: string;
  expiresAt: string;
  accessMode?: "full" | "support_readonly";
}
export function notifySupportTransition() {
  const carimbo = String(Date.now());
  localStorage.setItem(AVISO, carimbo);
  // Por aba: o documento que esta aba abre em seguida reconhece o próprio aviso.
  sessionStorage.setItem(AVISO, carimbo);
}
export function ImpersonateBanner({
  impersonating,
  ended = false,
}: {
  impersonating: ImpersonatingInfo | null;
  ended?: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const hidratado = useSyncExternalStore(assinarHidratacao, hidratadoNoCliente, hidratadoNoServidor);
  const transition = useOrganizationTransition();
  useEffect(() => {
    if (!impersonating || ended) return;
    const timer = setTimeout(
      () => {
        transition.begin("Acompanhamento encerrado. Confirmando acesso…");
        window.location.assign("/support-ended");
      },
      Math.max(0, new Date(impersonating.expiresAt).getTime() - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [impersonating, ended, transition]);
  if (!impersonating) return null;
  async function handleEnd() {
    flushSync(() => {
      setBusy(true);
      transition.begin("Encerrando acompanhamento…");
    });
    try {
      const res = await fetch(
        impersonating?.agencyId
          ? "/api/v1/agencia/sessao/encerrar"
          : "/api/v1/admin/impersonate/end",
        { method: "POST" },
      );
      if (!res.ok) throw new Error("Não foi possível encerrar o acompanhamento. Tente novamente.");
      notifySupportTransition();
      window.location.assign(impersonating?.agencyId ? "/app/settings/organizacoes" : "/app/inbox");
    } catch (error) {
      transition.cancel();
      setBusy(false);
      toast.error(error instanceof Error ? error.message : "Falha de conexão.");
    }
  }
  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex items-center justify-between gap-4 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-950"
    >
      <span>
        {ended
          ? t("Acompanhamento encerrado")
          : impersonating.agencyId
            ? t("Administrando cliente da agência")
            : t("Suporte à organização")}{" "}
        <strong>{impersonating.tenantName}</strong>
        {!ended &&
          (impersonating.accessMode === "support_readonly"
            ? ` — ${t("Somente leitura")}`
            : ` — ${t("Edição permitida")}`)}
      </span>
      <Button size="sm" variant="outline" onClick={handleEnd} disabled={busy || !hidratado}>
        {impersonating.agencyId ? t("Voltar à agência") : t("Sair do acompanhamento")}
      </Button>
    </div>
  );
}
