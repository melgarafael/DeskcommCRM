"use client";

/**
 * A PÁGINA DO NEGÓCIO, DO LADO DO CLIENTE (#4151).
 *
 * ─── O que esta camada faz, e o que ela NÃO faz ─────────────────────────────
 *
 * Ela NÃO desenha o negócio: quem desenha é `LeadDossier` com
 * `variante="pagina"` — os mesmos blocos da gaveta (campos, tarefas, propostas,
 * linha do tempo, conversa, atalhos). Aqui mora só o que o SERVIDOR não pode
 * fazer: reagir a um clique.
 *
 * O que ela faz é o mínimo para o cabeçalho ser vivo como no quadro:
 *
 *  1. listar quem pode ser dono (`ownerNames`) — mesma fonte do quadro;
 *  2. derivar os campos do funil (`camposPorEscopo(camposDoFunil(...))`) — mesma
 *     régua da gaveta, para os campos aparecerem iguais;
 *  3. MOVER a etapa pelo MESMO caminho do quadro (`useMoveCard`), com as mesmas
 *     recusas virando os mesmos diálogos (campos obrigatórios, motivo da perda,
 *     retomada como novo negócio).
 *
 * ─── Por que reler o negócio antes de mover ─────────────────────────────────
 *
 * `.../move` é OCC: manda-se o `updated_at` lido e o servidor recusa com 409 se
 * ele mudou. A página não tem o cache do quadro, então a régua dela é a da
 * leitura do servidor — que envelhece no instante em que alguém edita um campo
 * (inclusive a própria pessoa, no formulário logo abaixo). Ler a linha de novo
 * antes de escrever é o que evita "modificado por outro usuário" para quem
 * acabou de editar. Uma linha, uma vez, por mudança de etapa.
 */

import { useCallback, useMemo, useState } from "react";

import { LeadDossier } from "@/components/kanban/LeadDossier";
import { CamposObrigatoriosDialog } from "@/components/kanban/CamposObrigatoriosDialog";
import { LoseLeadDialog } from "@/components/kanban/LoseLeadDialog";
import { RetomarComoNovoNegocioDialog } from "@/components/kanban/RetomarComoNovoNegocioDialog";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import {
  useMoveCard,
  type MoveArgs,
  type RecusaDeCampos,
  type RetomadaPendente,
} from "@/hooks/kanban/useMoveCard";
import { apiClient } from "@/lib/api/client";
import { atalhosDoFunil } from "@/lib/leads/atalhos-do-card";
import { camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";
import { decideMotivoDaPerda } from "@/lib/leads/motivo-da-perda";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

/**
 * A leitura fresca de UMA linha — a régua do `updated_at`.
 *
 * Envelope tolerante como no `fetchBoard` (`{ data }` ou o corpo cru): o
 * `apiClient` já desembrulha em alguns helpers e não em outros, e um `undefined`
 * aqui viraria 409 sem motivo.
 */
async function lerONegocio(leadId: string): Promise<Lead | null> {
  try {
    const res = await apiClient.get<{ data?: Lead } | Lead>(`/api/v1/leads/${leadId}`);
    if (res && typeof res === "object" && "data" in res) {
      return (res as { data?: Lead }).data ?? null;
    }
    return res as Lead;
  } catch {
    // Sem leitura fresca, a régua é a que a tela tem: o 409 do servidor é uma
    // resposta clara ("recarregue"), e inventar `updated_at` seria pior.
    return null;
  }
}

export function PaginaDoNegocio({
  lead,
  pipeline,
  etapas,
  voltarHref,
}: {
  lead: Lead;
  pipeline: Pipeline;
  etapas: Stage[];
  voltarHref: string;
}) {
  // O estado do negócio começa na leitura do servidor e anda com as escritas
  // desta tela (mover etapa). O formulário de campos grava por conta própria —
  // a régua dele é lida de novo antes do próximo move (ver acima).
  const [negocio, setNegocio] = useState<Lead>(lead);

  const { data: members } = useAssignableMembers(true);
  const ownerNames = useMemo(
    () => new Map((members ?? []).map((m) => [m.user_id, m.full_name])),
    [members],
  );
  /**
   * Os campos do funil, pela MESMA partição da gaveta: o dossiê recebe
   * `fieldDefs` pronto e nunca decide sozinho quais campos são do negócio.
   */
  const fieldDefs = useMemo(
    () => camposPorEscopo(camposDoFunil(pipeline.settings ?? null), "negocio"),
    [pipeline.settings],
  );
  const atalhos = useMemo(() => atalhosDoFunil(pipeline.settings ?? null), [pipeline.settings]);

  const [recusa, setRecusa] = useState<RecusaDeCampos | null>(null);
  const [retomada, setRetomada] = useState<RetomadaPendente | null>(null);
  const [perda, setPerda] = useState<MoveArgs | null>(null);

  /**
   * O MESMO hook do quadro: recusa por campos obrigatórios abre o diálogo que
   * coleta e reenvia NA MESMA escrita; `reabertura_cria_novo` abre a retomada.
   * Sem esta fiação, "mudar a etapa" na página teria um caminho mais pobre que
   * o do card — e a página existe para trabalhar o negócio, não para vê-lo.
   */
  const moveCard = useMoveCard(pipeline.id, {
    onCamposFaltando: setRecusa,
    onRetomada: setRetomada,
  });

  const mudarEtapa = useCallback(
    async (stageId: string) => {
      if (stageId === negocio.stage_id) return;
      const etapa = etapas.find((e) => e.id === stageId);
      if (!etapa) return;

      const fresquinho = await lerONegocio(negocio.id);
      const regua = fresquinho?.updated_at ?? negocio.updated_at;
      const motivoAtual =
        fresquinho && (fresquinho.status === "lost" || fresquinho.stage_id === stageId)
          ? fresquinho.lost_reason
          : null;

      // A etapa de PERDA pede o motivo ANTES de escrever, pela mesma decisão do
      // quadro (`decideMotivoDaPerda`) — e a janela é o MESMO diálogo.
      if (!decideMotivoDaPerda({ etapaDeDestino: etapa, motivoAtual }).ok) {
        setPerda({ leadId: negocio.id, stageId, expectedUpdatedAt: regua });
        return;
      }

      // Sem `positionInStage`: a página não tem a coluna. O servidor posiciona
      // pela régua de entrada (#3461) — ver `moveLeadSchema`.
      moveCard.mutate(
        { leadId: negocio.id, stageId, expectedUpdatedAt: regua },
        {
          onSuccess: (res) => {
            setNegocio((atual) => ({ ...atual, ...res.data }));
          },
        },
      );
    },
    [etapas, moveCard, negocio.id, negocio.stage_id, negocio.updated_at],
  );

  return (
    <>
      <LeadDossier
        variante="pagina"
        voltarHref={voltarHref}
        lead={negocio}
        pipelineId={pipeline.id}
        fieldDefs={fieldDefs}
        stageName={etapas.find((e) => e.id === negocio.stage_id)?.name ?? "—"}
        ownerNames={ownerNames}
        etapas={etapas}
        onMudarEtapa={mudarEtapa}
        atalhos={atalhos}
      />

      <CamposObrigatoriosDialog
        open={recusa !== null}
        onOpenChange={(aberto) => {
          if (!aberto) setRecusa(null);
        }}
        recusa={recusa}
        isPending={moveCard.isPending}
        onConfirmar={({ customFields, wonReason }) => {
          if (!recusa) return;
          const { args } = recusa;
          setRecusa(null);
          moveCard.mutate(
            {
              ...args,
              customFields,
              ...(wonReason !== undefined ? { wonReason } : {}),
            },
            {
              onSuccess: (res) => setNegocio((atual) => ({ ...atual, ...res.data })),
            },
          );
        }}
      />

      {/* Uma instância por pendência, como no quadro: o motivo escolhido e
          cancelado num negócio não volta marcado no seguinte. */}
      <LoseLeadDialog
        key={perda?.stageId ?? "fechado"}
        open={perda !== null}
        onOpenChange={(aberto) => {
          if (!aberto) setPerda(null);
        }}
        pipelineId={pipeline.id}
        submitting={moveCard.isPending}
        onConfirm={(lostReason) => {
          if (!perda) return;
          const args = perda;
          setPerda(null);
          // `onConfirm` (e não `leadId`): a escrita é UMA só — o move com o
          // motivo dentro, como no quadro. Pela rota `lose` seriam dois
          // pedidos, e o segundo com a etapa já mudada.
          moveCard.mutate(
            { ...args, lostReason },
            {
              onSuccess: (res) => setNegocio((atual) => ({ ...atual, ...res.data })),
            },
          );
        }}
      />

      {retomada && (
        <RetomarComoNovoNegocioDialog
          open
          onOpenChange={(v: boolean) => !v && setRetomada(null)}
          leadId={retomada.leadId}
          stageId={retomada.stageId}
          pipelineId={pipeline.id}
        />
      )}
    </>
  );
}
