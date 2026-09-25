/**
 * GET/POST /api/v1/cron/handoff-devolucao — devolve ao agente de IA a conversa
 * que ficou com uma pessoa e passou do prazo sem nenhum sinal dela.
 *
 * ## O que faz, e o que NÃO faz
 *
 * Para cada organização que ligou o prazo em Configurações › Distribuição de
 * atendimento (`settings.routing.handoff_return_after_minutes`), varre as
 * conversas que estão com humano de forma durável — handoff formal
 * (`bot_silenced_until = 'infinity'`), `assignee_kind = 'user'` ou
 * `assigned_to_user_id` preenchido — e devolve as que passaram do prazo
 * contado do ÚLTIMO sinal humano. A regra pura (quem vence, o que fica de
 * fora, e por quê) mora em `lib/escalacao/devolucao-automatica.ts`.
 *
 * NÃO tem regra própria de devolução: cada conversa vencida passa por
 * `devolverAtendimentoAoAgente`, a MESMA função do botão da tela e da tool do
 * agente — solta as três travas, grava checkpoint, emite `ai.handoff_resolved`
 * (que retoma o follow-up pausado) e a atividade na linha do tempo. Uma
 * segunda regra aqui seria o defeito que `retomada.ts` existe para consertar.
 *
 * Organização sem o prazo ligado: nada acontece — é a IA-06 de sempre.
 *
 * ## Por que 5 em 5 minutos
 *
 * O prazo mínimo é 5 min e o piso do crond é 1; rodar a cada minuto seria 60
 * varreduras/h em toda instalação para um prazo que a maioria vai deixar em
 * 30–60 min. Cinco minutos de atraso sobre o prazo escolhido não muda nada
 * para quem está esperando há uma hora.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed). Audita SÓ quando devolveu algo — varredura
 * vazia não é mutação (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  lerPrazoDeDevolucaoMinutos,
  selecionarVencidas,
  type ConversaEmHandoff,
} from "@/lib/escalacao/devolucao-automatica";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** Teto de conversas lidas por rodada; o que sobrar entra na próxima. */
const SCAN_LIMIT = 500;

/** Quem age é o produto, não uma pessoa — `emitLeadActivity` grava como sistema. */
const ATOR_DO_CRON = { type: "webhook_source", id: "cron:handoff-devolucao" } as const;

export interface DevolucaoResultado {
  organizacoes: number;
  examinadas: number;
  devolvidas: number;
  falhas: number;
}

/**
 * As organizações com prazo ligado. O filtro é feito em memória de propósito:
 * a leitura de `settings` é defensiva (jsonb livre) e `lerPrazoDeDevolucaoMinutos`
 * já rejeita valor fora da faixa — um `->>` no PostgREST repetiria a regra.
 */
async function prazosPorOrganizacao(admin: SupabaseClient): Promise<Map<string, number>> {
  const { data, error } = await admin
    .from("organizations")
    .select("id, settings")
    .not("settings->routing->handoff_return_after_minutes", "is", null);
  if (error) throw new Error(`organizations: ${error.message}`);
  const prazos = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ id: string; settings: unknown }>) {
    const minutos = lerPrazoDeDevolucaoMinutos(row.settings);
    if (minutos !== null) prazos.set(row.id, minutos);
  }
  return prazos;
}

/**
 * Sessões em que existe quem atenda: agente com versão publicada apontando
 * para a sessão, ou roteador ativo nela. Espelha o portão do drain
 * (`lib/agent-engine/edge/crm/drain.ts`) — devolver onde ninguém atende tira
 * a conversa da fila humana e a deixa muda.
 */
async function sessoesComAgente(
  admin: SupabaseClient,
  orgIds: string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const add = (org: string, sessao: string | null) => {
    if (!sessao) return;
    const s = out.get(org) ?? new Set<string>();
    s.add(sessao);
    out.set(org, s);
  };

  const { data: agentes, error: erroAgentes } = await admin
    .from("ai_agents")
    .select("organization_id, published_version_id, ai_agent_versions!ai_agents_published_version_id_fkey(channel_session_id, status)")
    .in("organization_id", orgIds)
    .is("archived_at", null)
    .not("published_version_id", "is", null);
  if (erroAgentes) throw new Error(`ai_agents: ${erroAgentes.message}`);
  type Versao = { channel_session_id: string | null; status: string };
  // O embed por FK many-to-one volta como OBJETO em runtime, mas os tipos
  // gerados o declaram como lista — o dispatcher normaliza do mesmo jeito.
  for (const a of (agentes ?? []) as unknown as Array<{
    organization_id: string;
    ai_agent_versions: Versao | Versao[] | null;
  }>) {
    const v = Array.isArray(a.ai_agent_versions) ? (a.ai_agent_versions[0] ?? null) : a.ai_agent_versions;
    if (v && v.status === "published") add(a.organization_id, v.channel_session_id);
  }

  const { data: roteadores, error: erroRoteadores } = await admin
    .from("ai_routers")
    .select("organization_id, channel_session_id")
    .in("organization_id", orgIds)
    .eq("is_active", true);
  if (erroRoteadores) throw new Error(`ai_routers: ${erroRoteadores.message}`);
  for (const r of (roteadores ?? []) as Array<{ organization_id: string; channel_session_id: string | null }>) {
    add(r.organization_id, r.channel_session_id);
  }
  return out;
}

export async function devolverHandoffsVencidos(
  admin: SupabaseClient,
  requestId: string,
  agora: Date = new Date(),
): Promise<DevolucaoResultado> {
  const prazoPorOrg = await prazosPorOrganizacao(admin);
  if (prazoPorOrg.size === 0) return { organizacoes: 0, examinadas: 0, devolvidas: 0, falhas: 0 };
  const orgIds = [...prazoPorOrg.keys()];

  const { data, error } = await admin
    .from("conversations")
    .select(
      "id, organization_id, channel_session_id, status, assignee_kind, assigned_to_user_id, assigned_at, bot_silenced_until, last_handoff_at, last_outbound_at, status_changed_at",
    )
    .in("organization_id", orgIds)
    .in("status", ["open", "pending", "claimed", "ai_handling"])
    .or("bot_silenced_until.eq.infinity,assignee_kind.eq.user,assigned_to_user_id.not.is.null")
    .limit(SCAN_LIMIT);
  if (error) throw new Error(`conversations: ${error.message}`);
  const conversas = (data ?? []) as ConversaEmHandoff[];

  const vencidas = selecionarVencidas(conversas, {
    prazoPorOrg,
    sessoesComAgente: await sessoesComAgente(admin, orgIds),
    agoraMs: agora.getTime(),
  });

  let devolvidas = 0;
  let falhas = 0;
  for (const { conversa, minutos } of vencidas) {
    const r = await devolverAtendimentoAoAgente(
      { supabase: admin, organizationId: conversa.organization_id, actor: ATOR_DO_CRON, requestId },
      { conversationId: conversa.id, origem: { automatica: { minutos } } },
    );
    if (r.ok) {
      devolvidas++;
      continue;
    }
    // `assignment_conflict` sai de QUATRO pontos de `devolverAtendimentoAoAgente`
    // e só UM deles é corrida: o UPDATE que casou 0 linhas porque alguém assumiu
    // entre a leitura e a escrita — a pessoa ganhou, e é o desfecho certo. Os
    // outros três (release que falhou, erro no UPDATE, erro ao limpar
    // `force_human`) carregam a mensagem do banco em `detalhe`; a corrida volta
    // SEM ela. O discriminador é esse, e é o próprio `retomada.ts` que o produz.
    //
    // Engolir os quatro escondia justamente o pior: o erro ao limpar
    // `force_human` acontece DEPOIS de a conversa já ter virado
    // `assignee_kind='ai'` — ela sai da fila humana, a IA vira dona, e a trava
    // que cala os três guards (worker nativo, harness, before-send) continua de
    // pé. Ninguém atende dos dois lados, e a rodada reportava `falhas: 0` sem
    // auditar nada: um defeito real com cara de disputa benigna.
    if (r.erro === "assignment_conflict" && r.detalhe === undefined) continue;
    falhas++;
    logger.error("[handoff-devolucao] devolução falhou", {
      conversation_id: conversa.id,
      organization_id: conversa.organization_id,
      erro: r.erro,
      detalhe: r.detalhe,
      requestId,
    });
  }

  return { organizacoes: prazoPorOrg.size, examinadas: conversas.length, devolvidas, falhas };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resultado: DevolucaoResultado;
  try {
    resultado = await devolverHandoffsVencidos(createAdminClient(), requestId);
  } catch (err) {
    logger.error("[handoff-devolucao] varredura falhou", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", "Failed to scan conversations.", 500, { requestId });
  }

  // Cada devolução já audita por conversa (`ai.reactivated_by_agent`, dentro da
  // função compartilhada). A linha da rodada existe para dizer que foi o prazo,
  // e só quando houve rodada com efeito.
  if (resultado.devolvidas > 0 || resultado.falhas > 0) {
    void audit({
      action: "conversation.handoff_auto_return_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { ...resultado },
      requestId,
    });
  }

  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
