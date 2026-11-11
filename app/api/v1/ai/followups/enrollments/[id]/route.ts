/**
 * GET /api/v1/ai/followups/enrollments/:id (any member) — o dossiê de UM
 * follow-up: quem é o contato, em que passo está, quando volta a andar, o que
 * já aconteceu (a tabela `followup_enrollment_events`, que existe desde a 0054 e
 * nenhuma tela lia) e, quando houver, o plano de tempo que o agente decidiu.
 *
 * Três decisões que valem mais que o código:
 *
 * 1. **O grafo NÃO sai inteiro.** A leitura é `viewer`, e `config` carrega o
 *    `prompt_hint` — a instrução que o dono do fluxo escreveu para o agente.
 *    Editar fluxo exige `manager`; devolver o config cru daria a quem só lê o
 *    que ele não pode nem abrir. Sai a projeção de `resumoDoNo`.
 *
 * 2. **Grafo pinado ilegível não derruba o dossiê.** `safeParse`: se a versão
 *    pinada não valida contra o schema de hoje, os passos aparecem pelo id com
 *    a frase que diz que é um id. Falhar fechado aqui apagaria justamente a
 *    história de quem mais precisa dela.
 *
 * 3. **`claimed_until` vai para a resposta.** É o que explica um 409 na hora de
 *    intervir: sem ele, a tela diria "não deu" sem poder dizer por quê.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  resumoDoNo,
  rotuloDaAresta,
  type EventoDeEnrollment,
  type NoDoDossie,
} from "@/lib/followup/eventos-legiveis";
import { carregaEtapasCitadas, nomesDasEtapas } from "@/lib/followup/etapas-citadas";
import { leituraDoPlano, type TimingPlan } from "@/lib/followup/plano-de-tempo";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Teto de eventos lidos. O motor escreve ~1 por passo e para em `MAX_STEPS`
 * (80); reactivity e intervenção manual somam poucos. 500 cobre o pior caso com
 * folga — e o `truncado` abaixo existe para que, se algum dia não cobrir, a tela
 * DIGA que está mostrando um pedaço, em vez de mentir por omissão.
 */
const TETO_DE_EVENTOS = 500;

type RouteCtx = { params: Promise<{ id: string }> };

export interface DossieDoEnrollment {
  id: string;
  status: string;
  current_node_id: string;
  next_eval_at: string | null;
  claimed_until: string | null;
  /**
   * O worker está com este enrollment reclamado NESTE INSTANTE.
   *
   * Derivado no servidor de propósito: a comparação é com `now()`, e o relógio
   * que vale é o do lado do banco — o do navegador pode estar minutos fora. É
   * também o que explica um 409 na hora de intervir.
   */
  motor_ocupado: boolean;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  outcome: string | null;
  cancel_reason: string | null;
  last_error: string | null;
  attempts: number;
  max_attempts: number;
  steps_taken: number;
  contact: { id: string; name: string };
  flow: {
    pointer_id: string;
    name: string | null;
    version_id: string;
  };
  agent_name: string | null;
  no_atual: NoDoDossie | null;
  nos: NoDoDossie[];
  /** Saídas do nó atual — é o que a tela oferece para "pular este passo". */
  saidas: Array<{ edge_id: string; target_id: string; target_rotulo: string; quando: string }>;
  eventos: EventoDeEnrollment[];
  eventos_truncados: boolean;
  plano_de_tempo: TimingPlan | null;
  /** id → nome de quem interveio. "Uma pessoa da equipe" não responde "quem?". */
  autores: Record<string, string>;
}

/**
 * Os nomes de quem interveio, resolvidos uma vez por pessoa.
 *
 * O `actor_user_id` é dado da linha (o `payload` do evento). O nome passa pela
 * mesma regra do resto do produto (`nomesDosAtendentes`): só membro (ou
 * ex-membro) desta organização ganha nome, e só o `full_name`, nunca e-mail.
 *
 * IMPORT TARDIO, como em `lib/leads/timeline-query.ts`: o helper arrasta
 * `@/lib/env`, que lança se faltar variável — no topo, quebraria qualquer teste
 * que só importasse este módulo. Sem nome, a tela cai em "uma pessoa da equipe":
 * a falta do nome nunca derruba o dossiê.
 */
async function resolveAutores(
  orgId: string,
  eventos: Array<{ payload: unknown }>,
): Promise<Record<string, string>> {
  const ids = eventos
    .map((e) => (e.payload as { actor_user_id?: unknown } | null)?.actor_user_id)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (ids.length === 0) return {};

  const { nomesDosAtendentes } = await import("@/lib/users/nome-do-atendente");
  const nomes = await nomesDosAtendentes(orgId, ids);
  const autores: Record<string, string> = {};
  for (const [id, nome] of nomes) if (nome && nome.trim() !== "") autores[id] = nome;
  return autores;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_enrollments",
    role: "viewer",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "followup_enrollments", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { organizationId } = authz;

  const supabase = authz.supabase;

  const selecionar =
    `id, status, contact_id, pointer_id, agent_id, version_id, current_node_id, next_eval_at, claimed_until,
     started_at, completed_at, updated_at, outcome, cancel_reason, last_error, attempts, max_attempts,
     steps_taken, timing_plan` +
    (authz.via === "session"
      ? `,
        contacts:contact_id(id, name, display_name, phone_number),
        followup_flow_pointers:pointer_id(name),
        ai_agents:agent_id(name),
        followup_flow_versions:version_id(graph)`
      : "");
  const { data: row, error } = await supabase
    .from("followup_enrollments")
    .select(selecionar)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!row) return fail("not_found", t("Follow-up não encontrado."), 404, { requestId });

  const { data: eventos, error: evErr } = await supabase
    .from("followup_enrollment_events")
    .select("id, node_id, event_type, payload, created_at")
    .eq("organization_id", organizationId)
    .eq("enrollment_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(TETO_DE_EVENTOS + 1);
  if (evErr) return fail("internal_error", evErr.message, 500, { requestId });

  const lidos = eventos ?? [];
  const truncado = lidos.length > TETO_DE_EVENTOS;

  const linha = row as unknown as {
    id: string;
    status: string;
    contact_id: string;
    pointer_id: string;
    agent_id: string | null;
    version_id: string;
    current_node_id: string;
    next_eval_at: string | null;
    claimed_until: string | null;
    started_at: string;
    completed_at: string | null;
    updated_at: string;
    outcome: string | null;
    cancel_reason: string | null;
    last_error: string | null;
    attempts: number;
    max_attempts: number;
    steps_taken: number;
    timing_plan: unknown;
    contacts: { id: string; name: string | null; display_name: string | null; phone_number: string | null } | null;
    followup_flow_pointers: { name: string } | null;
    ai_agents: { name: string } | null;
    followup_flow_versions: { graph: unknown } | null;
  };

  const versao =
    authz.via === "session"
      ? linha.followup_flow_versions
      : linha.version_id
        ? (
            await supabase
              .from("followup_flow_versions")
              .select("graph")
              .eq("id", linha.version_id)
              .eq("organization_id", organizationId)
              .maybeSingle()
          ).data as { graph: unknown } | null
        : null;

  const grafo = versao ? flowGraphSchema.safeParse(versao.graph) : null;
  const nos: NoDoDossie[] = grafo?.success ? grafo.data.nodes.map(resumoDoNo) : [];
  const porId = new Map(nos.map((n) => [n.id, n]));

  // O nó de ORIGEM vai junto: no grafo v2 o rótulo do ramo mora nele, não na
  // aresta — sem ele a tela ofereceria "pelo ramo b3f1" na hora de escolher
  // por onde pular.
  const noDeOrigem = grafo?.success ? grafo.data.nodes.find((n) => n.id === linha.current_node_id) : undefined;

  // A regra de etapa guarda o id; o nome vem do banco. Falha aqui não derruba o
  // dossiê — a frase só descreve a opção, e cai em "(não encontrada)" sem id.
  // `carregaEtapasCitadas` já filtra por organização (sem embed de crm_pipelines).
  const citadas = await carregaEtapasCitadas(supabase, organizationId, noDeOrigem ? [noDeOrigem] : []);
  const nomesDeEtapa = citadas.ok ? nomesDasEtapas(citadas.etapas) : {};
  const saidas = (grafo?.success ? grafo.data.edges : [])
    .filter((e) => e.source === linha.current_node_id)
    .sort((a, b) => b.priority - a.priority)
    .map((e) => ({
      edge_id: e.id,
      target_id: e.target,
      target_rotulo: porId.get(e.target)?.rotulo ?? e.target,
      quando: rotuloDaAresta(e, noDeOrigem, nomesDeEtapa),
    }));

  const contato =
    authz.via === "session"
      ? linha.contacts
      : linha.contact_id
        ? (
            await supabase
              .from("contacts")
              .select("id, name, display_name, phone_number")
              .eq("id", linha.contact_id)
              .eq("organization_id", organizationId)
              .maybeSingle()
          ).data as
            | { id: string; name: string | null; display_name: string | null; phone_number: string | null }
            | null
        : null;
  const pointerNome =
    authz.via === "session"
      ? linha.followup_flow_pointers
      : linha.pointer_id
        ? (
            await supabase
              .from("followup_flow_pointers")
              .select("name")
              .eq("id", linha.pointer_id)
              .eq("organization_id", organizationId)
              .maybeSingle()
          ).data as { name: string } | null
        : null;
  const agente =
    authz.via === "session"
      ? linha.ai_agents
      : linha.agent_id
        ? (
            await supabase
              .from("ai_agents")
              .select("name")
              .eq("id", linha.agent_id)
              .eq("organization_id", organizationId)
              .maybeSingle()
          ).data as { name: string } | null
        : null;

  const dossie: DossieDoEnrollment = {
    id: linha.id,
    status: linha.status,
    current_node_id: linha.current_node_id,
    next_eval_at: linha.next_eval_at,
    claimed_until: linha.claimed_until,
    motor_ocupado: linha.claimed_until !== null && Date.parse(linha.claimed_until) > Date.now(),
    started_at: linha.started_at,
    completed_at: linha.completed_at,
    updated_at: linha.updated_at,
    outcome: linha.outcome,
    cancel_reason: linha.cancel_reason,
    last_error: linha.last_error,
    attempts: linha.attempts,
    max_attempts: linha.max_attempts,
    steps_taken: linha.steps_taken,
    contact: {
      id: linha.contact_id,
      name: contato ? rotuloDoContato(contato) : "Contato removido",
    },
    flow: {
      pointer_id: linha.pointer_id,
      name: pointerNome?.name ?? null,
      version_id: linha.version_id,
    },
    agent_name: agente?.name ?? null,
    no_atual: porId.get(linha.current_node_id) ?? null,
    nos,
    saidas,
    eventos: lidos.slice(0, TETO_DE_EVENTOS) as EventoDeEnrollment[],
    eventos_truncados: truncado,
    plano_de_tempo: leituraDoPlano(linha.timing_plan),
    autores: await resolveAutores(organizationId, lidos),
  };

  return ok(dossie, { requestId });
}
