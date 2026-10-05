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

  return (
    <div className="space-y-2">
      <Label htmlFor="move-lead-etapa">{t("Etapa de destino")}</Label>
      <Select
        value={conhecida ? valor : ""}
        onValueChange={(stageId) => {
          const parsed = moveLeadConfigSchema.safeParse({ stage_id: stageId });
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
