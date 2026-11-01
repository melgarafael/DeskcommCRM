"use client";

import { useCallback, useEffect, useRef } from "react";

import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import {
  avisosDoBanco,
  avisosDoNegocio,
  carimboDaTransacao,
  estadoDoAntigo,
  estadoDoNovo,
  type AvisoDeNegocio,
  type EstadoVisto,
} from "./aviso-de-negocio";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { entregarAviso } from "@/lib/notifications/deliver";
import { mencaoAtingeUsuario, textoLegivelDeMencao } from "@/lib/notifications/mentions";
import { buscaEventosDoNegocio } from "./eventos-do-negocio";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function sides(payload: unknown): {
  novo: Record<string, unknown> | null;
  antigo: Record<string, unknown> | null;
} {
  if (!payload || typeof payload !== "object") return { novo: null, antigo: null };
  const p = payload as { new?: unknown; old?: unknown; payload?: { new?: unknown; old?: unknown } };
  const novoRaw = p.new ?? p.payload?.new;
  const antigoRaw = p.old ?? p.payload?.old;
  return {
    novo: novoRaw && typeof novoRaw === "object" && !Array.isArray(novoRaw) ? (novoRaw as Record<string, unknown>) : null,
    antigo:
      antigoRaw && typeof antigoRaw === "object" && !Array.isArray(antigoRaw)
        ? (antigoRaw as Record<string, unknown>)
        : null,
  };
}

/** Título do sino por aviso — o `kind` é o mesmo nome, e é o que a entrega usa. */
const TITULO_DO_AVISO: Record<AvisoDeNegocio, string> = {
  lead_assigned: "Lead atribuído a você",
  lead_won: "Lead ganho",
  lead_lost: "Lead perdido",
};

export function useCrmAlerts(): void {
  const orgId = useActiveOrg()?.orgId ?? null;
  const user = useUser();
  /**
   * ⚠️ O HISTÓRICO VEM DAQUI, NÃO DO `old` DO REALTIME (issue #3040).
   *
   * Sem `REPLICA IDENTITY FULL` o UPDATE chega com `old = { id }` e só isso:
   * comparar com ele dizia que TODO evento mudou o responsável, e cada resposta
   * do vendedor (o `#2958` carimba `last_activity_at`) virava um "Lead atribuído
   * a você". O último estado visto por negócio mora no cliente — a decisão
   * inteira está em `./aviso-de-negocio.ts`, com o porquê.
   *
   * A memória só se alimenta do próprio canal, então o PRIMEIRO evento que a
   * aba vê de um negócio chega sem histórico — e aí quem responde é o BANCO
   * (`avisosDoBanco`, issue #3224), consultado uma vez por negócio.
   */
  const memorias = useRef(new Map<string, { estado: EstadoVisto; vigenciaDoDono: symbol }>());
  const contexto = useRef({ orgId, userId: user.id, ativo: false });
  useEffect(() => {
    // A identidade do objeto é a geração, como o canal vigente do Realtime.
    // Voltar à mesma organização não revalida uma consulta da visita anterior.
    const geracao = { orgId, userId: user.id, ativo: orgId !== null };
    contexto.current = geracao;
    memorias.current.clear();
    return () => { geracao.ativo = false; };
  }, [orgId, user.id]);

  /**
   * Entrega os avisos de um evento — o único ponto que chama `entregarAviso`
   * aqui, vindo da memória ou do banco.
   *
   * Um aviso por (tipo, negócio): a memória só avisa em transição de estado, e
   * o banco só avisa o evento da MESMA transação do UPDATE — o mesmo evento
   * nunca percorre os dois caminhos (quem tem histórico não consulta, quem não
   * tem não tem transição na memória), então não há aviso dobrado (#3224).
   */
  const entregar = useCallback(
    (leadId: string, avisos: AvisoDeNegocio[], titulo: string, pipelineId: string | null) => {
      const href = pipelineId ? `/app/pipelines/${pipelineId}` : "/app/kanban";
      for (const aviso of avisos) {
        entregarAviso({
          category: aviso,
          kind: aviso,
          title: TITULO_DO_AVISO[aviso],
          body: titulo,
          corpoSemPrevia: titulo,
          tag: leadId,
          href,
        });
      }
    },
    [],
  );

  const onLead = useCallback(
    (payload: unknown) => {
      const geracao = contexto.current;
      if (!geracao.ativo || geracao.orgId !== orgId || geracao.userId !== user.id) return;
      const { novo, antigo } = sides(payload);
      if (!novo) return;
      const leadId = str(novo.id);
      if (!leadId) return;

      // O que já sabíamos deste negócio: a memória do próprio cliente; na falta
      // dela, o `old` — e só quando ele de fato carrega os campos (instalação
      // com REPLICA IDENTITY FULL). Sem nenhum dos dois o histórico é
      // desconhecido, e aí a decisão sai do banco (logo abaixo, #3224).
      const memoria = memorias.current.get(leadId);
      const anterior = memoria?.estado ?? estadoDoAntigo(antigo);
      const estado = estadoDoNovo(novo);
      // Retirar o dono invalida a consulta mesmo se ele reassumir mais tarde.
      // Status e atividade não trocam esta vigência nem reordenam avisos.
      const vigenciaDoDono = memoria && memoria.estado.owner_user_id === estado.owner_user_id
        ? memoria.vigenciaDoDono : Symbol();
      memorias.current.set(leadId, { estado, vigenciaDoDono });

      const titulo = str(novo.title) || "Lead";
      const pipelineId = str(novo.pipeline_id);
      const carimbo = carimboDaTransacao(novo.updated_at);

      const avisos = avisosDoNegocio(anterior, estado, user.id);
      if (avisos.length > 0) {
        entregar(leadId, avisos, titulo, pipelineId);
        return;
      }

      // ── #3224: sem histórico conhecido, a sessão não tem como dizer que
      // mudou. Pergunta ao banco UMA vez por negócio: o gatilho gravou
      // lead.assigned / lead.won / lead.lost comparando OLD e NEW na própria
      // transação, e `avisosDoBanco` casa o evento com o `updated_at` deste
      // UPDATE. Sem transação legível, sem consulta; dono que não sou eu, sem
      // consulta; resposta do vendedor sem evento na transação, silêncio — a
      // #3040 não volta.
      if (anterior !== null || !carimbo || !orgId) return;
      if (estado.owner_user_id !== user.id) return;
      void buscaEventosDoNegocio(leadId).then((eventos) => {
        if (!geracao.ativo || contexto.current !== geracao) return;
        // A consulta atesta a transação capturada; quem recebe ainda precisa
        // ser o responsável do último UPDATE observado, não só daquele snapshot.
        const atual = memorias.current.get(leadId);
        if (!atual || atual.vigenciaDoDono !== vigenciaDoDono || atual.estado.owner_user_id !== user.id) return;
        const doBanco = avisosDoBanco({
          organizationId: orgId,
          leadId,
          carimboDoUpdate: carimbo,
          eventos,
          novo: estado,
          userId: user.id,
        });
        if (doBanco.length > 0) entregar(leadId, doBanco, titulo, pipelineId);
      });
    },
    [user.id, orgId, entregar],
  );

  const onNote = useCallback(
    (payload: unknown) => {
      const { novo } = sides(payload);
      if (!novo) return;
      const author = str(novo.created_by_user_id);
      if (author === user.id) return;
      const body = str(novo.body) ?? "";
      if (
        !mencaoAtingeUsuario(body, {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
        })
      ) {
        return;
      }
      const conversationId = str(novo.conversation_id);
      entregarAviso({
        category: "mention",
        kind: "mention",
        title: "Você foi mencionado",
        // O sino é LIDO por gente: o token com o id vira `@Ana Lima` aqui,
        // nunca o contrário (o casamento já aconteceu logo acima, no cru).
        body: textoLegivelDeMencao(body),
        tag: conversationId ?? undefined,
        href: conversationId ? `/app/inbox?id=${conversationId}` : "/app/inbox",
      });
    },
    [user.id, user.email, user.full_name],
  );

  useRealtimeChannel({
    name: orgId ? `alerts-leads-${orgId}` : "alerts-leads-disabled",
    postgresChanges: orgId
      ? {
          event: "UPDATE",
          schema: "public",
          table: "crm_leads",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange: onLead,
    enabled: !!orgId,
  });

  useRealtimeChannel({
    name: orgId ? `alerts-notes-${orgId}` : "alerts-notes-disabled",
    postgresChanges: orgId
      ? {
          event: "INSERT",
          schema: "public",
          table: "conversation_notes",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange: onNote,
    enabled: !!orgId,
  });
}
