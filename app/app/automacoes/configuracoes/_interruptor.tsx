"use client";

/**
 * O interruptor POR EMPRESA do passo `ai_decide` (#2367).
 *
 * Salva no clique: é uma chave só, sem formulário em volta — mesmo desenho de
 * `../conversoes/_vendaPeloCanal.tsx`. O que a chave faz (e por que o padrão é
 * LIGADO) está em `lib/automation/ai-decide-da-org.ts`.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirAiDecideDaEmpresa } from "@/app/actions/settings/definirAiDecideDaEmpresa";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const ERRO: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um gerente ou administrador da organização pode mudar esta configuração.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
};

export function InterruptorAiDecide({ ligado, idioma }: { ligado: boolean; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [valor, setValor] = useState(ligado);
  const [isPending, startTransition] = useTransition();

  function mudar(novo: boolean) {
    setValor(novo);
    startTransition(async () => {
      const r = await definirAiDecideDaEmpresa(novo);
      if (r.ok) {
        toast.success(t("Configuração salva."));
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
          <Label htmlFor="ai_decide_empresa">{t("A IA pode decidir entre as opções de uma regra")}</Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Com o interruptor desligado, nenhuma regra consulta o modelo: o passo a IA decide é pulado e o motivo aparece na aba Atividade. As regras sem esse passo continuam rodando igual. O padrão é ligado, para não quebrar regra já gravada.",
            )}
          </p>
        </div>
        <Switch
          id="ai_decide_empresa"
          checked={valor}
          disabled={isPending}
          onCheckedChange={mudar}
        />
      </div>
    </Card>
  );
}
