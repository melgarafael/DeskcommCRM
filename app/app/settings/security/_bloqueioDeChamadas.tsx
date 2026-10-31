"use client";

/**
 * "Bloquear chamadas recebidas" — desligada por padrão. Salva no clique: é uma
 * chave só, sem formulário em volta.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirBloqueioDeChamadas } from "@/app/actions/settings/definirBloqueioDeChamadas";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

const ERRO: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta opção.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
};

export function BloqueioDeChamadas({ ligado }: { ligado: boolean }) {
  const t = useT();
  const router = useRouter();
  const [valor, setValor] = useState(ligado);
  const [isPending, startTransition] = useTransition();

  function mudar(novo: boolean) {
    setValor(novo);
    startTransition(async () => {
      const r = await definirBloqueioDeChamadas(novo);
      if (r.ok) {
        toast.success(t("Opção salva."));
        router.refresh();
        return;
      }
      setValor(!novo);
      toast.error(t(ERRO[r.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="block_incoming_calls">{t("Bloquear chamadas recebidas")}</Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Quando alguém liga por voz para o WhatsApp dos seus números, a chamada é recusada sozinha. As mensagens continuam chegando normalmente. Vem desligado: a chamada toca como antes.",
            )}
          </p>
        </div>
        <Switch
          id="block_incoming_calls"
          checked={valor}
          disabled={isPending}
          onCheckedChange={mudar}
        />
      </div>
    </Card>
  );
}
