/**
 * GET/POST /api/v1/cron/rodizio-devolucao — devolve À FILA a conversa que o
 * rodízio entregou e ninguém respondeu (issue #2985, fatia 1).
 *
 * ## O que faz, e o que NÃO faz
 *
 * Para cada organização que ligou o prazo em
 * `settings.routing.unanswered_return_minutes`, varre as conversas que têm dono
 * e cujo ÚLTIMO evento de atribuição veio do RODÍZIO (`reason = 'routing'`).
 * Passado o prazo desde essa entrega sem NENHUMA mensagem humana na conversa
 * (`sent_via` `user`, do inbox, ou `external_device`, do celular), solta o dono
 * — a conversa volta para a fila — e marca `conversations.metadata` para que
 * aquela pessoa não receba ESTA conversa de novo por 24 h. Quem reentrega é o
 * `routing-worker`, que lê a mesma marca e a respeita
 * (`filtrarCandidatosExcluidos`, em `lib/routing/worker.ts`).
 *
 * A regra pura (quem vence, o que fica de fora, e por quê) mora em
 * `lib/escalacao/devolucao-ao-rodizio.ts`. Aqui só há I/O e a ordem das
 * escritas — a mesma divisão de `app/api/v1/cron/handoff-devolucao/route.ts`, a
 * regra irmã.
 *
 * Depois de duas devoluções a conversa sai do ciclo (regra pura): fica onde
 * estiver em vez de ser devolvida para sempre. NÃO há aviso a ninguém — os
 * avisos são a fatia 3, e a marca na conversa é o registro.
 *
 * ## Por que 5 em 5 minutos
 *
 * Mesmo raciocínio do cron irmão: o piso do prazo é 5 min e rodar a cada minuto
 * seria 60 varreduras/h por instalação para um prazo que a maioria vai deixar em
 * dezenas de minutos. Cinco minutos de atraso não mudam nada para uma conversa
 * que já está parada.
 *
 * ## As três escritas, e por que nesta ordem
 *
 * 1. `fn_conversation_assign(..., 'release')` com `p_enforce_expected: true` e o
 *    dono LIDO como esperado: quem assumiu a conversa entre a leitura e a
 *    escrita ganha a corrida (0 linhas) e nada mais é escrito. É a MESMA função
 *    do botão "Liberar" da tela — não há régua paralela de atribuição aqui.
 * 2. A marca em `conversations.metadata` — só DEPOIS do release dar certo:
 *    marcar uma devolução que não aconteceu tiraria a pessoa da conversa sem
 *    devolvê-la.
 * 3. `fn_request_channel_routing` devolve a conversa AO RODÍZIO (o trigger de
 *    emissão é AFTER INSERT, então o release não gera evento sozinho).
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed). Audita SÓ quando devolveu ou falhou — varredura
 * vazia não é mutação (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import {
  avaliarEntregaAoRodizio,
  CHAVE_DA_DEVOLUCAO_AO_RODIZIO,
  houveRespostaHumanaDepoisDaEntrega,
  lerPrazoDeDevolucaoAoRodizioMinutos,
  registrarDevolucaoAoRodizio,
  type ConversaEntregueAoRodizio,
  type MarcasDeDevolucaoAoRodizio,
} from "@/lib/escalacao/devolucao-ao-rodizio";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto de conversas lidas por rodada; o que sobrar entra na próxima. */
const SCAN_LIMIT = 500;

/**
 * Teto de eventos de atribuição lidos por rodada. É folgado de propósito (4 por
 * conversa), e o estouro é SEGURO: conversa cujo último evento ficou fora da
 * janela chega aqui como "sem evento" e é pulada pelo portão
 * (`ultimo_evento_nao_e_rodizio`). Erra para "não devolvi", nunca para
 * "devolvi sem saber de quem".
 */
const ASSIGNMENT_EVENT_LIMIT = SCAN_LIMIT * 4;

/** Quem age é o produto, não uma pessoa. */
const ATOR_DO_CRON = { type: "webhook_source", id: "cron:rodizio-devolucao" } as const;

export interface DevolucaoAoRodizioResultado {
  organizacoes: number;
  examinadas: number;
  devolvidas: number;
  falhas: number;
}

/**
 * As organizações com o prazo ligado. O filtro de faixa é feito em memória pelo
 * mesmo motivo do cron irmão: `settings` é jsonb livre e o `->>` no PostgREST
 * repetiria a regra.
 */
async function prazosPorOrganizacao(admin: SupabaseClient): Promise<Map<string, number>> {
  const { data, error } = await admin
    .from("organizations")
    .select("id, settings")
    .not("settings->routing->unanswered_return_minutes", "is", null);
  if (error) throw new Error(`organizations: ${error.message}`);
  const prazos = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ id: string; settings: unknown }>) {
    const minutos = lerPrazoDeDevolucaoAoRodizioMinutos(row.settings);
    if (minutos !== null) prazos.set(row.id, minutos);
  }
  return prazos;
}

/** O motivo e o instante do ÚLTIMO evento de atribuição de cada conversa. */
async function ultimoEventoPorConversa(
  admin: SupabaseClient,
  conversationIds: string[],
): Promise<Map<string, { motivo: string | null; em: string | null }>> {
  const mapa = new Map<string, { motivo: string | null; em: string | null }>();
  if (conversationIds.length === 0) return mapa;
  const { data, error } = await admin
    .from("conversation_assignment_events")
    .select("conversation_id, reason, created_at")
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false })
    .limit(ASSIGNMENT_EVENT_LIMIT);
  if (error) throw new Error(`conversation_assignment_events: ${error.message}`);
  for (const e of (data ?? []) as Array<{ conversation_id: string; reason: string | null; created_at: string }>) {
    // Ordem descendente: a PRIMEIRA linha de cada conversa é o último evento.
    if (!mapa.has(e.conversation_id)) mapa.set(e.conversation_id, { motivo: e.reason, em: e.created_at });
  }
  return mapa;
}

/**
 * A última resposta HUMANA na conversa, em qualquer tempo. O corte "depois da
 * entrega" é da regra pura (`houveRespostaHumanaDepoisDaEntrega`) — assim só há
 * uma definição de "respondeu" no repositório. `lido: false` (erro de banco) é
 * fail-closed: sem ler, não se devolve.
 */
async function ultimaRespostaHumana(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<{ lido: boolean; em: string | null }> {
  const { data, error } = await admin
    .from("messages")
    .select("created_at")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .in("sent_via", ["user", "external_device"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn("[rodizio-devolucao] não consegui ler a última resposta humana", {
      conversation_id: conversationId,
      error: error.message,
    });
    return { lido: false, em: null };
  }
  return { lido: true, em: (data as { created_at: string } | null)?.created_at ?? null };
}

/**
 * Solta o dono, marca a exclusão e devolve a conversa ao rodízio.
 * `false` = a conversa mudou desde a leitura (corrida benigna): nada foi escrito.
 */
async function devolverAoRodizio(
  admin: SupabaseClient,
  conversa: ConversaEntregueAoRodizio,
  minutos: number,
  agora: Date,
): Promise<{ ok: true; devolucoes: number } | { ok: false; erro: string; detalhe?: string }> {
  const dono = conversa.assigned_to_user_id;
  if (dono === null) return { ok: false, erro: "sem_dono" };

  // (1) Solta o dono pela regra de sempre. `p_enforce_expected: true` com o dono
  // LIDO: se alguém assumiu entre a leitura e a escrita, 0 linhas e a pessoa que
  // assumiu ganha — o desfecho certo.
  const { data: liberadas, error: releaseErr } = await admin.rpc("fn_conversation_assign", {
    p_organization_id: conversa.organization_id,
    p_conversation_id: conversa.id,
    p_to_user_id: null as unknown as string,
    p_reason: "release",
    p_expected_assignee: dono,
    p_enforce_expected: true,
  });
  if (releaseErr) return { ok: false, erro: "release_failed", detalhe: releaseErr.message };
  const liberada = Array.isArray(liberadas) ? liberadas[0] : liberadas;
  if (!liberada) return { ok: false, erro: "assignment_conflict" };

  // (2) A marca: aquela pessoa fora DESTA conversa por 24 h, e a devolução
  // contada (é ela que faz a conversa sair do ciclo na segunda).
  const metadata = registrarDevolucaoAoRodizio(conversa.metadata, dono, agora.getTime());
  const { error: markErr } = await admin
    .from("conversations")
    .update({ metadata })
    .eq("id", conversa.id)
    .eq("organization_id", conversa.organization_id);
  if (markErr) {
    // A conversa já voltou à fila — não desfazer é o certo. Mas a exclusão não
    // foi gravada, então ela PODE voltar para a mesma pessoa: é falha, e conta.
    return { ok: false, erro: "marca_nao_gravada", detalhe: markErr.message };
  }

  // (3) Devolve a conversa AO RODÍZIO. O trigger de emissão é AFTER INSERT, então
  // o release acima não gera evento sozinho — sem esta chamada a conversa ficaria
  // parada na fila sem ninguém tentando atribuí-la.
  const { error: routingErr } = await admin.rpc("fn_request_channel_routing", {
    p_org: conversa.organization_id,
    p_conversation: conversa.id,
  });
  if (routingErr) return { ok: false, erro: "routing_nao_pedido", detalhe: routingErr.message };

  const marca = metadata[CHAVE_DA_DEVOLUCAO_AO_RODIZIO] as MarcasDeDevolucaoAoRodizio;
  return { ok: true, devolucoes: marca.devolucoes };
}

export async function devolverConversasAoRodizio(
  admin: SupabaseClient,
  requestId: string,
  agora: Date = new Date(),
): Promise<DevolucaoAoRodizioResultado> {
  const prazoPorOrg = await prazosPorOrganizacao(admin);
  if (prazoPorOrg.size === 0) return { organizacoes: 0, examinadas: 0, devolvidas: 0, falhas: 0 };
  const orgIds = [...prazoPorOrg.keys()];

  const { data, error } = await admin
    .from("conversations")
    .select("id, organization_id, status, assigned_to_user_id, metadata")
    .in("organization_id", orgIds)
    .in("status", ["open", "pending", "claimed", "ai_handling"])
    // Grupo de WhatsApp é sempre de humano: o rodízio nunca o distribui, então
    // não há entrega do rodízio para desfazer.
    .eq("is_group", false)
    // Sem dono não há entrega para desfazer — a conversa já está na fila.
    .not("assigned_to_user_id", "is", null)
    .limit(SCAN_LIMIT);
  if (error) throw new Error(`conversations: ${error.message}`);
  const linhas = (data ?? []) as Array<{
    id: string;
    organization_id: string;
    status: string | null;
    assigned_to_user_id: string | null;
    metadata: unknown;
  }>;

  const eventos = await ultimoEventoPorConversa(
    admin,
    linhas.map((l) => l.id),
  );

  let devolvidas = 0;
  let falhas = 0;
  for (const linha of linhas) {
    const evento = eventos.get(linha.id);
    const conversa: ConversaEntregueAoRodizio = {
      ...linha,
      ultimoEventoMotivo: evento?.motivo ?? null,
      entregueEm: evento?.em ?? null,
    };

    // O portão barato primeiro: só quem passou por ele custa uma consulta de
    // mensagem.
    const portao = avaliarEntregaAoRodizio(conversa, { prazoPorOrg, agoraMs: agora.getTime() });
    if (!portao.candidata) continue;

    const resposta = await ultimaRespostaHumana(admin, conversa.organization_id, conversa.id);
    if (!resposta.lido) continue;
    if (houveRespostaHumanaDepoisDaEntrega(portao.entregueEm, resposta.em)) continue;

    const r = await devolverAoRodizio(admin, conversa, portao.minutos, agora);
    if (r.ok) {
      devolvidas++;
      // Uma linha por conversa: a linha da RODADA diz que o cron rodou; esta diz
      // O QUE aconteceu e com quem.
      await audit({
        action: "conversation.returned_to_routing_queue",
        organizationId: conversa.organization_id,
        resourceType: "conversation",
        resourceId: conversa.id,
        bypassedRls: true,
        requestId,
        metadata: {
          actor_type: ATOR_DO_CRON.type,
          user_id: conversa.assigned_to_user_id,
          apos_minutos: portao.minutos,
          devolucoes: r.devolucoes,
          entregue_em: portao.entregueEm,
        },
      });
      continue;
    }
    // Corrida benigna: a pessoa assumiu a conversa entre a leitura e a escrita e
    // ganhou — o estado final é o que queríamos (a conversa tem quem atenda).
    if (r.erro === "assignment_conflict") continue;
    falhas++;
    logger.error("[rodizio-devolucao] devolução ao rodízio falhou", {
      conversation_id: conversa.id,
      organization_id: conversa.organization_id,
      erro: r.erro,
      detalhe: r.detalhe,
      requestId,
    });
  }

  return { organizacoes: prazoPorOrg.size, examinadas: linhas.length, devolvidas, falhas };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resultado: DevolucaoAoRodizioResultado;
  try {
    resultado = await devolverConversasAoRodizio(createAdminClient(), requestId);
  } catch (err) {
    logger.error("[rodizio-devolucao] varredura falhou", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", "Failed to scan conversations.", 500, { requestId });
  }

  // Cada devolução já audita por conversa. A linha da rodada existe para dizer
  // que foi o prazo, e só quando houve rodada com efeito.
  if (resultado.devolvidas > 0 || resultado.falhas > 0) {
    await audit({
      action: "conversation.routing_return_run",
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
