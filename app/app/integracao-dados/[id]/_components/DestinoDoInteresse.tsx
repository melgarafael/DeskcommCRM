"use client";

/**
 * ONDE NASCE O NEGÓCIO QUANDO O CLIENTE SE INTERESSA POR UM ITEM (Spec 25, R5b).
 *
 * Dois seletores: o funil e a etapa. O agente lê a escolha no resultado da
 * consulta da receita e abre o negócio ali. SEM escolha, o agente passa a
 * conversa para a equipe (handoff) em vez de abrir negócio por conta própria — e
 * a tela diz isso, para "sem destino" nunca parecer um campo esquecido.
 *
 * O valor só sobe (`onChange`) com os DOIS escolhidos: funil sem etapa não é um
 * destino, e gravar metade deixaria a instância recusada pelo servidor. Etapa de
 * ganho ou de perda não é oferecida: o interesse nasce em andamento.
 */
import { useId, useState } from "react";

import { Label } from "@/components/ui/label";
import { useEtapas, useFunis } from "@/hooks/campanhas/useDestinoDaCampanha";
import { useT } from "@/hooks/i18n/useT";

export interface DestinoEscolhido {
  pipeline_id: string;
  stage_id: string;
}

interface Props {
  valor: DestinoEscolhido | null | undefined;
  onChange: (proximo: DestinoEscolhido | null) => void;
}

export function DestinoDoInteresse({ valor, onChange }: Props) {
  const t = useT();
  const idFunil = useId();
  const idEtapa = useId();
  const [funilEscolhido, setFunilEscolhido] = useState<string>(valor?.pipeline_id ?? "");

  const funis = useFunis();
  const etapas = useEtapas(funilEscolhido || null);
  const etapasAbertas = (etapas.data ?? []).filter((e) => !e.is_won && !e.is_lost);

  return (
    <div className="col-span-1 md:col-span-4 rounded-md border border-border p-3" data-testid="destino-do-interesse">
      <p className="text-sm font-medium">{t("Para onde vai o interesse do cliente")}</p>
      <p className="mb-2 text-xs text-muted-foreground">
        {t(
          "Quando o cliente se interessar por um item, o agente abre o negócio neste funil e etapa. Sem escolha, ele passa a conversa para a equipe.",
        )}
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor={idFunil} className="text-xs text-muted-foreground">
            {t("Funil do interesse")}
          </Label>
          <select
            id={idFunil}
            value={funilEscolhido}
            onChange={(e) => {
              setFunilEscolhido(e.target.value);
              // Trocar o funil invalida a etapa anterior (era de outro funil).
              onChange(null);
            }}
            className="mt-1 block w-full rounded-md border bg-background p-2 text-sm"
          >
            <option value="">{t("Sem funil (passar para a equipe)")}</option>
            {(funis.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={idEtapa} className="text-xs text-muted-foreground">
            {t("Etapa do interesse")}
          </Label>
          <select
            id={idEtapa}
            disabled={!funilEscolhido}
            value={valor && valor.pipeline_id === funilEscolhido ? valor.stage_id : ""}
            onChange={(e) =>
              onChange(e.target.value ? { pipeline_id: funilEscolhido, stage_id: e.target.value } : null)
            }
            className="mt-1 block w-full rounded-md border bg-background p-2 text-sm"
          >
            <option value="">{t("Escolha a etapa")}</option>
            {etapasAbertas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {funilEscolhido && !valor ? (
        <p className="mt-2 text-xs text-amber-600">
          {t("Falta escolher a etapa: sem ela, o interesse continua indo para a equipe.")}
        </p>
      ) : null}
    </div>
  );
}
