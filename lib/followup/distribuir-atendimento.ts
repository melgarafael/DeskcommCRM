/**
 * O efeito do bloco `distribute` (módulo Automações, out/2026): entregar a
 * conversa do contato a uma pessoa da equipe.
 *
 * Não inventa régua nova. Com `so_disponiveis` (o padrão) os candidatos saem de
 * `loadEligibleAttendants` e a gravação passa por `fn_channel_routing_claim` —
 * exatamente o caminho do rodízio da empresa (`lib/routing/worker.ts`): mesma
 * disponibilidade, horário, capacidade, responsáveis do número e trava contra
 * corrida. Sem a régua de disponibilidade, grava por `fn_conversation_assign`
 * com `p_enforce_expected` (só pega conversa SEM dono). Nos dois casos o lead
 * aberto do contato ganha o mesmo dono (`adotarLeadsDoContato`), senão o funil
 * de quem recebeu ficaria vazio no modo de visibilidade "só os meus".
 *
 * Idempotente por construção: conversa com dono nunca é trocada, então o
 * replay de um tick devolve `ja_tinha_dono` e o fluxo segue pelo mesmo ramo.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

import { logger } from "@/lib/logger";
import { loadEligibleAttendants, InvalidRoutingChannel } from "@/lib/routing/eligibles";
import { OPEN_LOAD_STATUSES } from "@/lib/routing/eligibility";
import { adotarLeadsDoContato } from "@/lib/routing/worker";

import { ordemDeEscolha, type CandidatoDaDistribuicao } from "./distribuicao";
import type { DistributeConfig } from "./graph-schema";

type Admin = ReturnType<typeof createAdminClient>;

export type MotivoSemDistribuicao =
  | "sem_conversa"
  | "sem_candidatos"
  | "sem_carteira"
  | "ninguem_elegivel"
  | "disputa";

export type ResultadoDaDistribuicao =
  | { resultado: "atribuido"; usuario_id: string; conversation_id: string }
  | { resultado: "ja_tinha_dono"; usuario_id: string; conversation_id: string }
  | { resultado: "ninguem_disponivel"; motivo: MotivoSemDistribuicao; conversation_id: string | null };

interface ConversaAlvo {
  id: string;
  contact_id: string;
  channel_session_id: string;
  assigned_to_user_id: string | null;
}

const COLUNAS = "id, contact_id, channel_session_id, assigned_to_user_id";

/** A conversa da inscrição; sem ela, a conversa aberta mais recente do contato (nunca grupo). */
async function conversaAlvo(
  admin: Admin,
  organizationId: string,
  contactId: string,
  conversationId: string | null,
): Promise<ConversaAlvo | null> {
  if (conversationId) {
    const { data, error } = await admin
      .from("conversations")
      .select(COLUNAS)
      .eq("organization_id", organizationId)
      .eq("id", conversationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data as ConversaAlvo;
  }
  const { data, error } = await admin
    .from("conversations")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("is_group", false)
    .in("status", OPEN_LOAD_STATUSES as unknown as string[])
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ConversaAlvo | null) ?? null;
}

/** Os ids que o bloco aceita, na ordem em que foram escritos, com o peso de cada um. */
async function idsDoDestino(
  admin: Admin,
  organizationId: string,
  contactId: string,
  config: DistributeConfig,
): Promise<{ ids: string[]; pesos: Map<string, number> } | "sem_carteira"> {
  const pesos = new Map<string, number>();
  if (config.destino.tipo === "atendente") {
    const id = config.destino.usuario_id.trim();
    return { ids: id ? [id] : [], pesos };
  }
  if (config.destino.tipo === "equipe") {
    const ids: string[] = [];
    for (const m of config.destino.membros) {
      const id = m.usuario_id.trim();
      if (!id || ids.includes(id)) continue;
      ids.push(id);
      pesos.set(id, m.peso ?? 1);
    }
    return { ids, pesos };
  }
  const { data, error } = await admin
    .from("contacts")
    .select("carteira_user_id")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const dono = (data as { carteira_user_id?: string | null } | null)?.carteira_user_id ?? null;
  return dono ? { ids: [dono], pesos } : "sem_carteira";
}

/**
 * Candidatos SEM a régua de disponibilidade: todo membro ativo (atendente para
 * cima) da lista, com a carga e o último recebimento calculados como no rodízio.
 */
async function candidatosSemDisponibilidade(
  admin: Admin,
  organizationId: string,
  ids: string[],
): Promise<CandidatoDaDistribuicao[]> {
  const { data: membros, error } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .in("role", ["agent", "manager", "admin"])
    .in("user_id", ids);
  if (error) throw new Error(error.message);
  const ativos = ((membros ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (ativos.length === 0) return [];

  const { data: abertas, error: cargaErr } = await admin
    .from("conversations")
    .select("assigned_to_user_id")
    .eq("organization_id", organizationId)
    .in("assigned_to_user_id", ativos)
    .in("status", OPEN_LOAD_STATUSES as unknown as string[]);
  if (cargaErr) throw new Error(cargaErr.message);
  const carga = new Map<string, number>();
  for (const c of (abertas ?? []) as Array<{ assigned_to_user_id: string | null }>) {
    if (c.assigned_to_user_id) carga.set(c.assigned_to_user_id, (carga.get(c.assigned_to_user_id) ?? 0) + 1);
  }

  const { data: historico, error: histErr } = await admin
    .from("conversation_assignment_events")
    .select("to_user_id, created_at")
    .eq("organization_id", organizationId)
    .in("to_user_id", ativos)
    .order("created_at", { ascending: false })
    .limit(500);
  if (histErr) throw new Error(histErr.message);
  const ultima = new Map<string, number>();
  for (const e of (historico ?? []) as Array<{ to_user_id: string | null; created_at: string }>) {
    if (e.to_user_id && !ultima.has(e.to_user_id)) ultima.set(e.to_user_id, new Date(e.created_at).getTime());
  }

  return ativos.map((userId) => ({
    userId,
    currentLoad: carga.get(userId) ?? 0,
    lastAssignedAt: ultima.get(userId) ?? null,
  }));
}

export async function distribuirAtendimento(
  admin: Admin,
  input: {
    organization_id: string;
    contact_id: string;
    conversation_id: string | null;
    /** Inscrição + nó: fixa o sorteio dos modos `aleatorio` e `percentual`. */
    chave: string;
    config: DistributeConfig;
    now: Date;
  },
): Promise<ResultadoDaDistribuicao> {
  const { organization_id: org, contact_id: contato, config } = input;

  const conversa = await conversaAlvo(admin, org, contato, input.conversation_id);
  if (!conversa) return { resultado: "ninguem_disponivel", motivo: "sem_conversa", conversation_id: null };
  if (conversa.assigned_to_user_id) {
    return { resultado: "ja_tinha_dono", usuario_id: conversa.assigned_to_user_id, conversation_id: conversa.id };
  }

  const destino = await idsDoDestino(admin, org, contato, config);
  if (destino === "sem_carteira") {
    return { resultado: "ninguem_disponivel", motivo: "sem_carteira", conversation_id: conversa.id };
  }
  if (destino.ids.length === 0) {
    return { resultado: "ninguem_disponivel", motivo: "sem_candidatos", conversation_id: conversa.id };
  }

  const soDisponiveis = config.so_disponiveis !== false;
  let candidatos: CandidatoDaDistribuicao[];
  if (soDisponiveis) {
    try {
      const elegiveis = await loadEligibleAttendants(admin, org, input.now, {
        kind: "conversation_channel",
        channelSessionId: conversa.channel_session_id,
      });
      candidatos = elegiveis.filter((c) => destino.ids.includes(c.userId));
    } catch (err) {
      if (!(err instanceof InvalidRoutingChannel)) throw err;
      candidatos = [];
    }
  } else {
    candidatos = await candidatosSemDisponibilidade(admin, org, destino.ids);
  }
  const teto = config.limite_por_atendente;
  if (teto !== undefined) candidatos = candidatos.filter((c) => c.currentLoad < teto);
  for (const c of candidatos) c.peso = destino.pesos.get(c.userId) ?? 1;
  if (candidatos.length === 0) {
    return { resultado: "ninguem_disponivel", motivo: "ninguem_elegivel", conversation_id: conversa.id };
  }

  const modo = config.destino.tipo === "equipe" ? config.destino.modo : "rodizio";
  const ordem = ordemDeEscolha(modo, candidatos, input.chave);

  for (const usuario of ordem) {
    let gravou = false;
    if (soDisponiveis) {
      const { data, error } = await admin.rpc("fn_channel_routing_claim", {
        p_org: org,
        p_conversation: conversa.id,
        p_channel: conversa.channel_session_id,
        p_user: usuario,
        p_reason: "routing",
        p_schedule: candidatos.find((c) => c.userId === usuario)?.scheduleSnapshot ?? {},
      });
      if (error) throw new Error(`fn_channel_routing_claim: ${error.message}`);
      if (data === "already_assigned" || data === "conversation_changed") break;
      gravou = data === "assigned";
    } else {
      const { data, error } = await admin.rpc("fn_conversation_assign", {
        p_organization_id: org,
        p_conversation_id: conversa.id,
        p_to_user_id: usuario,
        p_reason: "routing",
        p_expected_assignee: null,
        p_enforce_expected: true,
      });
      if (error) {
        // Membro que saiu da equipe entre a leitura e a gravação: tenta o próximo.
        if (/assignee_not_eligible_member/.test(error.message)) continue;
        throw new Error(`fn_conversation_assign: ${error.message}`);
      }
      gravou = Array.isArray(data) && data.length > 0;
      if (!gravou) break; // a conversa ganhou dono no meio do caminho
    }
    if (gravou) {
      await adotarLeadsDoContato(admin, org, conversa.contact_id, usuario);
      return { resultado: "atribuido", usuario_id: usuario, conversation_id: conversa.id };
    }
  }

  // Alguém atribuiu antes de nós? Então a conversa tem dono e o fluxo segue.
  const { data: depois, error: depoisErr } = await admin
    .from("conversations")
    .select("assigned_to_user_id")
    .eq("organization_id", org)
    .eq("id", conversa.id)
    .maybeSingle();
  if (depoisErr) throw new Error(depoisErr.message);
  const dono = (depois as { assigned_to_user_id?: string | null } | null)?.assigned_to_user_id ?? null;
  if (dono) return { resultado: "ja_tinha_dono", usuario_id: dono, conversation_id: conversa.id };

  logger.info("[followup.distribute] nenhum candidato aceitou a conversa", {
    organization_id: org,
    conversation_id: conversa.id,
    candidatos: ordem.length,
  });
  return { resultado: "ninguem_disponivel", motivo: "disputa", conversation_id: conversa.id };
}
