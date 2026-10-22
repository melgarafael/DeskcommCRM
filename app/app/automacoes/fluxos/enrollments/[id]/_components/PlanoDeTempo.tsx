"use client";

import { Badge } from "@/components/ui/badge";
import { descreveEspera, type TimingPlan } from "@/lib/followup/plano-de-tempo";
import type { NoDoDossie } from "@/lib/followup/eventos-legiveis";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  plano: TimingPlan | null;
  nos: NoDoDossie[];
  /** Quando o plano foi decidido, em texto relativo já formatado por quem chama. */
  decididoRelativo: string | null;
}

/**
 * O tempo que o agente escolheu, e se ele bateu no seu limite.
 *
 * `clampado` ganha destaque de propósito: quer dizer "a IA queria mais tempo do
 * que você permitiu", e isso é informação sobre a SUA CONFIGURAÇÃO, não sobre a
 * execução — quem lê precisa saber que mexer no nó mudaria o resultado. Sem a
 * marca, a tela mostraria o teto como se fosse escolha, que é exatamente o
 * defeito que o modo adaptativo tinha antes de existir de verdade.
 *
 * Sem plano, NÃO desenha bloco nenhum: fluxo v1 e espera fixa não tiveram
 * decisão de IA, e um vazio ali sugeriria que houve uma e se perdeu.
 */
export function PlanoDeTempoBloco({ plano, nos, decididoRelativo }: Props) {
  const t = useT();
  if (!plano) return null;
  const porId = Object.fromEntries(nos.map((n) => [n.id, n]));

  return (
    <section className="rounded-md border border-border p-4" data-testid="dossie-plano-de-tempo">
      <header className="mb-3">
        <h2 className="text-sm font-medium">{t("O tempo que o agente escolheu")}</h2>
        <p className="text-xs text-text-muted">
          {t("Decidido")} {decididoRelativo ?? t("no início do follow-up")}
          {plano.modelo ? ` · ${plano.modelo}` : ""}
        </p>
      </header>
      <ul className="flex flex-col gap-3">
        {Object.entries(plano.esperas).map(([nodeId, espera]) => {
          const d = descreveEspera(espera);
          return (
            <li key={nodeId} className="flex flex-col gap-0.5" data-testid="dossie-espera">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-text">{porId[nodeId]?.rotulo ?? nodeId}</span>
                <span className="text-sm font-medium text-text">{t("esperar")} {d.escolhido}</span>
                {espera.clampado && (
                  <Badge variant="warning" data-testid="dossie-espera-clampada">
                    {t("bateu no seu limite")}
                  </Badge>
                )}
              </div>
              {/*
                O TAMANHO do corte, não só o fato dele. "Bateu no seu limite"
                diz que houve corte; é a diferença que decide se o operador vai
                mexer no nó — e o produtor guarda `proposto_ms` justamente para
                esta linha existir.
              */}
              {d.pedido && (
                <p className="text-xs text-warning-fg" data-testid="dossie-espera-pedido">
                  {t("a IA pediu")} {d.pedido}
                </p>
              )}
              <p className="text-xs text-text-muted">{d.motivo}</p>
              <p className="text-[11px] text-text-muted">{d.faixa}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
