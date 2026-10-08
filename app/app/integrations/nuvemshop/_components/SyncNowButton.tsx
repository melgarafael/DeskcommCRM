"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { syncNuvemshopNow } from "@/app/actions/integrations/syncNuvemshopNow";
import { useT } from "@/hooks/i18n/useT";

const ERROS: Record<string, string> = {
  sync_em_andamento: "Já está sincronizando.",
  desautorizada: "A loja revogou o acesso. Desconecte e conecte de novo.",
  nao_conectada: "Integração não está conectada.",
  forbidden: "Apenas admins podem sincronizar.",
  falha_ao_iniciar: "Não foi possível iniciar a sincronização. Tente de novo.",
};

export function SyncNowButton() {
  const t = useT();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await syncNuvemshopNow();
          if (res.ok) toast.success(t("Sincronização iniciada."));
          else toast.error(t(ERROS[res.error] ?? "Não foi possível iniciar a sincronização. Tente de novo."));
        })
      }
    >
      {pending ? t("Iniciando…") : t("Sincronizar agora")}
    </Button>
  );
}
