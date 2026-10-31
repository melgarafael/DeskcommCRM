"use client";
import { useCallback, useMemo, useState } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/hooks/i18n/useT";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { chaveDoQuadro, useBoard } from "@/hooks/kanban/useBoard";
import { useMoveCard, type MoveArgs, type RecusaDeCampos, type RetomadaPendente } from "@/hooks/kanban/useMoveCard";
import { useRenameStage } from "@/hooks/kanban/useRenameStage";
import { CamposObrigatoriosDialog } from "./CamposObrigatoriosDialog";
import { LoseLeadDialog } from "./LoseLeadDialog";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useAtRiskLeads } from "@/hooks/leads/useAtRiskLeads";
import { useReactivations } from "@/hooks/leads/useReactivations";
import { midpoint } from "@/lib/kanban/fractional-indexing";
import { posicaoNoFimDaEtapa, proximoNaEtapaInteira } from "@/lib/kanban/vizinho-na-etapa";
import { compararNaEtapa, posicaoNoTopoDaEtapa } from "@/lib/kanban/entrada-na-etapa";
import { decideMotivoDaPerda } from "@/lib/leads/motivo-da-perda";
import type { Lead } from "@/lib/types/leads";
import type { BoardData, Pipeline, Stage } from "@/lib/kanban/types";
import { StageColumn } from "./StageColumn";
import { LeadDossier } from "./LeadDossier";
import { RetomarComoNovoNegocioDialog } from "./RetomarComoNovoNegocioDialog";
import { atalhosDoFunil } from "@/lib/leads/atalhos-do-card";
import { camposPorEscopo, camposDoFunil } from "@/lib/leads/campos-do-funil";

interface KanbanBoardProps {
  pipelineId: string;
  /** Optional override: if provided, skips internal useBoard fetch. */
  stages?: Stage[];
  leads?: Lead[];
  pipeline?: Pipeline;
  selectedIds?: string[];
  /**
   * Ids que chegaram por evento remoto, quando o board recebe os dados de fora.
   *
   * Quem assina o realtime é quem chama `useBoard` com o pipeline — e nesta
   * página é o _client, não este componente (aqui `useBoard(null)` fica
   * desligado por causa do `useExternal`). Sem esta prop o pulso nasce no lugar
   * certo e morre na fronteira: o dado vem por prop e o sinal ficava para trás.
   */
  pulses?: Map<string, number>;
  onSelectionChange?: (ids: string[]) => void;
  /** Lead a abrir já na montagem (deep link `?lead=` — ver o dossiê abaixo). */
  leadInicial?: string | null;
  /**
   * `manager`+ pode renomear a etapa direto no cabeçalho da coluna — mesmo
   * corte de papel da rota (`PATCH .../stages/:stageId`, `requireRole("manager")`).
   * `viewer`/`agent` também abrem este board (ele não é rota manager-only),
   * então o cabeçalho fica só leitura para eles.
   */
  podeRenomearEtapa?: boolean;
  /** Densidade compacta dos cards (issue #3461, item 2), escolhida na página. */
  denso?: boolean;
  /**
   * Quadro de funil ARQUIVADO (#1298): abre para OLHAR, e nada aqui grava —
   * sem arrastar card, sem menu de ações, sem seleção em lote e sem dossiê.
   * É a razão de o funil arquivado ser abrível sem desarquivar.
   */
  somenteLeitura?: boolean;
}

function groupLeadsByStage(stages: Stage[], leads: Lead[]): Map<string, Lead[]> {
  const map = new Map<string, Lead[]>();
  for (const stage of stages) map.set(stage.id, []);
  for (const lead of leads) {
    const bucket = map.get(lead.stage_id);
    if (bucket) bucket.push(lead);
  }
  // A rota já devolve `position_in_stage, id` — este sort repete a MESMA régua
  // (com o desempate por `id`) para a tela não depender da ordem de chegada:
  // sem o desempate, dois cards empatados trocavam de lugar a cada render
  // (#3461).
  for (const list of map.values()) {
    list.sort(compararNaEtapa);
  }
  return map;
}

function BoardSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
      {[0, 1, 2].map((c) => (
        <div
          key={c}
          className="flex w-80 shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface-muted/40 p-3"
        >
          <Skeleton className="h-5 w-32" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full animate-pulse" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function KanbanBoard({
  pipelineId,
  stages: stagesProp,
  leads: leadsProp,
  pipeline: pipelineProp,
  selectedIds,
  pulses: pulsesProp,
  onSelectionChange,
  leadInicial,
  podeRenomearEtapa = false,
  denso = false,
  somenteLeitura = false,
}: KanbanBoardProps) {
  const t = useT();
  const useExternal = stagesProp !== undefined && leadsProp !== undefined;
  const queryResult = useBoard(useExternal ? null : pipelineId);
  // O funil INTEIRO, sem o filtro da página: com `leads` vindo de fora esse
  // `data.leads` é a lista já filtrada, e é do cache `chaveDoQuadro(pipelineId)`
  // — preenchido pela página sem filtro — que o `after` do arrasto é lido.
  const qc = useQueryClient();
  const renameStage = useRenameStage(pipelineId);
  // A RECUSA DE CAMPOS ABRE DIÁLOGO, não toast (issue #1536): o 422 traz em
  // `details.faltando` o que falta, o diálogo coleta, e o reenvio leva os
  // valores NA MESMA escrita que muda a etapa. O hook é o MESMO de antes —
  // esta opção só troca o destino do erro.
  const [recusaDeCampos, setRecusaDeCampos] = useState<RecusaDeCampos | null>(null);
  const [retomada, setRetomada] = useState<RetomadaPendente | null>(null);
  const [perdaPendente, setPerdaPendente] = useState<MoveArgs | null>(null);
  const moveCard = useMoveCard(pipelineId, {
    onCamposFaltando: setRecusaDeCampos,
    onRetomada: setRetomada,
  });
  const { data: members } = useAssignableMembers(true);
  const ownerNames = useMemo(
    () => new Map((members ?? []).map((m) => [m.user_id, m.full_name])),
    [members],
  );
  // Esfriando vem do MESMO radar que alimenta /app/radar — o board não
  // reclassifica nada (contrato §3.3). `em_voo` fica de fora: a IA já prometeu
  // voltar, então não há decisão pendente para o humano.
  const { data: atRisk } = useAtRiskLeads();
  // As propostas vivas vêm da MESMA forma que o risco: uma lista por org, que o
  // card consome sem saber de onde veio. Ver o cabeçalho da rota.
  const { data: propostasVivas } = useReactivations();
  const reactivations = useMemo(() => {
    const m = new Map<string, { proposalId: string; expiresAt: string }>();
    for (const p of propostasVivas ?? []) {
      m.set(p.lead_id, { proposalId: p.proposal_id, expiresAt: p.expires_at });
    }
    return m;
  }, [propostasVivas]);
  const coolingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of atRisk?.items ?? []) {
      if (item.pipeline_id !== pipelineId) continue;
      if (item.risk === "em_risco" || item.risk === "critico") ids.add(item.id);
    }
    return ids;
  }, [atRisk, pipelineId]);
  // A tag canônica do pipeline é a ÚNICA que fica no card (como ponto de 6px);
  // as outras saem para o hover. Já existe em settings — não inventa campo.
  const canonicalTags = useMemo(() => {
    const raw = (pipelineProp ?? queryResult.data?.pipeline)?.settings?.canonical_tags;
    return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
  }, [pipelineProp, queryResult.data?.pipeline]);

  // O dossiê é do BOARD e não da página: ele precisa do lead inteiro e do nome
  // do estágio, que só existem aqui depois do agrupamento.
  //
  // `leadInicial` é o deep link: até aqui o dossiê SÓ abria por clique, então
  // nenhuma outra tela do produto conseguia apontar para um lead específico —
  // o histórico de captação tinha o id e nenhum lugar para levá-lo. Uma vez
  // aberto, o estado local manda (fechar não reabre pela URL).
  const [dossieId, setDossieId] = useState<string | null>(leadInicial ?? null);
  const [internalSelected, setInternalSelected] = useState<Set<string>>(new Set());
  const selectedLeadIds = useMemo(
    () => (selectedIds ? new Set(selectedIds) : internalSelected),
    [selectedIds, internalSelected],
  );

  const data = useExternal
    ? {
        pipeline: pipelineProp ?? ({} as Pipeline),
        stages: stagesProp,
        leads: leadsProp,
      }
    : queryResult.data;
  const isLoading = useExternal ? false : queryResult.isLoading;
  const isError = useExternal ? false : queryResult.isError;
  const error = useExternal ? null : queryResult.error;

  // Funil arquivado (#1298): o deep link `?lead=` também não abre o dossiê —
  // ele tem ações de escrita, e o quadro em leitura não as oferece.
  const leadDoDossie =
    dossieId && !somenteLeitura
      ? (data?.leads.find((l) => l.id === dossieId) ?? null)
      : null;

  const grouped = useMemo(() => {
    if (!data) return null;
    return groupLeadsByStage(data.stages, data.leads);
  }, [data]);

  // Um conjunto por vez, e não um card por vez: o board recebe o resultado do
  // gesto já resolvido pela coluna (um card, um intervalo, a etapa inteira). A
  // versão anterior só sabia alternar UM id, e é por isso que "selecionar tudo"
  // não existia — cada card exigia uma volta pelo estado.
  const handleSelectMany = useCallback(
    (leadIds: string[], marcar: boolean) => {
      const apply = (prev: Set<string>): Set<string> => {
        const next = new Set(prev);
        for (const id of leadIds) {
          if (marcar) next.add(id);
          else next.delete(id);
        }
        return next;
      };
      if (onSelectionChange) {
        onSelectionChange(Array.from(apply(selectedLeadIds)));
      } else {
        setInternalSelected((prev) => apply(prev));
      }
    },
    [onSelectionChange, selectedLeadIds],
  );

  // Arrastar e "Mover para…" passam por aqui. A etapa de perda sem motivo abre a
  // janela do motivo ANTES do move, com a mesma regra que a rota aplica: sem
  // isso o move ia sem `lost_reason` e voltava como toast.
  const moverPara = useCallback(
    (args: MoveArgs) => {
      const etapa = data?.stages.find((s) => s.id === args.stageId);
      const lead = data?.leads.find((l) => l.id === args.leadId);
      // O motivo na linha só vale para o card que JÁ está perdido (reordenar na
      // coluna de perda). O reaberto volta a `open` com o `lost_reason` da perda
      // anterior — `fn_crm_lead_close_on_stage` não o limpa —, e reaproveitá-lo
      // gravaria a perda nova com a causa da antiga.
      const motivoAtual =
        lead && (lead.status === "lost" || lead.stage_id === args.stageId) ? lead.lost_reason : null;
      if (!decideMotivoDaPerda({ etapaDeDestino: etapa, motivoAtual }).ok) {
        setPerdaPendente(args);
        return;
      }
      moveCard.mutate(args);
    },
    [data, moveCard],
  );

  // O menu não tem ponto de soltura. Quem CHEGA a outra etapa entra no TOPO,
  // a mesma regra do `moveLeadHandler` sem posição (#3461); a mesma etapa é
  // reordenação e segue para o fim. As duas pontas leem a etapa INTEIRA (cache
  // do quadro, sem o filtro da página — #2545).
  const aoMoverPelaLista = useCallback(
    (lead: Lead, stageId: string) => {
      const funil = qc.getQueryData<BoardData>(chaveDoQuadro(pipelineId))?.leads ?? data?.leads ?? [];
      const etapa = funil.filter((l) => l.stage_id === stageId);
      moverPara({
        leadId: lead.id,
        stageId,
        positionInStage:
          stageId === lead.stage_id ? posicaoNoFimDaEtapa(etapa, lead.id) : posicaoNoTopoDaEtapa(etapa, lead.id),
        expectedUpdatedAt: lead.updated_at,
      });
    },
    [qc, pipelineId, data, moverPara],
  );

  const handleDragEnd = useCallback(
    (result: DropResult) => {
      // Funil arquivado é leitura: soltar um card não move nada (#1298).
      if (somenteLeitura) return;
      if (!data || !grouped) return;
      const { source, destination, draggableId } = result;
      if (!destination) return;
      if (
        source.droppableId === destination.droppableId &&
        source.index === destination.index
      ) {
        return;
      }

      const lead = data.leads.find((l) => l.id === draggableId);
      if (!lead) return;

      const destStageId = destination.droppableId;
      const destList = (grouped.get(destStageId) ?? []).filter(
        (l) => l.id !== draggableId,
      );

      const before = destination.index > 0 ? destList[destination.index - 1] : null;
      // `destList` sai do `grouped`, que a página já FILTROU. O de cima fica
      // sendo o vizinho visível — foi o que o operador escolheu ao soltar; o de
      // baixo, porém, tem de ser o próximo card da etapa INTEIRA depois dele.
      // Tirado da lista filtrada, `midpoint` devolvia `último + 1000` no fim da
      // coluna visível (a posição nascida do card escondido) e, entre dois
      // visíveis, a média caía em cima do escondido do meio — os dois cards
      // ficavam com a MESMA `position_in_stage` e o arrasto seguinte entre eles
      // era cancelado em silêncio (issue #2545). O funil sem filtro mora no
      // cache do quadro, que a página preenche inteiro.
      const etapaInteira =
        qc
          .getQueryData<BoardData>(chaveDoQuadro(pipelineId))
          ?.leads.filter((l) => l.stage_id === destStageId) ?? null;
      const after = proximoNaEtapaInteira(
        before ?? null,
        destList[destination.index] ?? null,
        etapaInteira,
        draggableId,
      );

      const newPosition = midpoint(
        before?.position_in_stage ?? null,
        after?.position_in_stage ?? null,
      );

      if (Number.isNaN(newPosition)) {
        // Collision — Wave 8 will handle global rebalance. For now, abort silently.
        return;
      }

      moverPara({
        leadId: lead.id,
        stageId: destStageId,
        positionInStage: newPosition,
        expectedUpdatedAt: lead.updated_at,
      });
    },
    [data, grouped, moverPara, qc, pipelineId, somenteLeitura],
  );

  if (isLoading) {
    return <BoardSkeleton />;
  }

  if (isError) {
    return (
      <Card className="m-4 p-6 text-sm text-text-muted">
        {t("Falha ao carregar o board.")}
        {error instanceof Error ? ` ${error.message}` : null}
      </Card>
    );
  }

  if (!data || !grouped) {
    return null;
  }

  if (data.stages.length === 0) {
    return (
      <Card className="m-4 p-6 text-sm text-text-muted">
        {t("Nenhum lead nesta pipeline ainda.")}
      </Card>
    );
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      {/* UM contêiner de rolagem só, nos dois eixos. Rolar cada coluna por
          conta própria seria o desenho "Trello", mas o @hello-pangea/dnd não
          suporta Droppable rolável dentro de outro contêiner rolável ("nested
          scroll containers are currently not supported") — o arraste perderia
          a rolagem automática. Com o quadro como único pai rolável, o arraste
          continua inteiro, e o cabeçalho de cada etapa fica preso em cima
          (`sticky` em StageColumn). `items-start` no quadro + a faixa de dentro
          com `min-h-full`/`items-stretch`: a coluna curta ocupa a altura toda
          — inclusive depois de rolar além da tela (#3030) — e a comprida
          cresce com os cards, com o fundo acompanhando.
          Sem padding no ALTO, e é de propósito: o `sticky` prende o cabeçalho
          na borda do conteúdo do contêiner, então um `pt-4` deixava uma faixa
          de 16px acima dele por onde os cards apareciam rolando (medido no e2e
          "o quadro cabe na tela"). O respiro até os filtros vem do `gap-4` da
          página. */}
      <div
        className="flex min-h-0 flex-1 items-start gap-3 overflow-auto px-4 pb-4"
        data-quadro-do-funil
      >
        {/* A FAIXA entre o rolo e as colunas (#3030). O contêiner de fora é o
            único que rola; esta faixa é quem dá altura às colunas. Com o
            `min-h-full` da coluna medido contra a ALTURA VISÍVEL do quadro, a
            coluna vazia parava onde a tela terminava — e a área de soltar card
            com ela. Aqui a faixa tem `min-h-full` (nunca menos que a tela) e
            `items-stretch` (a mais comprida manda): todas as colunas ficam com
            a altura da mais comprida, e `w-max` mantém a largura do quadro.
            Não é um contêiner rolável novo — o de fora continua sendo o único —
            então o `@hello-pangea/dnd` segue com a rolagem automática do
            arraste (Droppable dentro de outro rolável ele não suporta). */}
        <div
          className="flex min-h-full w-max items-stretch gap-3"
          data-faixa-das-etapas
        >
          {data.stages.map((stage) => (
            <StageColumn
              key={stage.id}
              stage={stage}
              leads={grouped.get(stage.id) ?? []}
              pipelineId={pipelineId}
              ownerNames={ownerNames}
              coolingIds={coolingIds}
              reactivations={reactivations}
              pulses={pulsesProp ?? queryResult.pulses}
              canonicalTags={canonicalTags}
              selectedLeadIds={selectedLeadIds}
              onSelectMany={handleSelectMany}
              onOpen={setDossieId}
              etapas={data.stages}
              onMoverPara={aoMoverPelaLista}
              podeRenomear={podeRenomearEtapa}
              onRenomear={(nome) => renameStage.mutate({ stageId: stage.id, name: nome })}
              denso={denso}
              somenteLeitura={somenteLeitura}
            />
          ))}
        </div>
      </div>
      {leadDoDossie && (
        <LeadDossier
          open
          onOpenChange={(v: boolean) => !v && setDossieId(null)}
          lead={leadDoDossie}
          pipelineId={pipelineId}
          fieldDefs={camposPorEscopo(camposDoFunil(data.pipeline.settings ?? null), "negocio")}
          stageName={
            data.stages.find((s) => s.id === leadDoDossie.stage_id)?.name ?? "—"
          }
          ownerNames={ownerNames}
          etapas={data.stages}
          onMudarEtapa={(stageId) => aoMoverPelaLista(leadDoDossie, stageId)}
          // Os atalhos do card (#3487) saem do `settings` do funil que este
          // quadro já carregou — nenhuma chamada nova.
          atalhos={atalhosDoFunil(data.pipeline.settings ?? null)}
        />
      )}

      <CamposObrigatoriosDialog
        open={recusaDeCampos !== null}
        onOpenChange={(aberto) => {
          if (!aberto) setRecusaDeCampos(null);
        }}
        recusa={recusaDeCampos}
        isPending={moveCard.isPending}
        onConfirmar={({ customFields, wonReason }) => {
          if (!recusaDeCampos) return;
          const { args } = recusaDeCampos;
          setRecusaDeCampos(null);
          moveCard.mutate({
            ...args,
            customFields,
            ...(wonReason !== undefined ? { wonReason } : {}),
          });
        }}
      />
      {/* Uma instância para o quadro todo: a `key` a remonta a cada pendência,
          senão o motivo escolhido e cancelado num negócio voltava marcado no próximo. */}
      <LoseLeadDialog
        key={perdaPendente?.leadId ?? "fechado"}
        open={perdaPendente !== null}
        onOpenChange={(aberto) => {
          if (!aberto) setPerdaPendente(null);
        }}
        pipelineId={pipelineId}
        submitting={moveCard.isPending}
        onConfirm={(lostReason) => {
          if (!perdaPendente) return;
          setPerdaPendente(null);
          moveCard.mutate({ ...perdaPendente, lostReason });
        }}
      />
      {retomada && (
        <RetomarComoNovoNegocioDialog
          open
          onOpenChange={(v: boolean) => !v && setRetomada(null)}
          leadId={retomada.leadId}
          stageId={retomada.stageId}
          pipelineId={pipelineId}
        />
      )}
    </DragDropContext>
  );
}
