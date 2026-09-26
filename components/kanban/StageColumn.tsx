"use client";
import { Droppable } from "@hello-pangea/dnd";
import { useRef, type CSSProperties } from "react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";
import { buildCardInput } from "@/lib/kanban/card-state";
import { intervaloDaColuna } from "@/lib/kanban/selecao";
import { formatCents, MOEDA_PADRAO } from "@/lib/money";
import { KanbanCard, type GestoDeSelecao } from "./KanbanCard";

interface StageColumnProps {
  stage: Stage;
  leads: Lead[];
  pipelineId: string;
  /** owner_user_id → nome, resolvido no board. O dono agente vem no lead. */
  ownerNames?: Map<string, string | null>;
  /** ids que o radar classificou como esfriando (fonte única, não recalculada). */
  coolingIds?: Set<string>;
  /** Propostas de retomada vivas, por lead. */
  reactivations?: Map<string, { proposalId: string; expiresAt: string }>;
  /** `settings.canonical_tags` do pipeline — a única tag que fica no card. */
  canonicalTags?: string[];
  selectedLeadIds?: Set<string>;
  /** leadId → quantos eventos remotos já chegaram (muda = pulsa de novo). */
  pulses?: Map<string, number>;
  /**
   * Marca/desmarca um conjunto de uma vez — a etapa inteira, ou o intervalo do
   * shift+clique. Existe separado de `onSelect` porque a coluna é a única que
   * sabe a ordem VISÍVEL dos cards (é ela que recebe a lista já filtrada), e
   * resolver o intervalo no board significaria reconstruir essa ordem lá.
   */
  onSelectMany?: (leadIds: string[], marcar: boolean) => void;
  /** Abrir o dossiê — atravessa o board até o card, como `pulses`. */
  onOpen?: (leadId: string) => void;
}

export function StageColumn({
  stage,
  leads,
  pipelineId,
  ownerNames,
  coolingIds,
  reactivations,
  canonicalTags,
  selectedLeadIds,
  pulses,
  onSelectMany,
  onOpen,
}: StageColumnProps) {
  const t = useT();
  const totalCents = leads.reduce((sum, l) => sum + (l.value_cents ?? 0), 0);
  // O total saía SEMPRE em R$: a coluna tinha a sexta cópia do formatador de
  // dinheiro (`formatBRL`, locale e moeda em duro), e a moeda em duro é o que a
  // cópia escondia. Numa organização em peso ou dólar o número estava certo e o
  // símbolo mentia — o mesmo defeito que `formatCents` existe para acabar.
  //
  // A moeda vem do primeiro lead COM valor, não de um padrão: é o dado real da
  // coluna. Somar moedas diferentes num total só já era limitação de hoje (nada
  // agrupa por moeda, nem antes nem agora); o que muda é que o rótulo passa a
  // dizer a verdade no caso comum, que é o board de moeda única. `MOEDA_PADRAO`
  // só cobre a coluna sem nenhum lead com valor — onde o total nem aparece.
  const moedaDoTotal = leads.find((l) => l.value_cents != null)?.currency ?? MOEDA_PADRAO;

  // A linha "ponderado" (issue #1535): o que ESTA coluna representa quando a
  // etapa tem chance calibrada. Ganho e perda valem 100 e 0 NA REGRA
  // (`lib/leads/previsao.ts`), não na coluna. `null` = etapa sem calibração, e
  // aí a linha não aparece: exibir "R$ 0,00" seria um número que ninguém
  // calibrou lendo como uma promessa de zero.
  const probDaColuna = stage.is_won ? 100 : stage.is_lost ? 0 : stage.win_probability ?? null;
  const ponderadoCents =
    probDaColuna === null
      ? null
      : leads.reduce((sum, l) => sum + Math.round(((l.value_cents ?? 0) * probDaColuna) / 100), 0);

  const idsVisiveis = leads.map((l) => l.id);
  const selecionadosAqui = idsVisiveis.filter((id) => selectedLeadIds?.has(id)).length;
  const todosSelecionados = idsVisiveis.length > 0 && selecionadosAqui === idsVisiveis.length;

  // A âncora do shift+clique. `useRef` e não `useState` de propósito: mudar a
  // âncora não muda nada na tela, e um `setState` aqui remontaria a coluna
  // inteira — inclusive o `Droppable` — a cada card marcado.
  const ancora = useRef<string | null>(null);

  const aoSelecionar = (leadId: string, gesto: GestoDeSelecao) => {
    if (gesto === "intervalo") {
      const faixa = intervaloDaColuna(idsVisiveis, ancora.current, leadId);
      ancora.current = leadId;
      onSelectMany?.(faixa, true);
      return;
    }
    ancora.current = leadId;
    onSelectMany?.([leadId], !selectedLeadIds?.has(leadId));
  };

  const alternarEtapa = () => {
    ancora.current = null;
    onSelectMany?.(idsVisiveis, !todosSelecionados);
  };
  const accentStyle: CSSProperties | undefined = stage.color
    ? { backgroundColor: stage.color }
    : undefined;

  return (
    <div className="flex w-80 shrink-0 flex-col rounded-lg border border-border bg-surface-muted/40">
      <div className="group/etapa flex items-center gap-2 border-b border-border px-3 py-2.5">
        {/* "Selecionar a etapa inteira" é o gesto que faz a ação em lote valer a
            pena: sem ele, mover trinta cards deixa de ser trinta arrastes e vira
            trinta cliques com modificador. Fica no cabeçalho porque é ali que a
            etapa é um objeto — o mesmo lugar onde já se lê a contagem dela.
            Indeterminado quando a seleção é parcial: "alguns" e "nenhum" não
            podem ter a mesma aparência num controle que o próximo clique
            inverte. */}
        <input
          type="checkbox"
          checked={todosSelecionados}
          ref={(el) => {
            if (el) el.indeterminate = selecionadosAqui > 0 && !todosSelecionados;
          }}
          disabled={idsVisiveis.length === 0}
          onChange={alternarEtapa}
          aria-label={
            todosSelecionados
              ? `${t("Desmarcar todos em")} ${stage.name}`
              : `${t("Selecionar todos em")} ${stage.name}`
          }
          className={cn(
            "h-4 w-4 shrink-0 cursor-pointer accent-accent transition-opacity",
            "focus:opacity-100 disabled:cursor-default",
            selecionadosAqui > 0 ? "opacity-100" : "opacity-0 group-hover/etapa:opacity-100",
          )}
        />
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            !stage.color && "bg-text-muted/40",
          )}
          style={accentStyle}
          aria-hidden
        />
        <h2 className="flex-1 truncate text-sm font-semibold text-text">
          {stage.name}
        </h2>
        <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-muted">
          {selecionadosAqui > 0 ? `${selecionadosAqui}/${leads.length}` : leads.length}
        </span>
      </div>

      {totalCents > 0 && (
        <div className="border-b border-border px-3 py-1.5 text-[11px] tabular-nums text-text-muted">
          {formatCents(totalCents, moedaDoTotal)}
          {ponderadoCents !== null && (
            <span className="ml-2">
              · {t("ponderado")} {formatCents(ponderadoCents, moedaDoTotal)}
            </span>
          )}
        </div>
      )}

      <Droppable droppableId={stage.id} type="LEAD">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "flex flex-1 flex-col gap-2 p-2 transition-colors",
              snapshot.isDraggingOver && "bg-accent/5",
            )}
          >
            {leads.map((lead, idx) => (
              <KanbanCard
                key={lead.id}
                card={buildCardInput(lead, {
                  stageName: stage.name,
                  ownerNames,
                  coolingIds,
                  reactivations,
                  canonicalTags,
                })}
                lead={lead}
                index={idx}
                pipelineId={pipelineId}
                isSelected={selectedLeadIds?.has(lead.id)}
                isSelecting={(selectedLeadIds?.size ?? 0) > 0}
                pulseCount={pulses?.get(lead.id) ?? 0}
                onSelect={aoSelecionar}
                onOpen={onOpen}
              />
            ))}
            {provided.placeholder}
            {leads.length === 0 && !snapshot.isDraggingOver && (
              <div className="flex h-20 items-center justify-center text-[11px] text-text-muted">
                {t("vazio")}
              </div>
            )}
          </div>
        )}
      </Droppable>
    </div>
  );
}
