"use client";

import { useT } from "@/hooks/i18n/useT";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Stage } from "@/lib/kanban/types";

/**
 * Mudar a etapa SEM sair do dossiê.
 *
 * Antes, o dossiê só MOSTRAVA a etapa (um texto no cabeçalho): quem abria o
 * negócio para agir tinha de fechar o painel, achar o card na coluna e
 * arrastá-lo — ou ir até a conversa, que tem o seletor desde a #2871. O dossiê
 * é justamente onde se decide o próximo passo, e era a única superfície do
 * negócio sem como dá-lo.
 *
 * Quem move é QUEM CHAMA (`onMudar`), não este componente: no quadro é o mesmo
 * caminho do "Mover para…" do card (`aoMoverPelaLista` → `moverPara`), então o
 * card entra no TOPO da etapa de destino (#3461), a recusa por campos obrigatórios abre o MESMO
 * diálogo (#1536), a trava de `updated_at` é a mesma, e a etapa de PERDA pede o
 * motivo pela MESMA janela do quadro antes do move. Decidir a perda aqui seria
 * uma segunda cópia dessa regra.
 *
 * Sem permissão de mover (ou sem a lista de etapas — ex.: o calendário, que
 * ainda não a passa), fica o texto de antes: um seletor que recusa no clique
 * seria pior que nenhum.
 */
export function EtapaNoDossie({
  etapaAtual,
  etapas,
  podeMover,
  onMudar,
}: {
  etapaAtual: string;
  etapas: Pick<Stage, "id" | "name">[];
  podeMover: boolean;
  onMudar: (stageId: string) => void;
}) {
  const t = useT();
  const nomeAtual = etapas.find((e) => e.id === etapaAtual)?.name ?? "—";

  if (!podeMover || etapas.length === 0) {
    return <span className="text-text-muted">{nomeAtual}</span>;
  }

  function escolher(stageId: string) {
    if (stageId === etapaAtual) return;
    onMudar(stageId);
  }

  return (
    <span data-testid="dossie-etapa">
      <Select value={etapaAtual} onValueChange={escolher}>
        <SelectTrigger aria-label={t("Etapa do funil")} className="h-7 w-auto gap-1 px-2 text-xs" data-testid="dossie-etapa-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {etapas.map((e) => (
            <SelectItem key={e.id} value={e.id} className="text-xs">
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}
