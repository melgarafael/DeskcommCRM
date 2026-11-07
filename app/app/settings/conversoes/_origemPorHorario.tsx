"use client";

/**
 * "Deduzir a origem do site pelo horário do clique" — desligada por padrão
 * (doc de decisão 259, PR #3906). Salva no clique: é uma chave só.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirOrigemPorHorario } from "@/app/actions/settings/definirOrigemPorHorario";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const ERRO: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta conexão.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
};

export function OrigemPorHorario({ ligada, idioma }: { ligada: boolean; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [valor, setValor] = useState(ligada);
  const [isPending, startTransition] = useTransition();

  function mudar(novo: boolean) {
    setValor(novo);
    startTransition(async () => {
      const r = await definirOrigemPorHorario(novo);
      if (r.ok) {
        toast.success(t("Conexão salva."));
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
          <Label htmlFor="site_origin_by_click_time">
            {t("Deduzir a origem do site pelo horário do clique")}
          </Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Quando o cliente apaga o código da mensagem, a origem se perde. Ligada, o primeiro contato novo que escrever até 10 minutos depois de um clique sem dono num link deste número recebe a origem desse clique. É um palpite, não uma prova: quem escreve na mesma hora sem ter visto o site pode receber a campanha de outra pessoa. A ficha do contato marca a origem como provável. Vem desligada.",
            )}
          </p>
        </div>
        <Switch
          id="site_origin_by_click_time"
          checked={valor}
          disabled={isPending}
          onCheckedChange={mudar}
        />
      </div>
    </Card>
  );
}
