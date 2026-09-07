import { serviceForEvent } from "@/lib/atendimento/origem";
/**
 * Gatilho de ETAPA DO FUNIL (`trigger_config.kind='stage_change'`) — o
 * follow-up passa a nascer sozinho quando o negócio entra numa etapa escolhida.
 *
 * EVENT-DRIVEN, não time-driven, e a escolha não é gosto. "O lead entrou na
 * etapa X" É um evento, com hora e autor: já existe a linha
 * `event_log.event_type='lead.stage_changed'`. Silêncio (`silence-sweep.ts`) é
 * o contrário — AUSÊNCIA de evento por um período, que nenhuma linha registra,
 * e por isso aquele é varredura periódica. Aqui reusamos o dispatcher genérico
 * (`lib/event-log/dispatcher.ts` + `drain.ts`), como `reactivity.ts` já faz:
 * `consumed_by[]` dá idempotência de re-drain de graça, e uma falha nossa não
 * derruba o tick do motor, que roda noutra rota.
 *
 * QUEM EMITE `lead.stage_changed` (levantado no código, não presumido):
 *   - `app/api/v1/leads/[id]/move/route.ts`  — o arrasto do card no Kanban
 *   - `app/api/v1/leads/_handler.ts` (`moveLeadHandler`) — MCP e automações
 *   - `app/api/v1/leads/bulk/route.ts` — movimento em lote
 * O payload traz `from_stage_id`/`to_stage_id` e `entity_id` = id do negócio;
 * `contact_id` NÃO vem, por isso é resolvido aqui a partir do lead.
 *
 * ⚠️ O ASSISTENTE TAMBÉM ARMA ESTE GATILHO. `lib/leads/agent-stage-sync.ts:309`
 * emite `lead.stage_changed` no `event_log` quando a IA move o card, igual às
 * rotas HTTP de movimento — então card movido por humano e card movido pelo
 * assistente entram por aqui pelo mesmo caminho. (Este bloco já afirmou o
 * contrário, e a afirmação sobreviveu ao conserto do emissor: typecheck, lint e
 * a suíte inteira passam com um comentário falso dentro. Num arquivo em que o
 * comentário é a doutrina, isso grava modelo mental errado — o gate não lê
 * comentário, então quem lê é quem edita.)
 *
 * Regras do motor que este produtor RESPEITA (nenhuma é contornada):
 *   - **Um follow-up vivo por lead.** `idx_followup_enrollments_one_live` é
 *     org-wide `(organization_id, contact_id)`: um contato vivo em QUALQUER
 *     fluxo barra o insert. `23505` é caminho normal — vira `skipped_existing`,
 *     nunca erro.
 *   - **Gate do agente.** `resolveAgentForAutomaticTrigger` — só enrolla se
 *     algum agente PUBLICADO da org arma este pointer. É o que impede fluxo
 *     rascunho de disparar em produção; e o `agent_id` que ele devolve é pinado
 *     no enrollment (persona + exibição na fila).
 *   - **Trigger Postgres nunca faz HTTP.** Nada aqui roda dentro da transação
 *     do banco: o trigger só emitiu a linha, quem consome é este worker.
 *
 * PROVENIÊNCIA sem coluna nova (doutrina DIRC — Calcular/Referenciar antes de
 * Duplicar): o enrollment nascido aqui grava um `followup_enrollment_events`
 * `enrolled_by_stage_change` com o negócio, a etapa de origem e a de destino.
 * A fila lê essa timeline; uma coluna `origem` em `followup_enrollments` seria
 * uma segunda verdade sobre o mesmo fato.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { flowGraphSchema } from "./graph-schema";
import { triggerConfigSchema } from "./api-schemas";
import { resolveAgentForAutomaticTrigger, type FollowupGateDb } from "./agent-followup-gate";

/** O evento que este produtor consome. Constante porque o handler e os testes
 *  precisam do MESMO literal — duas cópias divergiriam no primeiro ajuste. */
export const EVENTO_DE_ETAPA = "lead.stage_changed";

/** Um pointer ativo armado por etapa, já com a etapa que ele espera. */
export interface PointerDeEtapa {
  id: string;
  organization_id: string;
  active_version_id: string;
  stage_id: string;
}

/** Interface estreita de DB — mesma doutrina de `SilenceSweepDb`/`ReactivityAdminClient`:
 *  narrow por consumidor, para o teste rodar contra Postgres cru sem arrastar o
 *  `SupabaseClient` inteiro. */
export interface GatilhoEtapaDb {
  /** Pointers `status='active'` da org com `trigger_config.kind='stage_change'`. */
  carregaPointersDeEtapa(orgId: string): Promise<PointerDeEtapa[]>;
  /** `contact_id` do negócio — `null` quando o negócio não tem contato (coluna é nullable). */
  carregaContatoDoNegocio(orgId: string, leadId: string): Promise<string | null>;
  /** id do nó `trigger` do grafo pinado; `null` se a version sumiu (defensivo). */
  carregaNoDeGatilho(orgId: string, versionId: string): Promise<string | null>;
  /** `inserted:false` = 23505 (contato já vivo em algum fluxo) → skip silencioso. */
  insereEnrollment(input: {
    service_origin?: unknown;
    event_id?: string;
    organization_id: string;
    pointer_id: string;
    version_id: string;
    contact_id: string;
    current_node_id: string;
    /**
     * ⚠️ OMITIDO DE PROPÓSITO quando o enrollment nasce vencido — e é sempre o
     * caso deste produtor. Quem grava aqui o "agora" do PROCESSO grava um
     * instante que ainda é FUTURO para o claim (que compara com `now()` do
     * Postgres, e o banco fica 17–34 ms atrás): o tick seguinte pula o
     * enrollment e ele espera o tick DEPOIS, até 60 s. Ausente, o
     * `default now()` da coluna (migration 0147) resolve com o relógio certo,
     * sem round-trip e sem nada para chamar errado. Só preencha para agendar no
     * FUTURO, onde o desvio é irrelevante.
     */
    next_eval_at?: string;
    agent_id: string | null;
  }): Promise<{ inserted: boolean; id: string | null; reason?: "stale_origin" }>;
  /** A linha de proveniência na timeline do enrollment. */
  insereEventoDoEnrollment(evento: {
    organization_id: string;
    enrollment_id: string;
    node_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<void>;
}

export interface GatilhoEtapaSummary {
  /** `false` = evento não utilizável por este produtor (sem etapa de destino, sem negócio). */
  matched: boolean;
  pointers_armados: number;
  pointers_barrados_pelo_gate: number;
  enrolled: number;
  skipped_existing: number;
  skipped_stale_origin?: number;
  /** Negócio entrou na etapa mas não tem contato — não há a quem escrever. Contado, nunca calado. */
  sem_contato: number;
}

export interface GatilhoEtapaDeps {
  db: GatilhoEtapaDb;
  gateDb: FollowupGateDb;
  clock: () => Date;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function vazio(): GatilhoEtapaSummary {
  return {
    matched: false,
    pointers_armados: 0,
    pointers_barrados_pelo_gate: 0,
    enrolled: 0,
    skipped_existing: 0,
    sem_contato: 0,
  };
}

/**
 * Aplica UMA linha de `lead.stage_changed`. Chamado pelo adapter do dispatcher
 * (`gatilho-etapa.handler.ts`) e diretamente pelos testes contra Postgres real.
 */
export async function aplicaGatilhoDeEtapa(
  deps: GatilhoEtapaDeps,
  row: EventRow,
): Promise<GatilhoEtapaSummary> {
  const summary = vazio();
  if (row.event_type !== EVENTO_DE_ETAPA) return summary;

  const etapaDestino = textoOuNulo(row.payload.to_stage_id);
  const negocioId = textoOuNulo(row.entity_id);
  // Sem etapa de destino ou sem negócio o evento não descreve o fato que este
  // gatilho espera. `matched:false` faz o dispatcher registrar 'skipped' — o
  // evento fica marcado como visto, não como consumido com efeito.
  if (!etapaDestino || !negocioId) return summary;
  summary.matched = true;

  const armados = (await deps.db.carregaPointersDeEtapa(row.organization_id)).filter(
    (p) => p.stage_id === etapaDestino,
  );
  summary.pointers_armados = armados.length;
  // Sai ANTES de consultar o negócio: a esmagadora maioria das mudanças de
  // etapa não tem fluxo armado, e uma ida ao banco por card arrastado seria
  // custo puro.
  if (armados.length === 0) return summary;

  const contatoId = await deps.db.carregaContatoDoNegocio(row.organization_id, negocioId);
  if (!contatoId) {
    summary.sem_contato = armados.length;
    return summary;
  }

  for (const pointer of armados) {
    const agentId = await resolveAgentForAutomaticTrigger(deps.gateDb, row.organization_id, pointer.id);
    if (agentId === null) {
      summary.pointers_barrados_pelo_gate++;
      continue;
    }

    const noDeGatilho = await deps.db.carregaNoDeGatilho(row.organization_id, pointer.active_version_id);
    if (!noDeGatilho) continue;

    const { inserted, id, reason } = await deps.db.insereEnrollment({
      service_origin: row.payload.service_origin,
      event_id: row.id,
      organization_id: row.organization_id,
      pointer_id: pointer.id,
      version_id: pointer.active_version_id,
      contact_id: contatoId,
      current_node_id: noDeGatilho,
      // `next_eval_at` NÃO vai: o default do banco decide. Ver o comentário na
      // interface e a migration 0147.
      agent_id: agentId,
    });
    if (!inserted) {
      if (reason === "stale_origin") summary.skipped_stale_origin = (summary.skipped_stale_origin ?? 0) + 1;
      else summary.skipped_existing++;
      continue;
    }
    summary.enrolled++;

    if (id) {
      // A proveniência é o que faz a fila conseguir responder "por que este
      // contato está aqui?". Chave idempotente pela linha do event_log: um
      // re-drain do MESMO evento não escreve a linha duas vezes.
      await deps.db.insereEventoDoEnrollment({
        organization_id: row.organization_id,
        enrollment_id: id,
        node_id: noDeGatilho,
        event_type: "enrolled_by_stage_change",
        payload: {
          lead_id: negocioId,
          from_stage_id: textoOuNulo(row.payload.from_stage_id),
          to_stage_id: etapaDestino,
          event_log_id: row.id,
        },
        idempotency_key: `gatilho-etapa:${row.id}`,
      });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Adapter de produção — `GatilhoEtapaDb` sobre o client service-role real.
// ---------------------------------------------------------------------------

export function createSupabaseGatilhoEtapaDb(admin: SupabaseClient): GatilhoEtapaDb {
  return {
    async carregaPointersDeEtapa(orgId) {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("id, organization_id, active_version_id, trigger_config")
        .eq("organization_id", orgId)
        .eq("status", "active")
        .not("active_version_id", "is", null);
      if (error) throw new Error(error.message);

      const pointers: PointerDeEtapa[] = [];
      for (const row of (data ?? []) as Array<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: unknown;
      }>) {
        if (!row.active_version_id) continue;
        // O parse é o MESMO schema do publish — um `trigger_config` que não
        // passa nele não arma nada, em vez de armar torto.
        const parsed = triggerConfigSchema.safeParse(row.trigger_config);
        if (!parsed.success || parsed.data.kind !== "stage_change") continue;
        pointers.push({
          id: row.id,
          organization_id: row.organization_id,
          active_version_id: row.active_version_id,
          stage_id: parsed.data.params.stage_id,
        });
      }
      return pointers;
    },

    async carregaContatoDoNegocio(orgId, leadId) {
      const { data, error } = await admin
        .from("crm_leads")
        .select("contact_id")
        .eq("id", leadId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.contact_id ?? null;
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
      const graph = flowGraphSchema.parse(data.graph);
      return graph.nodes.find((n) => n.type === "trigger")?.id ?? null;
    },

    async insereEnrollment(input) {
      const { service_origin: _origin, event_id, ...values } = input;
      const boundary = event_id ? await serviceForEvent(admin, input.organization_id, event_id, input.contact_id) : null;
      if (!boundary) return { inserted: false, id: null, reason: "stale_origin" };
      // O `.select("id")` não é enfeite: sem o id não há linha de proveniência,
      // e o enrollment apareceria na fila sem dizer de onde veio.
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
      // 23505 aqui é o índice de idempotência (re-drain do mesmo evento):
      // caminho normal, não erro.
      if (error && error.code !== "23505") throw new Error(error.message);
    },
  };
}
