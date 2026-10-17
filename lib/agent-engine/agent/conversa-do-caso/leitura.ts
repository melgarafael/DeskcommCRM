/**
 * AS CONSULTAS DA CONVERSA DO CASO — o que a IA lê antes de responder à equipe.
 *
 * Separado de `contexto.ts` (puro) e do emissor: aqui mora tudo que toca banco.
 *
 * ## Duas funções do motor que NÃO podem ser reusadas aqui, e por quê
 *
 * · **`getLeadContext`** recorta pelo atendimento CORRENTE (inbound com
 *   `service_revision = c.service_revision` e `demanda_id is not distinct from
 *   c.current_demanda_id`, outbound com `sent_at >= c.service_started_at`). Um
 *   caso aberto num atendimento que depois foi encerrado e reaberto leria A
 *   CONVERSA ERRADA — e isso é caminho PREVISTO, não canto raro: o produto já
 *   modela "caso obsoleto" e tem tela para ele. A leitura daqui recorta pela
 *   FRONTEIRA DO CASO, congelada na abertura.
 *
 * · **`latestCheckpoint`** devolve, fora de `withServiceBoundary`, o checkpoint
 *   mais recente DO CONTATO em QUALQUER conversa (`currentExecutionBoundary()`
 *   é nulo nesse caminho). A consulta daqui passa `conversation_id` explícito,
 *   que é a pergunta honesta.
 */
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

import { caseEventLabel } from "@/lib/ai/case-copy";
import { lerContinuidadeHumana } from "@/lib/escalacao/continuidade";

import { corpoDaMensagem, type CorpoDaMensagemRow } from "../../edge/crm/get-lead-context";
import type { FalaDaConversa, EventoDoCaso, MemoriaDoAtendimento } from "./contexto";

/** O caso, com o contato resolvido pela conversa (ids NUNCA vêm do body). */
export interface CasoParaConversa {
  id: string;
  title: string;
  kind: string | null;
  summary: string;
  blocker: string;
  status: string;
  opened_at: string;
  agent_id: string | null;
  conversation_id: string;
  contact_id: string | null;
  context_snapshot: Record<string, unknown> | null;
}

export async function lerCaso(
  db: pg.Pool,
  organizationId: string,
  caseId: string,
): Promise<CasoParaConversa | null> {
  const { rows } = await db.query<CasoParaConversa>(
    `select ac.id, ac.title, ac.kind, ac.summary, ac.blocker, ac.status,
            ac.opened_at, ac.agent_id, ac.conversation_id, ac.context_snapshot,
            conv.contact_id
       from agent_cases ac
       join conversations conv
         on conv.id = ac.conversation_id and conv.organization_id = ac.organization_id
      where ac.organization_id = $1 and ac.id = $2`,
    [organizationId, caseId],
  );
  return rows[0] ?? null;
}

export async function lerEventosDoCaso(
  db: pg.Pool,
  organizationId: string,
  caseId: string,
  limite = 30,
): Promise<EventoDoCaso[]> {
  const { rows } = await db.query<{
    kind: string;
    actor_kind: string;
    human_action: string | null;
    body: string | null;
    source: string | null;
    created_at: Date;
  }>(
    `select kind, actor_kind, human_action, body, metadata->>'source' as source, created_at
       from agent_case_events
      where organization_id = $1 and case_id = $2
      order by created_at asc
      limit $3`,
    [organizationId, caseId, limite],
  );
  return rows.map((r) => ({
    // Rótulo humano, nunca o enum cru: quem lê a resposta é uma pessoa, e o
    // modelo que lê `human_replied` inventa o que aquilo significa.
    rotulo: caseEventLabel({
      kind: r.kind,
      actor_kind: r.actor_kind,
      human_action: r.human_action,
      source: r.source,
    } as Parameters<typeof caseEventLabel>[0]),
    quando: new Date(r.created_at).toISOString(),
    corpo: r.body,
  }));
}

/**
 * As mensagens pela FRONTEIRA DO CASO — a janela congelada na abertura, mais o
 * que veio depois, marcado como tal.
 *
 * `$3` é a `service_revision` da fronteira (pode ser nula num caso antigo, e aí
 * o `is not distinct from` faz o braço casar as mensagens sem revisão em vez de
 * casar nada).
 */
export async function lerConversaDoCaso(
  db: pg.Pool,
  organizationId: string,
  input: {
    conversationId: string;
    serviceRevision: number | null;
    abertoEm: string;
    limite: number;
  },
): Promise<{ origem: FalaDaConversa[]; depois: FalaDaConversa[] }> {
  const { rows } = await db.query<
    CorpoDaMensagemRow & { direction: string; sent_at: Date | null; depois_da_abertura: boolean }
  >(
    `select direction, type, body, media_url, media_storage_path, media_derived_text,
            sent_at, (sent_at > $5) as depois_da_abertura
       from messages
      where organization_id = $1
        and conversation_id = $2
        and direction in ('inbound','outbound')
        and (service_revision is not distinct from $3 or sent_at > $5)
      order by sent_at desc, id desc
      limit $4`,
    [organizationId, input.conversationId, input.serviceRevision, input.limite, input.abertoEm],
  );
  const falas = rows.reverse().map((r) => ({
    de: (r.direction === "inbound" ? "cliente" : "nos") as FalaDaConversa["de"],
    quando: r.sent_at ? new Date(r.sent_at).toISOString() : input.abertoEm,
    // `corpoDaMensagem` já embute transcrição e descrição de mídia. Reescrever a
    // regra aqui daria dois donos para "o que o modelo lê de um áudio".
    texto: corpoDaMensagem(r),
    depois: r.depois_da_abertura,
  }));
  return {
    origem: falas.filter((f) => !f.depois).map(({ depois: _d, ...f }) => f),
    depois: falas.filter((f) => f.depois).map(({ depois: _d, ...f }) => f),
  };
}

/**
 * O checkpoint DESTA conversa — `conversation_id` explícito.
 *
 * `latestCheckpoint` devolveria o do contato em qualquer conversa fora de
 * `withServiceBoundary`. Aqui a pergunta é sobre este atendimento.
 */
export async function lerMemoriaDoAtendimento(
  db: pg.Pool,
  organizationId: string,
  contactId: string,
  conversationId: string,
): Promise<MemoriaDoAtendimento | null> {
  const { rows } = await db.query<{
    commitments: unknown;
    objections: unknown;
    next_action: string | null;
    rolling_summary: string | null;
  }>(
    `select commitments, objections, next_action, rolling_summary
       from lead_checkpoints
      where organization_id = $1 and contact_id = $2 and conversation_id = $3
      order by seq desc
      limit 1`,
    [organizationId, contactId, conversationId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  const lista = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];
  return {
    compromissos: lista(r.commitments),
    objecoes: lista(r.objections),
    proximaAcao: r.next_action,
    resumo: r.rolling_summary,
  };
}

/** O que a EQUIPE já decidiu, em prosa — a mesma leitura que o turno usa. */
export async function lerDecisoesDaEquipe(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<string> {
  const continuidade = await lerContinuidadeHumana(admin, organizationId, conversationId);
  return continuidade.resumo;
}

/** As 5 falas congeladas no `context_snapshot` quando o caso foi aberto. */
export function falasDoSnapshot(
  snapshot: Record<string, unknown> | null,
  abertoEm: string,
): FalaDaConversa[] {
  const bruto = snapshot?.last_messages;
  if (!Array.isArray(bruto)) return [];
  return bruto.flatMap((m): FalaDaConversa[] => {
    if (typeof m !== "object" || m === null) return [];
    const r = m as Record<string, unknown>;
    const texto = typeof r.body === "string" ? r.body : null;
    if (texto === null || texto.trim() === "") return [];
    return [
      {
        de: r.direction === "inbound" ? "cliente" : "nos",
        quando: typeof r.sent_at === "string" ? r.sent_at : abertoEm,
        texto,
      },
    ];
  });
}
