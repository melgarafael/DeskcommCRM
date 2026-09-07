import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
/**
 * O retorno agendado do lado do CRM — adaptador de banco + as operações que a
 * capacidade da IA e a tela do humano compartilham.
 *
 * A REGRA mora em `./retorno.ts` (janela, guard anti-empilhamento, derivação da
 * situação) e é a mesma que o motor do agente executa sobre `pg.Pool`. Aqui fica
 * o que só existe deste lado: o acesso via client do Supabase, a resolução do
 * negócio a que o retorno pertence e a emissão da atividade na timeline.
 *
 * ⚠️ CLIENT SERVICE-ROLE BYPASSA RLS. Toda query filtra `organization_id`
 * explicitamente, e o id da organização vem sempre de fonte confiável (JWT do
 * humano ou contexto do agente), nunca do payload de quem chamou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";

import { resolveJanelaDeRetorno, type JanelaDeRetorno } from "./janela";
import {
  agendaRetorno,
  cancelaRetorno,
  listaRetornos,
  situacaoDoRetorno,
  type AgendaRetornoInput,
  type ResultadoDoAgendamento,
  type ResultadoDoCancelamento,
  type RetornoAgendado,
  type RetornoDb,
} from "./retorno";

/** As colunas que descrevem um retorno. Uma lista só — leitura e escrita. */
const COLUNAS =
  "id, contact_id, next_run_at, enabled, payload, cancelled_at, cancel_reason";

interface LinhaDeCron {
  id: string;
  contact_id: string;
  next_run_at: string;
  enabled: boolean;
  payload: Record<string, unknown> | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function paraRetorno(row: LinhaDeCron): RetornoAgendado {
  const payload = row.payload ?? {};
  return {
    id: row.id,
    contactId: row.contact_id,
    quando: row.next_run_at,
    prometidoPara: texto(payload.promised_at),
    situacao: situacaoDoRetorno({ enabled: row.enabled, cancelled_at: row.cancelled_at }),
    motivo: texto(payload.reason) ?? "Retorno agendado",
    promessa: texto(payload.promise),
    canceladoEm: row.cancelled_at,
    motivoDoCancelamento: row.cancel_reason,
  };
}

/**
 * Adaptador do `RetornoDb` sobre o Supabase.
 *
 * Os filtros `kind='at'` + `job_kind='followup_turn'` estão em TODA query de
 * propósito: `cron_jobs` também guarda watchdog e flywheel, e um cancelamento
 * que alcançasse a linha errada desligaria um mecanismo que ninguém pediu para
 * desligar — silenciosamente, porque a tabela é a mesma.
 */
export function criaRetornoDbSupabase(admin: SupabaseClient): RetornoDb {
  const base = () =>
    admin.from("cron_jobs").select(COLUNAS).eq("kind", "at").eq("job_kind", "followup_turn");

  return {
    async buscaRetornoVivo(orgId, contactId) {
      const { data, error } = await base()
        .eq("organization_id", orgId)
        .eq("contact_id", contactId)
        .eq("enabled", true)
        .order("next_run_at", { ascending: true })
        .limit(1);
      if (error) throw new Error(`retorno_vivo_query_failed: ${error.message}`);
      const row = (data ?? [])[0] as LinhaDeCron | undefined;
      return row ? paraRetorno(row) : null;
    },

    async insere(orgId, input) {
      const boundary = await beginServiceAtOrigin(admin, orgId, input.contactId);
      const { data, error } = await admin
        .from("cron_jobs")
        .insert({
          organization_id: orgId,
          contact_id: input.contactId,
          kind: "at",
          job_kind: "followup_turn",
          next_run_at: input.quando.toISOString(),
          payload: { ...input.payload, conversation_id: boundary.conversation_id, service_boundary: boundary },
        })
        .select(COLUNAS)
        .single();
      if (error || !data) {
        throw new Error(`retorno_insert_failed: ${error?.message ?? "sem linha"}`);
      }
      return paraRetorno(data as unknown as LinhaDeCron);
    },

    async buscaPorId(orgId, retornoId) {
      const { data, error } = await base()
        .eq("organization_id", orgId)
        .eq("id", retornoId)
        .maybeSingle();
      if (error) throw new Error(`retorno_query_failed: ${error.message}`);
      return data ? paraRetorno(data as unknown as LinhaDeCron) : null;
    },

    async marcaCancelado(orgId, retornoId, quando, motivo) {
      // `enabled = true` no WHERE É a trava: entre a leitura e a escrita o cron
      // pode ter disparado. Perder a corrida devolve 0 linhas, e quem chamou
      // trata como "já encerrado" — nunca como sucesso.
      const { data, error } = await admin
        .from("cron_jobs")
        .update({
          enabled: false,
          cancelled_at: quando.toISOString(),
          cancel_reason: motivo.slice(0, 200),
          updated_at: quando.toISOString(),
        })
        .eq("organization_id", orgId)
        .eq("id", retornoId)
        .eq("enabled", true)
        .select("id");
      if (error) throw new Error(`retorno_cancel_failed: ${error.message}`);
      return (data ?? []).length > 0;
    },

    async lista(orgId, contactId, limite) {
      const { data, error } = await base()
        .eq("organization_id", orgId)
        .eq("contact_id", contactId)
        .order("next_run_at", { ascending: false })
        .limit(limite);
      if (error) throw new Error(`retorno_lista_failed: ${error.message}`);
      return ((data ?? []) as unknown as LinhaDeCron[]).map(paraRetorno);
    },
  };
}

// ---------------------------------------------------------------------------
// A quem o retorno pertence
// ---------------------------------------------------------------------------

/**
 * O retorno viaja por CONTATO (`cron_jobs.contact_id`) e a timeline pertence a um
 * NEGÓCIO (`crm_lead_activities.lead_id`, NOT NULL). Este é o ponteiro entre os
 * dois — e ele pode legitimamente não achar negócio nenhum.
 */
export interface AlvoDoRetorno {
  contactId: string;
  /** `null` = a pessoa não tem negócio aberto, ou tem mais de um empatado. */
  leadId: string | null;
}

export type ResolucaoDoAlvo =
  | { ok: true; alvo: AlvoDoRetorno }
  | { ok: false; codigo: "negocio_nao_encontrado" | "negocio_sem_contato" | "cliente_nao_encontrado" };

/**
 * De qual pessoa e de qual negócio é este retorno.
 *
 * Com `leadId`, o alvo é exato — é a forma preferida, e a única em que a
 * timeline nunca cai no lugar errado. Com `contactId`, o negócio é resolvido
 * pelo MESMO `resolveActiveLeadForContact` que o motor usa: quando há ambiguidade
 * ele NÃO adivinha, e o retorno é agendado com `leadId: null`. Agendar sem linha
 * na timeline é pior que não agendar? Não: o retorno é o anti-morte, e a
 * ausência dele é a morte que a doutrina proíbe. A perda de rastro vira evento.
 */
export async function resolveAlvoDoRetorno(
  admin: SupabaseClient,
  orgId: string,
  ref: { leadId?: string | null; contactId?: string | null },
): Promise<ResolucaoDoAlvo> {
  if (ref.leadId) {
    const { data, error } = await admin
      .from("crm_leads")
      .select("id, contact_id")
      .eq("organization_id", orgId)
      .eq("id", ref.leadId)
      .maybeSingle();
    if (error) throw new Error(`alvo_query_failed: ${error.message}`);
    if (data) {
      const contactId = (data as { contact_id: string | null }).contact_id;
      // Sem contato não há para quem voltar a falar: o retorno nasceria com um
      // horário e nenhum destinatário, e dispararia um turno que não tem canal.
      if (!contactId) return { ok: false, codigo: "negocio_sem_contato" };
      return { ok: true, alvo: { contactId, leadId: ref.leadId } };
    }
    // ⚠️ NÃO EXISTIR NÃO PODE MATAR A DEMANDA QUANDO O CLIENTE VEIO JUNTO.
    //
    // Achado num turno de modelo REAL: com `lead_id` opcional na assinatura, o
    // modelo preencheu `00000000-0000-0000-0000-000000000000` — o placeholder que
    // ele usa para "não tenho este campo" — E mandou um `contact_id` correto,
    // vindo da busca que ele acabara de fazer. A precedência antiga deixava o
    // campo-lixo envenenar a chamada boa: eu recusava com "confira a capacidade
    // de listar oportunidades" tendo em mãos tudo o que precisava.
    //
    // Só cai aqui quando o id NÃO RESOLVE NADA nesta organização — não há negócio
    // certo a preservar, então usar o cliente é estritamente melhor que recusar.
    // Se o id resolvesse para outro negócio, a precedência do lead continuaria
    // valendo, que é o que impede o retorno de cair no card errado.
    if (!ref.contactId) return { ok: false, codigo: "negocio_nao_encontrado" };
  }

  if (!ref.contactId) return { ok: false, codigo: "cliente_nao_encontrado" };

  const { data: contato, error: contatoErr } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("id", ref.contactId)
    .maybeSingle();
  if (contatoErr) throw new Error(`alvo_query_failed: ${contatoErr.message}`);
  if (!contato) return { ok: false, codigo: "cliente_nao_encontrado" };

  const { data: candidatos } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
    .eq("organization_id", orgId)
    .eq("contact_id", ref.contactId);

  const { data: padrao } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();

  const rota = resolveActiveLeadForContact((candidatos ?? []) as LeadCandidate[], {
    defaultPipelineId: (padrao as { id: string } | null)?.id ?? null,
  });

  return {
    ok: true,
    alvo: { contactId: ref.contactId, leadId: rota.routed ? rota.leadId : null },
  };
}

// ---------------------------------------------------------------------------
// Atividade
// ---------------------------------------------------------------------------

interface AtividadeDoRetorno {
  orgId: string;
  alvo: AlvoDoRetorno;
  tipo: ActivityType;
  actor: Actor;
  reason: string;
  payload: Record<string, unknown>;
  origem: string;
  requestId?: string;
}

/**
 * A linha na timeline — falha BAIXO, mas falha CONTADA.
 *
 * O retorno já foi agendado (ou cancelado) quando chegamos aqui: bloquear a
 * operação porque a timeline caiu deixaria o anti-morte refém do registro. Mas
 * falhar baixo é escolher não bloquear, nunca escolher não contar — a perda vira
 * `event_log` via `registraFalhaDeAtividade`, como nos demais emissores.
 *
 * Sem negócio a que pertencer, não há linha possível (`lead_id` é NOT NULL) e o
 * que resta é registrar que o rastro não coube em lugar nenhum.
 */
async function registraAtividade(
  admin: SupabaseClient,
  input: AtividadeDoRetorno,
): Promise<void> {
  if (!input.alvo.leadId) {
    await registraFalhaDeAtividade(admin, {
      organizationId: input.orgId,
      // Sem lead não há âncora; o contato é o que se sabe, e vai no lugar do id
      // para o alerta não sair mudo sobre QUEM ficou sem rastro.
      leadId: input.alvo.contactId,
      tipo: input.tipo,
      origem: `${input.origem} (sem negócio aberto para ancorar)`,
      erro: undefined,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    return;
  }

  const resultado = await emitLeadActivity(admin, {
    organizationId: input.orgId,
    leadId: input.alvo.leadId,
    contactId: input.alvo.contactId,
    type: input.tipo,
    sourceModule: "followup",
    sourceId: input.alvo.leadId,
    actor: input.actor,
    reason: input.reason,
    payload: input.payload,
  });
  if (!resultado.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: input.orgId,
      leadId: input.alvo.leadId,
      tipo: input.tipo,
      origem: input.origem,
      erro: resultado.error,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Operações de CRM
// ---------------------------------------------------------------------------

export interface DepsDoRetorno {
  admin: SupabaseClient;
  orgId: string;
  actor: Actor;
  requestId?: string;
  /** Injetável nos testes; produção usa o relógio do processo. */
  agora?: Date;
  /** Injetável nos testes; produção lê os knobs do ambiente. */
  janela?: JanelaDeRetorno;
}

function janelaDe(deps: DepsDoRetorno): JanelaDeRetorno {
  return deps.janela ?? resolveJanelaDeRetorno(process.env);
}

/** Quando nem o cliente nem o negócio existem, não há retorno a falar de quem. */
export type FalhaDeAlvo = Extract<ResolucaoDoAlvo, { ok: false }>;

/**
 * O `reason` NÃO REPETE O RÓTULO — descoberto olhando a tela, não o teste.
 *
 * A timeline renderiza o rótulo do tipo (`Retorno agendado`) e, embaixo, o
 * `reason`. Com o reason começando por "Retorno agendado — ", o dossiê mostrava:
 *
 *     Retorno agendado
 *     Retorno agendado — reconfirmar a proposta que o cliente pediu para pensar
 *
 * O teste passava (ele checava `toContain(motivo)`) e a leitura era burra. É a
 * diferença entre "funcionou" e "ficou bom": nenhuma asserção pega isso, só
 * abrir o dossiê pega. O padrão da casa é o de `stageChangeReason` — o rótulo
 * nomeia o QUE aconteceu, o reason conta o PORQUÊ, e eles não se repetem.
 */
function motivoLegivel(texto: string): string {
  const limpo = texto.trim();
  if (limpo === "") return "Sem motivo informado";
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

/**
 * Agenda o retorno e registra o acontecimento.
 *
 * Devolve o mesmo resultado da regra, acrescido do alvo resolvido — quem chamou
 * precisa saber a qual negócio a linha foi ancorada para responder ao modelo (ou
 * ao humano) sem uma segunda consulta.
 */
export async function agendaRetornoNoCrm(
  deps: DepsDoRetorno,
  ref: { leadId?: string | null; contactId?: string | null },
  input: AgendaRetornoInput,
): Promise<(ResultadoDoAgendamento & { alvo?: AlvoDoRetorno }) | FalhaDeAlvo> {
  const alvo = await resolveAlvoDoRetorno(deps.admin, deps.orgId, ref);
  if (!alvo.ok) return { ok: false, codigo: alvo.codigo };

  const agora = deps.agora ?? new Date();
  const resultado = await agendaRetorno(
    criaRetornoDbSupabase(deps.admin),
    { agora, janela: janelaDe(deps) },
    { orgId: deps.orgId, contactId: alvo.alvo.contactId },
    input,
  );
  if (!resultado.ok) return { ...resultado, alvo: alvo.alvo };

  await registraAtividade(deps.admin, {
    orgId: deps.orgId,
    alvo: alvo.alvo,
    tipo: "followup_scheduled",
    actor: deps.actor,
    reason: motivoLegivel(input.motivo),
    payload: {
      retorno_id: resultado.retorno.id,
      quando: resultado.retorno.quando,
      prometido_para: resultado.retorno.prometidoPara,
    },
    origem: "lib/followup/retorno-crm.agendaRetornoNoCrm",
    ...(deps.requestId ? { requestId: deps.requestId } : {}),
  });

  return { ...resultado, alvo: alvo.alvo };
}

/**
 * Cancela o retorno e registra a decisão.
 *
 * ⚠️ A ATIVIDADE AQUI NÃO É ENFEITE: é ela que o agente encontra ao retomar. Sem
 * a linha, uma pessoa desmarca o retorno e o agente reagenda o mesmo retorno no
 * turno seguinte, insistindo com quem já pediu para parar.
 */
export async function cancelaRetornoNoCrm(
  deps: DepsDoRetorno,
  retornoId: string,
  input: { motivo: string },
): Promise<ResultadoDoCancelamento & { alvo?: AlvoDoRetorno }> {
  const agora = deps.agora ?? new Date();
  const resultado = await cancelaRetorno(
    criaRetornoDbSupabase(deps.admin),
    { agora },
    { orgId: deps.orgId, retornoId },
    input,
  );
  if (!resultado.ok) return resultado;

  const alvo = await resolveAlvoDoRetorno(deps.admin, deps.orgId, {
    contactId: resultado.retorno.contactId,
  });
  const alvoResolvido: AlvoDoRetorno = alvo.ok
    ? alvo.alvo
    : { contactId: resultado.retorno.contactId, leadId: null };

  await registraAtividade(deps.admin, {
    orgId: deps.orgId,
    alvo: alvoResolvido,
    tipo: "followup_cancelled",
    actor: deps.actor,
    reason: motivoLegivel(input.motivo),
    payload: {
      retorno_id: resultado.retorno.id,
      quando: resultado.retorno.quando,
    },
    origem: "lib/followup/retorno-crm.cancelaRetornoNoCrm",
    ...(deps.requestId ? { requestId: deps.requestId } : {}),
  });

  return { ...resultado, alvo: alvoResolvido };
}

export async function listaRetornosNoCrm(
  deps: DepsDoRetorno,
  ref: { leadId?: string | null; contactId?: string | null },
  opts: { limite?: number } = {},
): Promise<{ ok: true; alvo: AlvoDoRetorno; retornos: RetornoAgendado[] } | FalhaDeAlvo> {
  const alvo = await resolveAlvoDoRetorno(deps.admin, deps.orgId, ref);
  if (!alvo.ok) return { ok: false, codigo: alvo.codigo };

  const retornos = await listaRetornos(
    criaRetornoDbSupabase(deps.admin),
    { orgId: deps.orgId, contactId: alvo.alvo.contactId },
    opts,
  );
  return { ok: true, alvo: alvo.alvo, retornos };
}
