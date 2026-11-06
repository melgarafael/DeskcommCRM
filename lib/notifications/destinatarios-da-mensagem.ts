/**
 * Quem é avisado de uma MENSAGEM RECEBIDA (`message.received`, conversa 1:1).
 *
 * ═══ A regra, em ordem de precedência ═══
 *
 * 1. Conversa COM responsável → SÓ o responsável e os ADMINISTRADORES da
 *    organização (`user_organizations.role = 'admin'`, vínculo não revogado).
 *    O resto do time não é interrompido por cliente que já tem dono. Esta
 *    regra vem antes de tudo e não lê agente nem plantão.
 * 2. Sem responsável e a IA ATENDENDO → NINGUÉM. "Atendendo" é a conversa
 *    sem silêncio nem trava (`comandoDaConversa(...).quem === 'automatico'`)
 *    E o turno do dreno rodaria nela: agente automático no ar no NÚMERO da
 *    conversa (versão publicada nele, ou roteador ativo nele com fallback ou
 *    membro que execute — os predicados de `haQuemAtendaASessao`), o FILTRO DE
 *    PALAVRAS da versão (`trigger_config.filters.keyword_regex`) aceitando a
 *    última mensagem recebida ou o agente já tendo respondido neste
 *    atendimento (a âncora do #3240), e a elegibilidade do canal e do contato
 *    permitindo. Na dúvida, não cala.
 *    A pessoa é chamada quando a IA passa a conversa: a passagem grava o
 *    silêncio e abre o aviso `handoff` da Central, que vai ao celular por
 *    `central.aviso_criado` (`./push-dos-avisos.ts`). Dali em diante o silêncio
 *    deixa o comando em "aguardando" e as mensagens seguintes caem na regra 3.
 * 3. Sem responsável, com distribuição automática (modo efetivo do canal
 *    `round_robin` ou `load`) → quem está DE PLANTÃO (`estaDePlantao`: a chave
 *    `is_available` e a jornada, a mesma conta do roteador, recortada pelos
 *    responsáveis do canal quando ele os tem). Ninguém de plantão → gerentes e
 *    administradores — o mesmo público do aviso que o roteador abre quando
 *    não acha elegível (`fn_routing_unassigned_notice`).
 * 4. Senão (modo manual) → TODOS da organização: alguém precisa pegar a fila.
 *
 * ═══ Por que o plantão só vale na distribuição automática ═══
 *
 * `attendant_availability.is_available` nasce `false`, e a batida de presença
 * cria a linha de todo atendente que abre o app sem ligá-la. Filtrar sempre
 * pelo plantão calaria a fila de toda organização que nunca configurou
 * disponibilidade — e o modo padrão é `manual`, em que o roteador também não a
 * consulta. A presença (`last_heartbeat_at`) não decide nada aqui.
 *
 * ═══ Quem é "o responsável" ═══
 *
 * 1. `conversations.assigned_to_user_id`, quando preenchido. É quem está
 *    ATENDENDO agora, e vence o dono do negócio.
 * 2. Só quando a conversa está sem atendente: o `owner_user_id` dos negócios
 *    ABERTOS (`crm_leads.status = 'open'`) do contato. Havendo mais de um
 *    negócio aberto com donos diferentes, TODOS os donos são avisados — não
 *    há critério honesto para escolher um.
 *
 * Negócio aberto sem dono (`owner_user_id` nulo, ou dono-agente de IA) não
 * conta como "atribuído": é fila.
 *
 * ═══ Onde a regra roda ═══
 *
 * A MESMA função decide o push do servidor (`push.handler.ts`) e o aviso
 * dentro do app (rota `conversations/[id]/aviso-de-mensagem`, lida por
 * `useInboundMessageAlerts`). Grupos (`message.group_received`) e avisos da
 * Central NÃO passam por aqui — continuam indo para a organização inteira.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  corpoTemTexto,
  lerFiltroDePalavraChave,
} from "@/lib/agent-engine/agent/palavra-chave-do-gatilho";
import { agenteAtende, type FatosDoAgente } from "@/lib/ai/agents/no-ar";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";
import { resolverRoteamentoPorNumero } from "@/lib/routing/decide";
import { estaDePlantao } from "@/lib/routing/eligibility";
import { carregarRegraDoNumero } from "@/lib/routing/worker";
import { availabilityScheduleSchema, routingConfigSchema } from "@/lib/schemas/routing";

export type DestinatariosDaMensagem =
  | { tipo: "todos" }
  | { tipo: "restrito"; userIds: string[] }
  | { tipo: "ninguem" };

export interface FatosDaAtribuicao {
  /** `conversations.assigned_to_user_id`. */
  atribuidoA: string | null;
  /** `owner_user_id` de cada negócio ABERTO do contato (nulos permitidos). */
  donosDeNegocioAberto: ReadonlyArray<string | null>;
  /** user_ids dos administradores da organização com vínculo ativo. */
  admins: ReadonlyArray<string>;
  /** A IA está atendendo esta conversa (regra 2 do cabeçalho). */
  iaConduz?: boolean;
  /** Distribuição automática no canal (regra 3); `null`/ausente = modo manual. */
  filaDistribuida?: { dePlantao: ReadonlyArray<string>; gestores: ReadonlyArray<string> } | null;
}

/** Os responsáveis pela conversa, pela precedência do cabeçalho. Vazio = sem dono. */
export function responsaveisDaConversa(
  fatos: Pick<FatosDaAtribuicao, "atribuidoA" | "donosDeNegocioAberto">,
): string[] {
  if (fatos.atribuidoA) return [fatos.atribuidoA];
  const donos = fatos.donosDeNegocioAberto.filter((d): d is string => typeof d === "string" && d.length > 0);
  return [...new Set(donos)];
}

/** Decisão pura, na ordem do cabeçalho. */
export function destinatariosDaMensagem(fatos: FatosDaAtribuicao): DestinatariosDaMensagem {
  const responsaveis = responsaveisDaConversa(fatos);
  if (responsaveis.length > 0) {
    return { tipo: "restrito", userIds: [...new Set([...responsaveis, ...fatos.admins])] };
  }
  if (fatos.iaConduz) return { tipo: "ninguem" };
  const fila = fatos.filaDistribuida;
  // Lista de gestores vazia não deveria acontecer; se acontecer, a fila avisa
  // todos em vez de sumir.
  const alvo = fila ? (fila.dePlantao.length > 0 ? fila.dePlantao : fila.gestores) : [];
  if (alvo.length > 0) return { tipo: "restrito", userIds: [...new Set(alvo)] };
  return { tipo: "todos" };
}

/** Esta pessoa deve ser avisada? */
export function usuarioRecebeAviso(destinatarios: DestinatariosDaMensagem, userId: string): boolean {
  if (destinatarios.tipo === "ninguem") return false;
  return destinatarios.tipo === "todos" || destinatarios.userIds.includes(userId);
}

// ---------------------------------------------------------------------------
// Leitura dos fatos no banco
// ---------------------------------------------------------------------------

type Resultado<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;

/**
 * O pedaço do supabase-js que a leitura usa. Tipado à mão para o teste passar
 * um stub sem montar o client inteiro — mesmo recurso de `web_push.ts`.
 */
export interface LeitorDeAtribuicao {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
}

/**
 * Lê os fatos e decide. Quem chama passa um client que ENXERGA tudo da
 * organização (service role): a regra precisa do dono do negócio mesmo quando
 * a pessoa avisada não poderia abrir esse negócio — um `agent` no modo de
 * visibilidade padrão não vê lead de outro dono, e para ele "não vejo lead"
 * se confundiria com "não há lead". Por isso todo filtro de `organization_id`
 * aqui é explícito.
 *
 * `contactId` vem do evento quando o evento o tem; senão, da própria conversa.
 * Conversa inexistente na organização → `null` (quem chama decide o desfecho).
 * Erro de leitura LANÇA: quem chama escolhe entre avisar todos ou ninguém.
 */
export async function carregarDestinatariosDaMensagem(
  db: LeitorDeAtribuicao,
  organizationId: string,
  conversationId: string,
  contactId: string | null = null,
  agora: Date = new Date(),
): Promise<DestinatariosDaMensagem | null> {
  const conv = (await (db
    .from("conversations")
    .select("assigned_to_user_id, contact_id, is_group, status, bot_silenced_until, channel_session_id, service_started_at")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle() as Resultado<ConversaLida>));
  if (conv.error) throw new Error(conv.error.message);
  if (!conv.data) return null;
  // Grupo nunca é restrito: o aviso de grupo é da organização inteira.
  if (conv.data.is_group) return { tipo: "todos" };

  let donos: Array<string | null> = [];
  const contato = contactId ?? conv.data.contact_id;
  if (!conv.data.assigned_to_user_id && contato) {
    const leads = await (db
      .from("crm_leads")
      .select("owner_user_id")
      .eq("organization_id", organizationId)
      .eq("contact_id", contato)
      .eq("status", "open") as Resultado<Array<{ owner_user_id: string | null }>>);
    if (leads.error) throw new Error(leads.error.message);
    donos = (leads.data ?? []).map((l) => l.owner_user_id);
  }

  // Sem responsável: a IA, depois a fila. Os admins só são lidos quando há
  // responsável.
  if (responsaveisDaConversa({ atribuidoA: conv.data.assigned_to_user_id, donosDeNegocioAberto: donos }).length === 0) {
    if (await iaConduz(db, organizationId, conversationId, conv.data, contato, agora)) return { tipo: "ninguem" };
    return destinatariosDaMensagem({
      atribuidoA: null,
      donosDeNegocioAberto: [],
      admins: [],
      filaDistribuida: await filaDistribuida(db, organizationId, conv.data.channel_session_id, agora),
    });
  }
  const admins = await (db
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .is("revoked_at", null) as Resultado<Array<{ user_id: string }>>);
  if (admins.error) throw new Error(admins.error.message);

  return destinatariosDaMensagem({
    atribuidoA: conv.data.assigned_to_user_id,
    donosDeNegocioAberto: donos,
    admins: (admins.data ?? []).map((a) => a.user_id),
  });
}

interface ConversaLida {
  assigned_to_user_id: string | null;
  contact_id: string | null;
  is_group: boolean | null;
  status: string;
  bot_silenced_until: string | null;
  channel_session_id: string | null;
  /** Fronteira do atendimento corrente — a âncora do "já engajado" (#3240). */
  service_started_at?: string | null;
}

/**
 * A IA está atendendo? Lê só o necessário, parando assim que a resposta é
 * "não": primeiro os fatos da conversa, depois o contato, os agentes do
 * número e por último a elegibilidade. Leitura de agentes que falha NÃO conta
 * como IA atendendo — aqui isso calaria um aviso.
 */
async function iaConduz(
  db: LeitorDeAtribuicao,
  organizationId: string,
  conversationId: string,
  conv: ConversaLida,
  contato: string | null,
  agora: Date,
): Promise<boolean> {
  const fatos = {
    status: conv.status,
    assigned_to_user_id: conv.assigned_to_user_id,
    bot_silenced_until: conv.bot_silenced_until,
    is_group: conv.is_group,
    automaticoDaOrg: true,
  };
  if (comandoDaConversa(fatos, agora).comando.quem !== "automatico") return false;

  let contatoLido: { force_human: boolean | null; is_blocked: boolean | null } | null = null;
  if (contato) {
    const c = await (db
      .from("contacts")
      .select("force_human, is_blocked")
      .eq("id", contato)
      .eq("organization_id", organizationId)
      .maybeSingle() as Resultado<{ force_human: boolean | null; is_blocked: boolean | null }>);
    if (c.error) throw new Error(c.error.message);
    contatoLido = c.data;
  }
  const comContato = { ...fatos, force_human: contatoLido?.force_human, is_blocked: contatoLido?.is_blocked };
  if (comandoDaConversa(comContato, agora).comando.quem !== "automatico") return false;

  if (!(await iaAtendeNoNumero(db, organizationId, conversationId, conv.channel_session_id, conv.service_started_at ?? null))) return false;

  const elegib = await decidirElegibilidadeDaConversaViaSupabase(db as Pick<SupabaseClient, "from">, {
    organizationId,
    conversationId,
    agora,
    ttlMs: ttlDaAutorizacaoMs(process.env),
  });
  return elegib?.permite === true;
}

/**
 * Há agente AUTOMÁTICO no ar que o turno executaria neste número? Os
 * predicados de `haQuemAtendaASessao` (`lib/ai/agents/quem-atende-a-sessao.ts`),
 * mais `agenteAtende` (pausado não conta) e sem o modo assistido, cujo
 * rascunho espera uma pessoa. Sem número, ou leitura falhando → `false`.
 *
 * O FILTRO DE PALAVRAS é mais um predicado, porque é mais um predicado do
 * TURNO (`inbound-turn.ts`): a versão com `trigger_config.filters.keyword_regex`
 * que pula a última mensagem recebida encerra o turno sem resposta (#2696) —
 * e aí a IA NÃO vai atender, calar o aviso deixaria o cliente sem ninguém
 * (#3353). Duas exceções, na régua de `palavra-chave-do-gatilho.ts`:
 *
 *  - Mensagem sem TEXTO (`body` nulo, áudio ainda não transcrito): o dreno
 *    ADIA o turno até a transcrição (`drain.ts`, "Mídia ainda virando texto:
 *    ESPERAR") e o filtro julga o texto dela, que o aviso ainda não tem. O
 *    aviso decide no INSERT, antes: o agente com filtro não conta e o aviso
 *    segue a regra da fila. Se a transcrição casar, a IA responde e o aviso
 *    terá sido a mais — a direção da regra é "nunca a menos" (#3353).
 *  - Agente que JÁ RESPONDEU neste atendimento (a âncora do #3240, régua de
 *    `agente-ja-respondeu.ts`): com o filtro decidindo só a ENTRADA, o turno
 *    segue sem filtro e a IA responde a toda mensagem seguinte. Sem esta
 *    âncora o conserto avisaria o meio da conversa que a IA conduz — o barulho
 *    que o #3113 tirou.
 *
 * A mensagem só é lida quando alguma versão no ar tem filtro: quem não usa o
 * campo não paga a consulta, nem a da âncora.
 */
async function iaAtendeNoNumero(
  db: LeitorDeAtribuicao,
  organizationId: string,
  conversationId: string,
  channelSessionId: string | null,
  serviceStartedAt: string | null,
): Promise<boolean> {
  if (!channelSessionId) return false;
  const agentes = await (db
    .from("ai_agents")
    .select("id, kind, is_active, paused_at, published_version_id, archived_at, operation_mode")
    .eq("organization_id", organizationId)
    .is("archived_at", null) as Resultado<Array<FatosDoAgente & { id: string; operation_mode: string }>>);
  if (agentes.error) return false;
  const noAr = (agentes.data ?? []).filter((a) => agenteAtende(a) && a.operation_mode !== "assisted");
  if (noAr.length === 0) return false;

  const versoes = await (db
    .from("ai_agent_versions")
    .select("id, channel_session_id, trigger_config")
    .eq("organization_id", organizationId)
    .eq("status", "published")
    .in("id", noAr.map((a) => a.published_version_id)) as Resultado<Array<{ id: string; channel_session_id: string | null; trigger_config: unknown }>>);
  if (versoes.error) return false;
  const numeroDaVersao = new Map((versoes.data ?? []).map((v) => [v.id, v.channel_session_id]));
  const filtroDaVersao = new Map((versoes.data ?? []).map((v) => [v.id, lerFiltroDePalavraChave(v.trigger_config)]));
  const corpo = [...filtroDaVersao.values()].some((f) => f !== null)
    ? await corpoDaUltimaRecebida(db, organizationId, conversationId)
    : null;
  const executam: Array<FatosDoAgente & { id: string; operation_mode: string }> = [];
  for (const a of noAr) {
    const versao = a.published_version_id ?? "";
    if (!numeroDaVersao.has(versao)) continue;
    const filtro = filtroDaVersao.get(versao) ?? null;
    // Sem filtro preenchido (regex torta ou campo vazio vira `null`), o
    // agente entra em tudo, como antes. Com texto que casa, o filtro aceita.
    if (filtro === null || (typeof corpo === "string" && corpoTemTexto(corpo) && filtro.test(corpo))) {
      executam.push(a);
      continue;
    }
    // O filtro pulou: a IA só continua respondendo se este agente já falou
    // neste atendimento — a mesma âncora do portão do turno (#3240).
    if (await agenteJaRespondeuNoAtendimento(db, organizationId, conversationId, a.id, serviceStartedAt)) {
      executam.push(a);
    }
  }
  if (executam.some((a) => numeroDaVersao.get(a.published_version_id ?? "") === channelSessionId)) return true;
  if (executam.length === 0) return false;
  const idsQueExecutam = new Set(executam.map((a) => a.id));

  const roteadores = await (db
    .from("ai_routers")
    .select("id, fallback_agent_id")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .eq("is_active", true) as Resultado<Array<{ id: string; fallback_agent_id: string | null }>>);
  if (roteadores.error || !roteadores.data?.length) return false;
  if (roteadores.data.some((r) => r.fallback_agent_id != null && idsQueExecutam.has(r.fallback_agent_id))) return true;

  const membros = await (db
    .from("ai_router_members")
    .select("agent_id")
    .eq("organization_id", organizationId)
    .in("router_id", roteadores.data.map((r) => r.id)) as Resultado<Array<{ agent_id: string }>>);
  return !membros.error && (membros.data ?? []).some((m) => idsQueExecutam.has(m.agent_id));
}

/**
 * O corpo da última mensagem recebida na conversa (por `sent_at`, a mesma
 * ordem do contexto do turno, `get-lead-context.ts`): em geral, a que o aviso
 * anuncia. `null` = sem texto (mídia sem legenda) ou sem mensagem;
 * `undefined` = a leitura falhou — nos dois casos o agente com filtro não
 * conta, e o aviso segue a regra da fila.
 */
async function corpoDaUltimaRecebida(
  db: LeitorDeAtribuicao,
  organizationId: string,
  conversationId: string,
): Promise<string | null | undefined> {
  const m = await (db
    .from("messages")
    .select("body")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle() as Resultado<{ body: string | null }>);
  if (m.error) return undefined;
  return m.data?.body ?? null;
}

/**
 * O agente já enviou algo neste atendimento? A MESMA régua da âncora do
 * portão do turno (`lib/agent-engine/agent/agente-ja-respondeu.ts`, em SQL
 * puro para o worker de pg): outbound com `sent_via='ai'`, autoria gravada em
 * `metadata->>'ai_actor_id'`, envio que não falhou e dentro da fronteira do
 * atendimento corrente (`service_started_at` nulo conta como dentro).
 *
 * Aqui em supabase-js porque a regra só recebe o `LeitorDeAtribuicao` — o
 * turno usa pool de pg direto. Leitura falhando → `false`: não inventa
 * engajamento (nunca cala o aviso por conta de uma consulta quebrada).
 */
async function agenteJaRespondeuNoAtendimento(
  db: LeitorDeAtribuicao,
  organizationId: string,
  conversationId: string,
  agentId: string,
  serviceStartedAt: string | null,
): Promise<boolean> {
  const base = db
    .from("messages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .eq("sent_via", "ai")
    .eq("metadata->>ai_actor_id", agentId)
    .neq("status", "failed");
  const q = serviceStartedAt ? base.gte("sent_at", serviceStartedAt) : base;
  const r = await (q.limit(1).maybeSingle() as Resultado<{ id: string }>);
  if (r.error) return false;
  return r.data != null;
}

/**
 * Com distribuição automática no canal, quem está de plantão e quem gere;
 * no modo manual, `null`. Mesmas fontes do roteador: `settings.routing`, a
 * regra do número, os responsáveis do canal, `attendant_availability` e os
 * vínculos ativos com papel `agent`/`manager`/`admin`.
 */
async function filaDistribuida(
  db: LeitorDeAtribuicao,
  organizationId: string,
  channelSessionId: string | null,
  agora: Date,
): Promise<{ dePlantao: string[]; gestores: string[] } | null> {
  const org = await (db
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle() as Resultado<{ settings: unknown }>);
  if (org.error) throw new Error(org.error.message);
  const settings = (org.data?.settings ?? {}) as { routing?: unknown };
  const regra = await carregarRegraDoNumero(db as Pick<SupabaseClient, "from">, organizationId, channelSessionId);
  const { mode } = resolverRoteamentoPorNumero(routingConfigSchema.parse(settings.routing ?? {}), regra);
  if (mode !== "round_robin" && mode !== "load") return null;

  const permitidos = await responsaveisDoCanal(db, organizationId, channelSessionId);
  const membros = await (db
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .in("role", ["agent", "manager", "admin"]) as Resultado<Array<{ user_id: string; role: string }>>);
  if (membros.error) throw new Error(membros.error.message);
  const ativos = new Set((membros.data ?? []).map((m) => m.user_id));
  const gestores = (membros.data ?? []).filter((m) => m.role === "manager" || m.role === "admin").map((m) => m.user_id);

  const disponiveis = await (db
    .from("attendant_availability")
    .select("user_id, schedule")
    .eq("organization_id", organizationId)
    .eq("is_available", true) as Resultado<Array<{ user_id: string; schedule: unknown }>>);
  if (disponiveis.error) throw new Error(disponiveis.error.message);
  const dePlantao = (disponiveis.data ?? [])
    .filter((d) => ativos.has(d.user_id) && (permitidos === null || permitidos.has(d.user_id)))
    .filter((d) =>
      estaDePlantao({ isAvailable: true, schedule: availabilityScheduleSchema.parse(d.schedule ?? {}) }, agora),
    )
    .map((d) => d.user_id);
  return { dePlantao, gestores };
}

/** Responsáveis do canal (`channel_routing_responsibles`); `null` = canal sem lista própria. */
async function responsaveisDoCanal(
  db: LeitorDeAtribuicao,
  organizationId: string,
  channelSessionId: string | null,
): Promise<Set<string> | null> {
  if (!channelSessionId) return null;
  const policy = await (db
    .from("channel_routing_policies")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .maybeSingle() as Resultado<{ id: string }>);
  if (policy.error) throw new Error(policy.error.message);
  if (!policy.data) return null;
  const resp = await (db
    .from("channel_routing_responsibles")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("policy_id", policy.data.id) as Resultado<Array<{ user_id: string }>>);
  if (resp.error) throw new Error(resp.error.message);
  return new Set((resp.data ?? []).map((r) => r.user_id));
}
