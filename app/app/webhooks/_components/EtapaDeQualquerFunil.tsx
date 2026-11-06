"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { etapasPorFunil, nomeDaEtapa, useEtapasDeGatilho } from "@/hooks/followup/useEtapasDeGatilho";
import { useT } from "@/hooks/i18n/useT";

/**
 * O valor da condição "Etapa de destino" com as etapas de TODOS os funis,
 * agrupadas por funil. Antes a lista vinha só do funil padrão, e quem tinha
 * mais de um funil não conseguia escolher etapa dos outros pela tela.
 *
 * A regra continua gravando só o `stage_id`: ele é único entre funis e o motor
 * compara ids (`lib/automation/conditions.ts`), então nada muda no que é salvo
 * nem no que o motor lê.
 *
 * As etapas vêm do mesmo hook do construtor de follow-up — só as ativas, e com
 * «Etapa · Funil», porque todo funil nasce com «Novo / Ganho / Perdido».
 */
export function EtapaDeQualquerFunil({
  value,
  onChange,
}: {
  value: string;
  onChange: (stageId: string) => void;
}) {
  const t = useT();
  const { etapas, carregando, falhou } = useEtapasDeGatilho();
  const funis = etapasPorFunil(etapas);
  const conhecida = etapas.some((e) => e.stageId === value);

  return (
    <div className="flex-1 basis-40 space-y-1">
      <Select value={conhecida ? value : ""} onValueChange={onChange} disabled={carregando || falhou}>
        <SelectTrigger aria-label={t("Etapa")}>
          <SelectValue placeholder={carregando ? t("Carregando etapas…") : t("Etapa")} />
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
    </div>
  );
}
