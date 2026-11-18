import { serviceForEvent } from "@/lib/atendimento/origem";
/**
 * Gatilho LEAD CRIADO (`trigger_config.kind='lead_created'`).
 *
 * EVENT-DRIVEN, irmão de `gatilho-etapa.ts`: o fato já é a linha
 * `event_log.event_type='lead.created'` com `entity_kind='crm_lead'`.
 * Quem emite (levantado no código, não presumido):
 *   - `app/api/v1/leads/_handler.ts` — cadastro manual, API, importação, webhook
 *   - `lib/leads/nascimento-do-lead.ts` — a conversa que abre o primeiro card
 *
 * Importação de planilha NÃO inscreve: ela também passa por
 * `createLeadHandler`, e 400 linhas com telefone viravam 400 mensagens
 * proativas de uma vez — o disparo em massa que a doutrina anti-banimento
 * existe para impedir, sem que a tela do gatilho mencionasse planilha. O
 * evento chega marcado (`metadata.via`) e conta `vindos_de_planilha`, nunca cala.
 *
 * `contact_id` não vem no payload do cadastro; resolve-se pelo negócio.
 * Sem contato não há a quem escrever — conta `sem_contato`, nunca cala.
 *
 * Um follow-up vivo por contato (`23505` → skip). Grafo que pede IA só
 * enrolla com agente publicado armando o pointer; texto fixo nasce com
 * `agent_id` nulo. Trigger Postgres nunca faz HTTP: quem consome é o drain.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { eventoDaIaNoAssistido } from "@/lib/automation/parada-no-assistido";
import { ORIGEM_DA_PLANILHA } from "@/lib/leads/planilha";
import { normalizarTag } from "@/lib/contacts/tag-normalizada";
import { flowGraphSchema } from "./graph-schema";
import { triggerConfigSchema } from "./api-schemas";
import {
  decidirAgenteDoEnrollmentAutomatico,
  noDeGatilhoDoGrafo,
  type FollowupGateDb,
  type NoDeGatilho,
} from "./agent-followup-gate";

export const EVENTO_DE_LEAD_CRIADO = "lead.created";

/**
 * O filtro do gatilho (#4587): em QUAL funil e/ou com QUAL etiqueta o card
 * precisa nascer. Ausente nos dois = qualquer card, como sempre foi.
 */
export interface FiltroDeLead {
  pipelineId?: string;
  tag?: string;
}

export interface PointerDeLead {
  id: string;
  organization_id: string;
  active_version_id: string;
  filtro?: FiltroDeLead;
}

/** O card que nasceu: é dele que saem o contato, o funil e as etiquetas. */
export interface CartaoDoNegocio {
  contactId: string | null;
  pipelineId: string | null;
  tags: string[];
}

export interface GatilhoLeadDb {
  carregaPointersDeLead(orgId: string): Promise<PointerDeLead[]>;
  carregaCartaoDoNegocio(orgId: string, leadId: string): Promise<CartaoDoNegocio | null>;
  carregaNoDeGatilho(orgId: string, versionId: string): Promise<NoDeGatilho | null>;
  insereEnrollment(input: {
    service_origin?: unknown;
    event_id?: string;
    organization_id: string;
    pointer_id: string;
    version_id: string;
    contact_id: string;
    current_node_id: string;
    next_eval_at?: string;
    agent_id: string | null;
  }): Promise<{ inserted: boolean; id: string | null; reason?: "stale_origin" }>;
  insereEventoDoEnrollment(evento: {
    organization_id: string;
    enrollment_id: string;
    node_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<void>;
}

export interface GatilhoLeadSummary {
  matched: boolean;
  pointers_armados: number;
  pointers_barrados_pelo_gate: number;
  enrolled: number;
  skipped_existing: number;
  skipped_stale_origin?: number;
  /** A IA criou o negócio no modo assistido: a sequência espera alguém inscrever (doc 301 = B). */
  parados_no_assistido?: number;
  /** O card nasceu fora do funil/etiqueta que este fluxo pede (#4587). */
  fora_do_filtro?: number;
  sem_contato: number;
  vindos_de_planilha: number;
}

export interface GatilhoLeadDeps {
  db: GatilhoLeadDb;
  gateDb: FollowupGateDb;
  clock: () => Date;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * O card que nasceu casa com o filtro do fluxo? (#4587)
 *
 * Sem filtro, casa com tudo — é o comportamento anterior a esta mudança, e é
 * ele que precisa continuar valendo para todo fluxo já publicado.
 *
 * A etiqueta é comparada NORMALIZADA: o banco guarda a forma de
 * `lib/contacts/tag-normalizada` (minúscula, aparam as pontas), então comparar
 * a string crua faria a tela recusar «VIP» para um card etiquetado «vip».
 */
export function casaComOFiltro(
  filtro: FiltroDeLead | undefined,
  cartao: CartaoDoNegocio,
): boolean {
  if (!filtro) return true;
  if (filtro.pipelineId && cartao.pipelineId !== filtro.pipelineId) return false;
  if (filtro.tag) {
    const alvo = normalizarTag(filtro.tag);
    if (!cartao.tags.some((t) => normalizarTag(t) === alvo)) return false;
  }
  return true;
}

function vazio(): GatilhoLeadSummary {
  return {
    matched: false,
    pointers_armados: 0,
    pointers_barrados_pelo_gate: 0,
    enrolled: 0,
    skipped_existing: 0,
    sem_contato: 0,
    vindos_de_planilha: 0,
  };
}

export async function aplicaGatilhoDeLead(
  deps: GatilhoLeadDeps,
  row: EventRow,
): Promise<GatilhoLeadSummary> {
  const summary = vazio();
  if (row.event_type !== EVENTO_DE_LEAD_CRIADO) return summary;
  if (row.entity_kind !== "crm_lead") return summary;

  const negocioId = textoOuNulo(row.entity_id);
  if (!negocioId) return summary;
  summary.matched = true;

  const armados = await deps.db.carregaPointersDeLead(row.organization_id);
  summary.pointers_armados = armados.length;
  if (armados.length === 0) return summary;

  if (row.metadata?.via === ORIGEM_DA_PLANILHA) {
    summary.vindos_de_planilha = armados.length;
    return summary;
  }

  const cartao = await deps.db.carregaCartaoDoNegocio(row.organization_id, negocioId);
  if (!cartao?.contactId) {
    summary.sem_contato = armados.length;
    return summary;
  }
  const contatoId = cartao.contactId;

  // Doc 301 = B: a mesma guarda do gatilho de etapa (`gatilho-etapa.ts`).
  if (eventoDaIaNoAssistido(row)) {
    summary.parados_no_assistido = armados.length;
    return summary;
  }

  for (const pointer of armados) {
    // #4587: card de outro funil (ou sem a etiqueta) não arma ESTE fluxo. Sem
    // esta linha, o card do funil B inscrevia o contato no fluxo do funil A e —
    // por só existir um fluxo vivo por contato — bloqueava o fluxo certo.
    if (!casaComOFiltro(pointer.filtro, cartao)) {
      summary.fora_do_filtro = (summary.fora_do_filtro ?? 0) + 1;
      continue;
    }
    const noDeGatilho = await deps.db.carregaNoDeGatilho(row.organization_id, pointer.active_version_id);
    if (!noDeGatilho) continue;
    // #3852: sem canal, e é deliberado. `lead.created` não carrega conversa (o
    // payload é `{lead_id, pipeline_id, stage_id, contact_id, source}` —
    // `supabase/baseline.sql:233`), e a conversa nasce/se resolve no INSERT
    // (`serviceForEvent` → `fn_service_event_origin`, `supabase/baseline.sql:20571`/`20577`).
    // Deduzir a sessão aqui escolheria um número possivelmente diferente do que
    // o envio usa — e o turno resolve o agente PELO número
    // (`agent-config.ts:430`, `v.channel_session_id = $2`), então seria persona
    // de um número com envio por outro. Este produtor mantém a decisão por
    // organização até o evento ter canal.
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
      current_node_id: noDeGatilho.id,
      agent_id: agentId,
    });
    if (!inserted) {
      if (reason === "stale_origin") summary.skipped_stale_origin = (summary.skipped_stale_origin ?? 0) + 1;
      else summary.skipped_existing++;
      continue;
    }
    summary.enrolled++;

    if (id) {
      await deps.db.insereEventoDoEnrollment({
        organization_id: row.organization_id,
        enrollment_id: id,
        node_id: noDeGatilho.id,
        event_type: "enrolled_by_lead_created",
        payload: { lead_id: negocioId, event_log_id: row.id },
        idempotency_key: `gatilho-lead:${row.id}`,
      });
    }
  }

  return summary;
}

export function createSupabaseGatilhoLeadDb(admin: SupabaseClient): GatilhoLeadDb {
  return {
    async carregaPointersDeLead(orgId) {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("id, organization_id, active_version_id, trigger_config, surface")
        .eq("organization_id", orgId)
        .eq("status", "active")
        .not("active_version_id", "is", null);
      if (error) throw new Error(error.message);

      const pointers: PointerDeLead[] = [];
      for (const row of (data ?? []) as Array<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: unknown;
        surface?: string | null;
      }>) {
        // Roteiro de atendimento (0394) é do turno, nunca do relógio: o banco
        // já o prende em gatilho manual, e este corte é a segunda porta.
        if (!row.active_version_id || row.surface === "atendimento") continue;
        const parsed = triggerConfigSchema.safeParse(row.trigger_config);
        if (!parsed.success || parsed.data.kind !== "lead_created") continue;
        // #4587: o filtro viaja junto do pointer. `params` é opcional no
        // schema — ausente é "qualquer funil, qualquer etiqueta".
        const params = parsed.data.params;
        const filtro: FiltroDeLead = {};
        if (params?.pipeline_id) filtro.pipelineId = params.pipeline_id;
        if (params?.tag) filtro.tag = params.tag;
        pointers.push({
          id: row.id,
          organization_id: row.organization_id,
          active_version_id: row.active_version_id,
          ...(filtro.pipelineId || filtro.tag ? { filtro } : {}),
        });
      }
      return pointers;
    },

    async carregaCartaoDoNegocio(orgId, leadId) {
      const { data, error } = await admin
        .from("crm_leads")
        .select("contact_id, pipeline_id, tags")
        .eq("id", leadId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const linha = data as { contact_id: string | null; pipeline_id: string | null; tags: string[] | null };
      return {
        contactId: linha.contact_id ?? null,
        pipelineId: linha.pipeline_id ?? null,
        tags: Array.isArray(linha.tags) ? linha.tags : [],
      };
    },

    async carregaNoDeGatilho(orgId, versionId) {
      const { data, error } = await admin
        .from("followup_flow_versions")
        .select("graph")
        .eq("organization_id", orgId)
        .eq("id", versionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return noDeGatilhoDoGrafo(flowGraphSchema.parse(data.graph));
    },

    async insereEnrollment(input) {
      const { service_origin: _origin, event_id, ...values } = input;
      const boundary = event_id
        ? await serviceForEvent(admin, input.organization_id, event_id, input.contact_id)
        : null;
      if (!boundary) return { inserted: false, id: null, reason: "stale_origin" };
      const { data, error } = await admin
        .from("followup_enrollments")
        .insert({ ...values, conversation_id: boundary.conversation_id, service_boundary: boundary })
        .select("id")
        .maybeSingle();
      if (error) {
        if (error.code === "23505") return { inserted: false, id: null };
        throw new Error(error.message);
      }
      return { inserted: true, id: (data as { id: string } | null)?.id ?? null };
    },

    async insereEventoDoEnrollment(evento) {
      const { error } = await admin.from("followup_enrollment_events").insert(evento);
      if (error && error.code !== "23505") throw new Error(error.message);
    },
  };
}
