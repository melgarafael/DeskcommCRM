"use client";

/**
 * O cadastro da meta mensal (issue #3025, fatia 1).
 *
 * Um mês e um número. O formulário não escolhe o indicador nem o funil: nesta
 * fatia o indicador é um só (vendas ganhas) e o escopo é a empresa — oferecer um
 * seletor com uma opção seria prometer o que a fatia seguinte traz.
 *
 * Cada recusa vira uma frase que diz O QUE FAZER, como as vizinhas de
 * Configurações: "forbidden_role" mandaria um atendente tentar de novo para
 * falhar igual, então ela diz quem pode.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirMetaMensal } from "@/app/actions/settings/definirMetaMensal";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: o mês e a quantidade precisam estar preenchidos.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só quem administra a empresa pode definir a meta.",
  erro_ao_gravar: "Não consegui gravar a meta agora. Tente de novo em instantes.",
};

export function FormularioDaMeta({
  mes,
  alvoAtual,
}: {
  mes: string;
  alvoAtual: number | null;
}) {
  const t = useT();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [periodo, setPeriodo] = useState(mes);
  const [alvo, setAlvo] = useState(alvoAtual === null ? "" : String(alvoAtual));

  const numero = Number.parseInt(alvo, 10);
  const podeSalvar = /^\d{4}-\d{2}$/.test(periodo) && Number.isInteger(numero) && numero > 0;

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    if (!podeSalvar) {
      toast.error(t("Informe um mês e uma quantidade de vendas maior que zero."));
      return;
    }
    startTransition(async () => {
      const resultado = await definirMetaMensal({ periodo, alvo: numero });
      if (resultado.ok) {
        toast.success(t("Meta salva."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar a meta agora."));
    });
  }

  return (
    <Card className="max-w-xl p-6">
      <form onSubmit={salvar} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="periodo">{t("Mês")}</Label>
          <Input
            id="periodo"
            type="month"
            value={periodo}
            onChange={(e) => setPeriodo(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("A meta vale para o mês escolhido, do dia 1º ao último.")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="alvo">{t("Vendas ganhas no mês")}</Label>
          <Input
            id="alvo"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={alvo}
            onChange={(e) => setAlvo(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {alvoAtual === null
              ? t("Ainda não há meta para este mês.")
              : t("Salvar de novo corrige a meta deste mês — nada é duplicado.")}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isPending || !podeSalvar}>
            {isPending ? t("Salvando…") : t("Salvar meta")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
