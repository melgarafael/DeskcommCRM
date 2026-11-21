/**
 * GET/POST /api/v1/cron/handoff-devolucao — devolve ao agente de IA a conversa
 * que ficou com uma pessoa e passou do prazo sem nenhum sinal dela.
 *
 * ## O que faz, e o que NÃO faz
 *
 * Para cada organização que ligou o prazo em Configurações › Distribuição de
 * atendimento (`settings.routing.handoff_return_after_minutes`), varre as
 * passagens formais (`bot_silenced_until = 'infinity'`) que NINGUÉM assumiu e
 * devolve as que passaram do prazo sem resposta humana nenhuma depois da
 * passagem. Conversa com dono humano, ou em que uma pessoa já respondeu ao
 * cliente, não é devolvida por relógio: atendimento humano em curso só volta à
 * IA por ação explícita de alguém (`pessoaNoComando`, em
 * `lib/escalacao/devolucao-automatica.ts`). A exceção é o dono que veio SÓ da
 * distribuição automática — sorteio, sem passagem da IA, sem Assumir/Transferir
 * e sem resposta de gente (`atendimentoHumanoEfetivo`): esse não está atendendo,
 * e o mesmo prazo o devolve à IA. A regra pura (quem vence, o que fica de fora, e
 * por quê) mora em `lib/escalacao/devolucao-automatica.ts`.
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
  avaliarDevolucao,
  lerPrazoDeDevolucaoMinutos,
  selecionarVencidas,
  type ConversaEmHandoff,
  type FatosDaAtribuicao,
} from "@/lib/escalacao/devolucao-automatica";
import { humanoRespondeuDepoisDe } from "@/lib/escalacao/handoff-tecnico";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";

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

/**
 * O evento que deu o dono atual de cada conversa (o mais recente), por org.
 * Filtra `organization_id` explicitamente: é o cliente de serviço.
 */
async function ultimasAtribuicoes(
  admin: SupabaseClient,
  organizationId: string,
  conversationIds: string[],
): Promise<Map<string, { reason: string; changed_by: string | null }>> {
  const out = new Map<string, { reason: string; changed_by: string | null }>();
  if (conversationIds.length === 0) return out;
  const { data, error } = await admin
    .from("conversation_assignment_events")
    .select("conversation_id, reason, changed_by, created_at")
    .eq("organization_id", organizationId)
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`conversation_assignment_events: ${error.message}`);
  for (const row of (data ?? []) as Array<{
    conversation_id: string;
    reason: string;
    changed_by: string | null;
  }>) {
    if (!out.has(row.conversation_id)) {
      out.set(row.conversation_id, { reason: row.reason, changed_by: row.changed_by });
    }
  }
  return out;
}

/**
 * Os fatos de `atendimentoHumanoEfetivo` — SÓ para o dono que o relógio já
 * devolveria (recorte 2, prazo vencido). Ler eventos e mensagens de toda conversa
 * com dono seria uma ida ao banco por atendimento ativo a cada 5 minutos.
 */
async function fatosDasAtribuicoes(
  admin: SupabaseClient,
  conversas: readonly ConversaEmHandoff[],
  sel: Parameters<typeof avaliarDevolucao>[1],
): Promise<Map<string, FatosDaAtribuicao>> {
  const candidatas = conversas.filter(
    (c) => c.assigned_to_user_id !== null && c.last_handoff_at === null && avaliarDevolucao(c, sel).devolver,
  );
  const porOrg = new Map<string, ConversaEmHandoff[]>();
  for (const c of candidatas) porOrg.set(c.organization_id, [...(porOrg.get(c.organization_id) ?? []), c]);

  const fatos = new Map<string, FatosDaAtribuicao>();
  for (const [org, lista] of porOrg) {
    const eventos = await ultimasAtribuicoes(admin, org, lista.map((c) => c.id));
    for (const c of lista) {
      fatos.set(c.id, {
        ultimaAtribuicao: eventos.get(c.id) ?? null,
        // Sem carimbo da atribuição não há como provar que ninguém respondeu.
        humanoRespondeuDesdeAAtribuicao:
          c.assigned_at === null || (await humanoRespondeuDepoisDe(admin, org, c.id, c.assigned_at)),
      });
    }
  }
  return fatos;
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
      "id, organization_id, channel_session_id, status, assignee_kind, assigned_to_user_id, assigned_at, bot_silenced_until, last_handoff_at, last_outbound_at, status_changed_at, metadata",
    )
    .in("organization_id", orgIds)
    .in("status", ["open", "pending", "claimed", "ai_handling"])
    // Grupo de WhatsApp é sempre de humano: o automático nunca o atende, então
    // "devolver ao agente" tiraria o grupo da fila humana sem ninguém responder.
    .eq("is_group", false)
    // Dois recortes, e nenhum outro:
    //  1. a passagem formal que NINGUÉM assumiu (sem dono, silêncio permanente);
    //  2. o dono que pode ter vindo SÓ da distribuição automática — com dono e
    //     sem passagem para humano (`last_handoff_at` nulo). Quem decide se é
    //     sorteio ou atendimento é `atendimentoHumanoEfetivo`, com os fatos lidos
    //     abaixo. Conversa com dono E passagem é transferência real: nem entra.
    // Trazer o resto só gastaria o teto de 500 linhas com descartes, empurrando
    // para fora da varredura justamente as passagens esquecidas.
    .or(
      "and(assigned_to_user_id.is.null,bot_silenced_until.eq.infinity)," +
        "and(assigned_to_user_id.not.is.null,last_handoff_at.is.null)",
    )
    .limit(SCAN_LIMIT);
  if (error) throw new Error(`conversations: ${error.message}`);
  const conversas = (data ?? []) as ConversaEmHandoff[];

  const sel = {
    prazoPorOrg,
    sessoesComAgente: await sessoesComAgente(admin, orgIds),
    agoraMs: agora.getTime(),
  };
  const fatos = await fatosDasAtribuicoes(admin, conversas, sel);
  const vencidas = selecionarVencidas(conversas, sel, fatos);

  let devolvidas = 0;
  let falhas = 0;
  for (const { conversa, minutos } of vencidas) {
    const donoDoSorteio = conversa.assigned_to_user_id;
    // Uma pessoa respondeu ao cliente DEPOIS da passagem — pelo Inbox ou pelo
    // celular — sem clicar em Assumir: ela está atendendo, e o relógio não a
    // tira da conversa. Contar a resposta só como "último sinal humano"
    // reiniciava o prazo, e o técnico que passava do prazo sem escrever (porque
    // estava resolvendo o problema) via a IA voltar no meio do atendimento.
    // Sem carimbo da passagem não há como provar que ninguém respondeu: fica.
    // Para o dono do sorteio, o carimbo é o da atribuição (reconferido aqui, na
    // hora da escrita: a resposta pode ter chegado depois da leitura dos fatos).
    const desde = donoDoSorteio !== null
      ? conversa.assigned_at
      : (conversa.last_handoff_at ?? conversa.status_changed_at);
    if (desde === null || (await humanoRespondeuDepoisDe(admin, conversa.organization_id, conversa.id, desde))) {
      logger.info("[handoff-devolucao] não devolvida: há atendimento humano depois da passagem", {
        conversation_id: conversa.id,
        organization_id: conversa.organization_id,
        requestId,
      });
      continue;
    }
    // O dono do sorteio que clicou em Assumir (ou foi transferido) DEPOIS da
    // leitura dos fatos: o dono é o mesmo, então `expectedAssignee` não o pega —
    // o evento novo, sim. Reler o último evento logo antes da escrita.
    if (donoDoSorteio !== null) {
      const agoraEvento = (await ultimasAtribuicoes(admin, conversa.organization_id, [conversa.id])).get(conversa.id);
      if (!agoraEvento || agoraEvento.reason !== "routing" || agoraEvento.changed_by !== null) {
        logger.info("[handoff-devolucao] não devolvida: a pessoa assumiu a conversa do sorteio", {
          conversation_id: conversa.id,
          organization_id: conversa.organization_id,
          requestId,
        });
        continue;
      }
    }
    const r = await devolverAtendimentoAoAgente(
      { supabase: admin, organizationId: conversa.organization_id, actor: ATOR_DO_CRON, requestId },
      // `expectedAssignee` — o dono LIDO (null na passagem sem dono; o do sorteio
      // no recorte 2). Só é devolvida se o dono continuar o mesmo na hora da
      // escrita: quem assumiu ou recebeu transferência entre a leitura e aqui
      // ganha — `retomada.ts` recusa com `assignment_conflict` sem detalhe (a
      // corrida benigna abaixo) e nada é solto. Sem isto, a retomada liberava o
      // dono recém-chegado — o release do cron não exige precondição.
      { conversationId: conversa.id, origem: { automatica: { minutos } }, expectedAssignee: donoDoSorteio },
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
    // Engolir os quatro escondia defeito real com cara de disputa benigna: a
    // rodada reportava `falhas: 0` sem auditar nada enquanto o banco recusava
    // a devolução.
    if (r.erro === "assignment_conflict" && r.detalhe === undefined) continue;
    // Recusa ESPERADA, não falha (issue 2379): o contato está marcado "sempre
    // atendimento humano" (`contacts.ai_opt_out`) e é exatamente isto que a
    // devolução automática não pode desfazer. Contar como `falhas` faria o
    // cron reclamar a cada tick para sempre sobre um estado que a operação
    // pediu; não registrar nada esconderia a recusa — então ela vira linha de
    // log próprio e o shape do retorno fica igual.
    if (r.erro === "contato_sempre_humano") {
      logger.info("[handoff-devolucao] devolução recusada: contato é sempre atendimento humano", {
        conversation_id: conversa.id,
        organization_id: conversa.organization_id,
        requestId,
      });
      continue;
    }
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

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO (#3773), na ordem do arquivo.
 *
 * O portão abaixo é saída antecipada da ROTA INTEIRA: em instalação ociosa a
 * rota sai antes de tudo isto. `tests/unit/cron-passa-pelo-portao.test.ts` lê o
 * AST deste arquivo e reprova quando o que está de fato abaixo do portão diverge
 * desta lista — passo novo que não roda na instalação parada não pode nascer
 * sem alguém ver.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "let resultado",
  "try",
  "if (resultado.devolvidas > 0 || resultado.falhas > 0)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // O PISO OCIOSO (#3731): Sem conversa em atendimento humano não há handoff para devolver.
  // A saída vem antes de qualquer consulta da rodada, e o portão responde de um
  // retrato em memória (`lib/cron/piso-ocioso.ts`): esta rota ia ao PostgREST a
  // cada batida só para descobrir que a fila está vazia.
  if (await recursoOcioso("devolucao_de_handoff")) return ok({ pulado: "recurso_ocioso" }, { requestId });

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
