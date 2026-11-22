"use client";
/**
 * A lista de cards de uma coluna do quadro, memoizada (#4788).
 *
 * O `Droppable` do @hello-pangea/dnd chama a função filha de novo a cada
 * mudança de `snapshot.isDraggingOver`: passar um card por cima de uma coluna
 * com milhares de negócios redesenhava todos eles a cada entrada e saída. Esta
 * lista recebe só props estáveis e fica de fora desse redesenho — é o
 * "InnerList" que a documentação do dnd recomenda. Cada card também é
 * memoizado, com o `buildCardInput` calculado uma vez por negócio: marcar um
 * card ou receber um pulso redesenha só ele.
 *
 * O tempo na etapa, o selo de esfriando e o "em Xh" da retomada dependem do
 * relógio, não só do negócio. Com o memo, nada mais redesenha o card por
 * acaso; por isso a lista tem um relógio de minuto (`useAgora`) que entra no
 * `buildCardInput`: uma vez por minuto todos os cards da coluna se redesenham,
 * e entre os minutos o memo segue barrando o resto.
 */
import { memo, useEffect, useMemo, useState } from "react";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";
import { buildCardInput } from "@/lib/kanban/card-state";
import { KanbanCard, type GestoDeSelecao } from "./KanbanCard";

interface Comum {
  stageName: string;
  pipelineId: string;
  ownerNames?: Map<string, string | null>;
  coolingIds?: Set<string>;
  reactivations?: Map<string, { proposalId: string; expiresAt: string }>;
  canonicalTags?: string[];
  onSelect?: (leadId: string, gesto: GestoDeSelecao) => void;
  onOpen?: (leadId: string) => void;
  etapas?: Stage[];
  onMoverPara?: (lead: Lead, stageId: string) => void;
  denso?: boolean;
  somenteLeitura?: boolean;
}

/** De quanto em quanto tempo o relógio dos cards anda. */
export const TIQUE_DO_RELOGIO_MS = 60_000;

/** `Date.now()` que só muda a cada tique: estável entre um tique e outro. */
function useAgora(): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAgora(Date.now()), TIQUE_DO_RELOGIO_MS);
    return () => clearInterval(id);
  }, []);
  return agora;
}

const CardDaColuna = memo(function CardDaColuna({
  lead,
  index,
  agora,
  stageName,
  ownerNames,
  coolingIds,
  reactivations,
  canonicalTags,
  isSelected,
  isSelecting,
  pulseCount,
  ...resto
}: Comum & {
  lead: Lead;
  index: number;
  agora: number;
  isSelected: boolean;
  isSelecting: boolean;
  pulseCount: number;
}) {
  const card = useMemo(
    () =>
      buildCardInput(lead, {
        stageName,
        ownerNames,
        coolingIds,
        reactivations,
        canonicalTags,
        now: new Date(agora),
      }),
    [lead, stageName, ownerNames, coolingIds, reactivations, canonicalTags, agora],
  );
  return (
    <KanbanCard
      card={card}
      lead={lead}
      index={index}
      isSelected={isSelected}
      isSelecting={isSelecting}
      pulseCount={pulseCount}
      {...resto}
    />
  );
});

export const CardsDaColuna = memo(function CardsDaColuna({
  leads,
  selectedLeadIds,
  pulses,
  ...comum
}: Comum & {
  leads: Lead[];
  selectedLeadIds?: Set<string>;
  pulses?: Map<string, number>;
}) {
  const selecionando = (selectedLeadIds?.size ?? 0) > 0;
  const agora = useAgora();
  return (
    <>
      {leads.map((lead, idx) => (
        <CardDaColuna
          key={lead.id}
          lead={lead}
          index={idx}
          agora={agora}
          isSelected={Boolean(selectedLeadIds?.has(lead.id))}
          isSelecting={selecionando}
          pulseCount={pulses?.get(lead.id) ?? 0}
          {...comum}
        />
      ))}
    </>
  );
});
