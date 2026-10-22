/**
 * Gatilhos de ENTRADA POR MENSAGEM (Automações, grupo 2): palavra-chave, link
 * ou QR de entrada, anúncio de clique para o WhatsApp e resposta padrão.
 *
 * EVENT-DRIVEN, irmão de `gatilho-retorno.ts`: o fato é o `message.received`.
 * A regra de casamento é pura e mora em `gatilho-mensagem-regra.ts`.
 *
 * Duas FASES, dois handlers, e a ordem entre eles e o "cliente voltou" é a
 * prioridade do produto:
 *
 *   1. `especificos` (palavra, link, anúncio) — ANTES do retorno: o cliente que
 *      mandou a palavra da promoção quer a promoção, não o "que bom te ver";
 *   2. retorno (`gatilho-retorno.ts`);
 *   3. `padrao` (resposta padrão) — DEPOIS de todos: só fala quando nada mais
 *      falou. Também nunca fala onde um agente de IA publicado atende o número
 *      — o agente É a resposta padrão desse número.
 *
 * ⚠️ UMA VOZ SÓ. O drain do agente acorda no mesmo inbound; o silenciador
 * (`ceder-turno-ao-gatilho-de-mensagem.ts`) usa a mesma regra para o LLM não
 * responder por cima do fluxo.
 *
 * Regras que este produtor respeita (as mesmas do retorno):
 *   - um follow-up vivo por contato (`23505` → skip);
 *   - gate do agente só quando o grafo pede IA;
 *   - conversa com humano no comando, grupo ou contato bloqueado não dispara;
 *   - trigger Postgres nunca faz HTTP.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { triggerConfigSchema } from "./api-schemas";
import { decidirAgenteDoEnrollmentAutomatico, type FollowupGateDb, type NoDeGatilho } from "./agent-followup-gate";
import {
  createSupabaseGatilhoRetornoDb,
  humanoNoComando,
  type EnrollmentVivoRef,
  type GatilhoRetornoDb,
} from "./gatilho-retorno";
import {
  limparPalavras,
  ordenarCandidatos,
  respostaPadraoEmPausa,
  type FatosDaMensagem,
  type GatilhoEspecifico,
} from "./gatilho-mensagem-regra";

export const EVENTO_DE_MENSAGEM = "message.received";
export const EVENTO_DO_ENROLLMENT_POR_MENSAGEM = "enrolled_by_message_trigger";
export const KINDS_DE_MENSAGEM = ["keyword", "ref_link", "ad_click", "default_reply"] as const;

export type FaseDoGatilhoDeMensagem = "especificos" | "padrao";

export type PointerDeMensagem =
  | { id: string; active_version_id: string; gatilho: GatilhoEspecifico }
  | { id: string; active_version_id: string; gatilho: { kind: "default_reply"; intervalo_horas: number } };

export interface MensagemRecebida {
  texto: string | null;
  recebida_em: Date;
  channel_session_id: string | null;
}

export interface GatilhoMensagemDb
  extends Pick<
    GatilhoRetornoDb,
    "carregaEstadoDaConversa" | "carregaEnrollmentVivo" | "carregaNoDeGatilho" | "insereEnrollment" | "insereEventoDoEnrollment"
  > {
  carregaPointersDeMensagem(orgId: string): Promise<PointerDeMensagem[]>;
  carregaMensagem(orgId: string, messageId: string): Promise<MensagemRecebida | null>;
  carregaAnuncioDoContato(orgId: string, contactId: string): Promise<FatosDaMensagem["anuncio"]>;
  /** Um agente de IA publicado responde neste número? (a resposta padrão cede a ele) */
  haAgenteQueResponde(orgId: string, channelSessionId: string): Promise<boolean>;
  /** Quando a resposta padrão deste fluxo falou com este contato pela última vez. */
  ultimaRespostaPadrao(orgId: string, pointerId: string, contactId: string): Promise<Date | null>;
}

export interface GatilhoMensagemSummary {
  matched: boolean;
  pointers_armados: number;
  pointers_casados: number;
  pointers_barrados_pelo_gate: number;
  enrolled: number;
  skipped_existing: number;
  skipped_stale_origin: number;
  skipped_humano: number;
  skipped_grupo: number;
  skipped_bloqueado: number;
  skipped_agente: number;
  skipped_pausa: number;
  contact_id: string | null;
}

export interface GatilhoMensagemDeps {
  db: GatilhoMensagemDb;
  gateDb: FollowupGateDb;
  clock: () => Date;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function vazio(): GatilhoMensagemSummary {
  return {
    matched: false,
    pointers_armados: 0,
    pointers_casados: 0,
    pointers_barrados_pelo_gate: 0,
    enrolled: 0,
    skipped_existing: 0,
    skipped_stale_origin: 0,
    skipped_humano: 0,
    skipped_grupo: 0,
    skipped_bloqueado: 0,
    skipped_agente: 0,
    skipped_pausa: 0,
    contact_id: null,
  };
}

/** Converte o `trigger_config` gravado no ponteiro; `null` = não é gatilho de mensagem. */
export function gatilhoDoPointer(trigger: unknown): PointerDeMensagem["gatilho"] | null {
  const parsed = triggerConfigSchema.safeParse(trigger);
  if (!parsed.success) return null;
  const t = parsed.data;
  switch (t.kind) {
    case "keyword":
      return { kind: "keyword", palavras: limparPalavras(t.params.palavras), modo: t.params.modo };
    case "ref_link":
      return { kind: "ref_link", codigo: t.params.codigo };
    case "ad_click":
      return { kind: "ad_click", anuncios: t.params.anuncios ?? [] };
    case "default_reply":
      return { kind: "default_reply", intervalo_horas: t.params.intervalo_horas };
    default:
      return null;
  }
}

function ehEspecifico(
  p: PointerDeMensagem,
): p is { id: string; active_version_id: string; gatilho: GatilhoEspecifico } {
  return p.gatilho.kind !== "default_reply";
}

/**
 * Aplica UMA linha de `message.received` numa fase. Testável contra fake de DB;
 * o adapter de produção está no fim deste arquivo.
 */
export async function aplicaGatilhoDeMensagem(
  deps: GatilhoMensagemDeps,
  row: EventRow,
  fase: FaseDoGatilhoDeMensagem,
): Promise<GatilhoMensagemSummary> {
  const summary = vazio();
  if (row.event_type !== EVENTO_DE_MENSAGEM) return summary;

  const contatoId = textoOuNulo(row.payload.contact_id);
  const conversaId = textoOuNulo(row.payload.conversation_id);
  const mensagemId = textoOuNulo(row.payload.message_id) ?? textoOuNulo(row.entity_id);
  if (!contatoId || !conversaId || !mensagemId) return summary;
  summary.matched = true;
  summary.contact_id = contatoId;

  const todos = await deps.db.carregaPointersDeMensagem(row.organization_id);
  const daFase = todos.filter((p) => (fase === "especificos" ? ehEspecifico(p) : !ehEspecifico(p)));
  summary.pointers_armados = daFase.length;
  if (daFase.length === 0) return summary;

  const estado = await deps.db.carregaEstadoDaConversa(row.organization_id, conversaId, contatoId);
  if (!estado) return summary;
  if (estado.is_group) {
    summary.skipped_grupo = daFase.length;
    return summary;
  }
  if (estado.is_blocked) {
    summary.skipped_bloqueado = daFase.length;
    return summary;
  }
  const agora = deps.clock();
  if (humanoNoComando(estado, agora)) {
    summary.skipped_humano = daFase.length;
    return summary;
  }

  const mensagem = await deps.db.carregaMensagem(row.organization_id, mensagemId);
  if (!mensagem) return summary;

  let candidatos: PointerDeMensagem[];
  if (fase === "especificos") {
    const especificos = daFase.filter(ehEspecifico);
    const precisaDoAnuncio = especificos.some((p) => p.gatilho.kind === "ad_click");
    const fatos: FatosDaMensagem = {
      texto: mensagem.texto,
      recebida_em: mensagem.recebida_em,
      anuncio: precisaDoAnuncio ? await deps.db.carregaAnuncioDoContato(row.organization_id, contatoId) : null,
    };
    candidatos = ordenarCandidatos(especificos, fatos);
  } else {
    // O agente de IA publicado no número É a resposta padrão dele.
    if (mensagem.channel_session_id && (await deps.db.haAgenteQueResponde(row.organization_id, mensagem.channel_session_id))) {
      summary.skipped_agente = daFase.length;
      return summary;
    }
    candidatos = [];
    for (const p of daFase) {
      if (p.gatilho.kind !== "default_reply") continue;
      const ultima = await deps.db.ultimaRespostaPadrao(row.organization_id, p.id, contatoId);
      if (respostaPadraoEmPausa(ultima, agora, p.gatilho.intervalo_horas)) {
        summary.skipped_pausa++;
        continue;
      }
      candidatos.push(p);
    }
  }
  summary.pointers_casados = candidatos.length;
  if (candidatos.length === 0) return summary;

  const vivo: EnrollmentVivoRef | null = await deps.db.carregaEnrollmentVivo(row.organization_id, contatoId);
  if (vivo) {
    // O contato já está num fluxo: o slot vivo é único, e a mensagem é dele
    // (a reatividade do fluxo vivo já a leu).
    summary.skipped_existing = candidatos.length;
    return summary;
  }

  // O PRIMEIRO candidato que conseguir inscrever fica com o slot; os demais
  // perderiam no 23505.
  for (const pointer of candidatos) {
    const noDeGatilho: NoDeGatilho | null = await deps.db.carregaNoDeGatilho(row.organization_id, pointer.active_version_id);
    if (!noDeGatilho) continue;
    const { agentId, barrado } = await decidirAgenteDoEnrollmentAutomatico(
      deps.gateDb,
      row.organization_id,
      pointer.id,
      noDeGatilho.pedeAgente,
    );
    if (barrado) {
      summary.pointers_barrados_pelo_gate++;
      continue;
    }

    const { inserted, id, reason } = await deps.db.insereEnrollment({
      service_origin: row.payload.service_origin,
      event_id: row.id,
      organization_id: row.organization_id,
      pointer_id: pointer.id,
      version_id: pointer.active_version_id,
      contact_id: contatoId,
      conversation_id: conversaId,
      current_node_id: noDeGatilho.id,
      agent_id: agentId,
    });
    if (!inserted) {
      if (reason === "stale_origin") summary.skipped_stale_origin++;
      else summary.skipped_existing++;
      continue;
    }
    summary.enrolled++;
    if (id) {
      await deps.db.insereEventoDoEnrollment({
        organization_id: row.organization_id,
        enrollment_id: id,
        node_id: noDeGatilho.id,
        event_type: EVENTO_DO_ENROLLMENT_POR_MENSAGEM,
        payload: {
          conversation_id: conversaId,
          message_id: mensagemId,
          event_log_id: row.id,
          trigger_kind: pointer.gatilho.kind,
          message_preview: (mensagem.texto ?? "").slice(0, 80),
        },
        idempotency_key: `gatilho-mensagem:${row.id}`,
      });
    }
    break;
  }

  return summary;
}

export function createSupabaseGatilhoMensagemDb(admin: SupabaseClient): GatilhoMensagemDb {
  const base = createSupabaseGatilhoRetornoDb(admin);
  return {
    carregaEstadoDaConversa: base.carregaEstadoDaConversa,
    carregaEnrollmentVivo: base.carregaEnrollmentVivo,
    carregaNoDeGatilho: base.carregaNoDeGatilho,
    insereEnrollment: base.insereEnrollment,
    insereEventoDoEnrollment: base.insereEventoDoEnrollment,

    async carregaPointersDeMensagem(orgId) {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("id, active_version_id, trigger_config, surface")
        .eq("organization_id", orgId)
        .eq("status", "active")
        .not("active_version_id", "is", null)
        .in("trigger_config->>kind", [...KINDS_DE_MENSAGEM])
        .order("id", { ascending: true });
      if (error) throw new Error(error.message);
      const pointers: PointerDeMensagem[] = [];
      for (const row of (data ?? []) as Array<{
        id: string;
        active_version_id: string | null;
        trigger_config: unknown;
        surface?: string | null;
      }>) {
        if (!row.active_version_id || row.surface === "atendimento") continue;
        const gatilho = gatilhoDoPointer(row.trigger_config);
        if (!gatilho) continue;
        pointers.push({ id: row.id, active_version_id: row.active_version_id, gatilho } as PointerDeMensagem);
      }
      return pointers;
    },

    async carregaMensagem(orgId, messageId) {
      const { data, error } = await admin
        .from("messages")
        .select("body, created_at, channel_session_id")
        .eq("organization_id", orgId)
        .eq("id", messageId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const m = data as { body: string | null; created_at: string; channel_session_id: string | null };
      return { texto: m.body, recebida_em: new Date(m.created_at), channel_session_id: m.channel_session_id };
    },

    async carregaAnuncioDoContato(orgId, contactId) {
      const { data, error } = await admin
        .from("contacts")
        .select("source_metadata")
        .eq("organization_id", orgId)
        .eq("id", contactId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const meta = (data as { source_metadata?: Record<string, unknown> | null } | null)?.source_metadata;
      if (!meta || typeof meta !== "object" || !meta.ad_platform) return null;
      const em = typeof meta.ad_captured_at === "string" ? new Date(meta.ad_captured_at) : null;
      return {
        ad_id: typeof meta.ad_id === "string" ? meta.ad_id : null,
        ad_source_id: typeof meta.ad_source_id === "string" ? meta.ad_source_id : null,
        capturado_em: em && !Number.isNaN(em.getTime()) ? em : null,
      };
    },

    async haAgenteQueResponde(orgId, channelSessionId) {
      // O mesmo recorte do portão do drain (`haQuemAtendaASessao`), na forma
      // do client REST: versão publicada no número, ou roteador ativo nele. Em
      // dúvida (roteador sem membro publicado), conta como "há agente" — a
      // resposta padrão calada é melhor que duas vozes.
      const { data: agentes, error } = await admin
        .from("ai_agents")
        .select("published_version_id")
        .eq("organization_id", orgId)
        .is("archived_at", null)
        .not("published_version_id", "is", null);
      if (error) throw new Error(error.message);
      const versoes = ((agentes ?? []) as Array<{ published_version_id: string | null }>)
        .map((a) => a.published_version_id)
        .filter((v): v is string => typeof v === "string");
      if (versoes.length > 0) {
        const { count, error: errV } = await admin
          .from("ai_agent_versions")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("status", "published")
          .eq("channel_session_id", channelSessionId)
          .in("id", versoes);
        if (errV) throw new Error(errV.message);
        if ((count ?? 0) > 0) return true;
      }
      const { count: roteadores, error: errR } = await admin
        .from("ai_routers")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .eq("channel_session_id", channelSessionId);
      if (errR) throw new Error(errR.message);
      return (roteadores ?? 0) > 0;
    },

    async ultimaRespostaPadrao(orgId, pointerId, contactId) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("started_at")
        .eq("organization_id", orgId)
        .eq("pointer_id", pointerId)
        .eq("contact_id", contactId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const raw = (data as { started_at: string | null } | null)?.started_at;
      if (!raw) return null;
      const at = new Date(raw);
      return Number.isNaN(at.getTime()) ? null : at;
    },
  };
}
