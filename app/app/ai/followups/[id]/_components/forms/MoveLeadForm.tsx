"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { etapasPorFunil, nomeDaEtapa } from "@/hooks/followup/useEtapasDeGatilho";
import { useT } from "@/hooks/i18n/useT";
import { moveLeadConfigSchema } from "@/lib/followup/graph-schema";
import { motivosDoFunil, opcoesDeMotivoDePerda } from "@/lib/leads/motivos-de-perda-do-funil";
import { rotuloDoMotivoDePerda } from "@/lib/schemas/leads";

import { useEtapasDoFluxo } from "../EtapasDoFluxo";
import type { ConfigOf } from "./shared";

/**
 * O nó `move_lead` (#2065) — escolher para qual etapa o card vai.
 *
 * A etapa é ESCOLHIDA, nunca digitada (a mesma decisão do `ValorDeEtapa` da
 * condição): o motor grava `stage_id` e o `moveLeadHandler` compara ids — texto
 * digitado nunca casa. O seletor é o mesmo do construtor (funis agrupados, uma
 * leitura só via `EtapasDoFluxoProvider`), e o candidato só vira nó vivo quando
 * passa no `moveLeadConfigSchema`.
 *
 * Destino em etapa de perda exige o motivo da perda no próprio bloco: sem ele
 * o publish recusa (`motivo_da_perda_ausente`), porque o motor seria recusado
 * com 422 e o fluxo seguiria como se o card tivesse andado. As opções são as
 * MESMAS da janela "Marcar como perdido" do quadro (canônicos + motivos do
 * funil) — nada de segunda lista. Trocar de etapa descarta o motivo que não
 * está nas opções do funil de destino, para não guardar um motivo que o
 * publish recusaria (`motivo_da_perda_invalido`).
 */
export function MoveLeadForm({
  config,
  onChange,
}: {
  config: ConfigOf<"move_lead">;
  onChange: (c: ConfigOf<"move_lead">) => void;
}) {
  const t = useT();
  const { etapas, carregando, falhou } = useEtapasDoFluxo();
  const funis = etapasPorFunil(etapas);
  const valor = config.stage_id;
  const conhecida = funis.some((f) => f.etapas.some((e) => e.stageId === valor));
  const etapaEscolhida = etapas.find((e) => e.stageId === valor);
  const ehPerda = etapaEscolhida?.isPerda === true;
  const motivoAtual = (config.lost_reason ?? "").trim();
  const opcoes = opcoesDeMotivoDePerda(motivosDoFunil(etapaEscolhida?.settingsDoFunil ?? null));
  const motivoNaLista = motivoAtual !== "" && opcoes.some((o) => o.valor === motivoAtual);

  return (
    <div className="space-y-2">
      <Label htmlFor="move-lead-etapa">{t("Etapa de destino")}</Label>
      <Select
        value={conhecida ? valor : ""}
        onValueChange={(stageId) => {
          const destino = etapas.find((e) => e.stageId === stageId);
          const motivoMantido = (config.lost_reason ?? "").trim();
          // Só mantém o motivo se ele existe nas opções do funil DE DESTINO:
          // motivo de outro funil passaria no seletor vazio e cairia no
          // `motivo_da_perda_invalido` do publish, longe de quem pode corrigir.
          const opcoesDoDestino = opcoesDeMotivoDePerda(motivosDoFunil(destino?.settingsDoFunil ?? null));
          const parsed =
            destino?.isPerda === true && motivoMantido && opcoesDoDestino.some((o) => o.valor === motivoMantido)
              ? moveLeadConfigSchema.safeParse({ stage_id: stageId, lost_reason: motivoMantido })
              : moveLeadConfigSchema.safeParse({ stage_id: stageId });
          if (parsed.success) onChange(parsed.data);
        }}
        disabled={carregando || falhou}
      >
        <SelectTrigger id="move-lead-etapa" aria-label={t("Etapa de destino")}>
          <SelectValue placeholder={carregando ? t("Carregando etapas…") : t("Escolha a etapa")} />
        </SelectTrigger>
        <SelectContent>
          {funis.map((funil) => (
            <SelectGroup key={funil.id}>
              <SelectLabel>{funil.nome}</SelectLabel>
              {funil.etapas.map((etapa) => (
                <SelectItem key={etapa.stageId} value={etapa.stageId}>
                  {nomeDaEtapa(etapa)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {ehPerda && (
        <div className="space-y-2">
          <Label htmlFor="move-lead-motivo">{t("Motivo da perda")}</Label>
          <Select
            value={motivoNaLista ? motivoAtual : ""}
            onValueChange={(motivo) => {
              const parsed = moveLeadConfigSchema.safeParse(
                motivo ? { stage_id: valor, lost_reason: motivo } : { stage_id: valor },
              );
              if (parsed.success) onChange(parsed.data);
            }}
            disabled={carregando || falhou}
          >
            <SelectTrigger id="move-lead-motivo" aria-label={t("Motivo da perda")}>
              <SelectValue placeholder={t("Escolha o motivo")} />
            </SelectTrigger>
            <SelectContent>
              {opcoes.map((opcao) => (
                <SelectItem key={opcao.valor} value={opcao.valor}>
                  {opcao.doFunil ? opcao.valor : t(rotuloDoMotivoDePerda(opcao.valor))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {ehPerda && !motivoNaLista && (
            <p role="alert" className="text-xs text-destructive">
              {t("Escolha o motivo da perda.")}
            </p>
          )}
        </div>
      )}
      {falhou && (
        <p className="text-xs text-warning-fg">
          {t(
            "Não consegui carregar as etapas agora. O que estava escolhido continua salvo — recarregue a página para escolher outra.",
          )}
        </p>
      )}
      <p className="text-xs text-text-muted">
        {t("O card vai para esta etapa do mesmo funil — trocar de funil é recusado, como no quadro.")}
      </p>
    </div>
  );
}
