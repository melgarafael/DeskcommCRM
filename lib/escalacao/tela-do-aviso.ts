/**
 * O QUE A TELA DE "AVISO NO WHATSAPP" LÊ — a coleta, num lugar só.
 *
 * ## Por que fora da rota
 *
 * São nove leituras para responder a uma pergunta ("por que o aviso não vai
 * sair?"), e elas vêm de dois clients diferentes. Dentro do handler isso vira
 * duzentas linhas de `select` entre a autorização e a resposta, e a próxima
 * pessoa que precisar de um dos fatos escreve o décimo `select`. Aqui há um
 * dono: a rota autoriza e responde, este módulo lê.
 *
 * ## Os dois clients, e a regra de cada um
 *
 * `db` é o client de SESSÃO: a RLS é quem decide o que sai
 * (`config_aviso_de_caso` é `admin`, `entregas_de_aviso_de_caso` é `manager`).
 * `admin` é o de service role e **BYPASSA a RLS** — toda consulta que passa por
 * ele filtra `organization_id` À MÃO, e o valor vem da sessão resolvida pela
 * rota, **nunca do corpo** (anti-pattern 10).
 *
 * Ele é necessário em três lugares onde a sessão não alcança: `pacing_ledger` e
 * `channel_knobs` (tabelas do motor, sem leitura para papel de tenant) e o laço
 * de retorno, que agrega casos e eventos de toda a organização — um recorte por
 * atendente ali produziria um número que muda conforme quem abre a tela.
 *
 * ## Nenhuma leitura derruba a tela
 *
 * Cada bloco falha para `null` — que a regra lê como *não deu para medir* e não
 * como *é falso*. Uma tela de configuração que devolve 500 porque o ledger não
 * respondeu tira da pessoa também o que estava funcionando: o número, a
 * conexão e o switch.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { knobsDoCanal } from "@/lib/automation/janela-do-canal";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { lerEstadoDoPacing } from "@/lib/agent-engine/pacing/ledger-supabase";
import { warmupCapFor } from "@/lib/agent-engine/pacing/engine";
import { logger } from "@/lib/logger";

import { mascara } from "./aviso-ao-suporte";
import {
  avisosDaTela,
  podeLigarOAviso,
  type AgentesPublicados,
  type AvisoDaTela,
  type ConexaoParaAviso,
  type ConfiguracaoNaTela,
  type FatosDaTelaDeAviso,
} from "./estado-do-aviso";
import { medirLacoDoAviso, type CasoParaOLaco, type LacoDoAviso } from "./laco-do-aviso";
import { urlPublicaUsavel } from "./url-publica";

/** Uma entrega, como a tela a mostra. O destino sai MASCARADO — ver abaixo. */
export interface EntregaNaTela {
  id: string;
  case_id: string;
  /** Só os quatro últimos dígitos: quem lê a lista pode ser `manager`, e o
   *  telefone do plantão não é assunto de quem só quer saber se o aviso saiu. */
  destino_mascarado: string;
  status: string;
  erro_codigo: string | null;
  tentativas: number;
  /** NULL junto com reminder_minute identifica a abertura do caso. */
  wait_generation: number | string | null;
  /** NULL junto com wait_generation identifica a abertura; reforços usam a cadência configurada. */
  reminder_minute: number | null;
  enviado_em: string | null;
  created_at: string;
}

export interface ConfigNaResposta {
  channel_session_id: string | null;
  telefone: string;
  rotulo: string | null;
  ligado: boolean;
  sem_link?: boolean;
  repetir_lembretes_whatsapp: boolean;
  minutos_lembrete_equipe: number[];
  atualizado_em: string;
}

export interface EstadoDaTelaDeAviso {
  config: ConfigNaResposta | null;
  conexoes: ConexaoParaAviso[];
  avisos: AvisoDaTela[];
  pode_ligar: boolean;
  entregas: EntregaNaTela[];
  laco: LacoDoAviso;
}

/** Quantas entregas a lista mostra. Vinte responde "está saindo?" sem paginar. */
const ENTREGAS_NA_LISTA = 20;
/** A janela do laço de retorno. */
const DIAS_DO_LACO = 30;
/** Teto de casos lidos para o laço — a tela não é um relatório. */
const CASOS_DO_LACO = 100;

interface LinhaDeConfig {
  channel_session_id: string | null;
  telefone_destino: string;
  rotulo: string | null;
  ligado: boolean;
  sem_link?: boolean;
  repetir_lembretes_whatsapp?: boolean | null;
  minutos_lembrete_equipe?: number[] | null;
  mensagens_ignoradas: number;
  ultima_mensagem_ignorada_em: string | null;
  updated_at: string;
}

export async function lerEstadoDaTelaDeAviso(entrada: {
  db: SupabaseClient;
  admin: SupabaseClient;
  organizationId: string;
  /** `env.NEXT_PUBLIC_APP_URL` já lido pela rota. */
  urlPublica: string;
  agora?: Date;
}): Promise<EstadoDaTelaDeAviso> {
  const { db, admin, organizationId: orgId } = entrada;
  const agora = entrada.agora ?? new Date();

  const [config, conexoes, agentes, atendimentoExterno, entregas] = await Promise.all([
    lerConfig(db, orgId),
    lerConexoes(db, orgId),
    contarAgentesPublicados(db, orgId),
    ehAtendimentoExterno(db, orgId),
    lerEntregas(db, orgId),
  ]);

  const canalEscolhido = config?.channel_session_id ?? null;
  const [aquecimento, laco] = await Promise.all([
    canalEscolhido ? lerAquecimento(admin, orgId, canalEscolhido, agora) : Promise.resolve(null),
    lerLaco(admin, orgId, agora),
  ]);

  const configNaTela: ConfiguracaoNaTela | null = config
    ? {
        channelSessionId: config.channel_session_id,
        telefone: config.telefone_destino,
        rotulo: config.rotulo,
        ligado: config.ligado,
        sem_link: config.sem_link ?? false,
      }
    : null;

  const fatos: FatosDaTelaDeAviso = {
    conexoes,
    config: configNaTela,
    urlPublicaOk: urlPublicaUsavel(entrada.urlPublica),
    agentesPublicados: agentes,
    atendimentoExterno,
    descarte: {
      ignoradas: config?.mensagens_ignoradas ?? 0,
      ultimaEm: config?.ultima_mensagem_ignorada_em ?? null,
    },
    aquecimento,
    agora,
  };

  return {
    config: config
      ? {
          channel_session_id: config.channel_session_id,
          // O número INTEIRO volta aqui, e só aqui: é o campo que a pessoa está
          // editando, e mascará-lo faria a tela reenviar `••••6398` ao salvar.
          // A leitura desta tabela é `admin` na RLS.
          telefone: config.telefone_destino,
          rotulo: config.rotulo,
          ligado: config.ligado,
          sem_link: config.sem_link ?? false,
          repetir_lembretes_whatsapp: config.repetir_lembretes_whatsapp ?? false,
          minutos_lembrete_equipe: config.minutos_lembrete_equipe ?? [3, 6, 9],
          atualizado_em: config.updated_at,
        }
      : null,
    conexoes,
    avisos: avisosDaTela(fatos),
    pode_ligar: podeLigarOAviso(fatos),
    entregas,
    laco,
  };
}

async function lerConfig(db: SupabaseClient, orgId: string): Promise<LinhaDeConfig | null> {
  const { data, error } = await db
    .from("config_aviso_de_caso")
    .select(
      "channel_session_id, telefone_destino, rotulo, ligado, sem_link, repetir_lembretes_whatsapp, minutos_lembrete_equipe, mensagens_ignoradas, ultima_mensagem_ignorada_em, updated_at",
    )
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) {
    // Falha ABERTA na informação: sem a configuração a tela mostra o formulário
    // vazio, que é o estado de quem nunca configurou — e é o que ela faria
    // também se a linha realmente não existisse. O log é quem distingue.
    logger.warn("[aviso-de-caso] configuração não lida", {
      organizationId: orgId,
      causa: error.message,
    });
    return null;
  }
  // `minutos_lembrete_equipe` só existe após a migration de cadência. O schema
  // gerado é atualizado no fluxo de banco; esta leitura mantém o contrato local
  // estreito até lá, sem editar o arquivo gerado à mão.
  return (data as unknown as LinhaDeConfig | null) ?? null;
}

/**
 * As conexões oferecíveis, com a resposta para "este número já fala com
 * cliente?".
 *
 * Duas fontes, porque são dois jeitos de um número atender: a versão publicada
 * de um agente (`ai_agent_versions.channel_session_id`) e um roteador ativo
 * (`ai_routers.channel_session_id`). Ficar só na primeira deixaria de fora
 * exatamente a instalação que cresceu — quem tem roteador tem mais de um agente.
 */
async function lerConexoes(db: SupabaseClient, orgId: string): Promise<ConexaoParaAviso[]> {
  const canais = await listSelectableChannels(db, orgId);

  const emUso = new Set<string>();
  const [versoes, roteadores] = await Promise.all([
    db
      .from("ai_agent_versions")
      .select("channel_session_id")
      .eq("organization_id", orgId)
      .eq("status", "published")
      .not("channel_session_id", "is", null),
    db
      .from("ai_routers")
      .select("channel_session_id")
      .eq("organization_id", orgId)
      .eq("is_active", true),
  ]);
  for (const fonte of [versoes, roteadores]) {
    if (fonte.error) {
      // Não saber se o número atende clientes vira ALERTA AUSENTE, nunca alerta
      // inventado: dizer "este é o número dos seus clientes" sobre um número
      // dedicado assustaria quem fez tudo certo.
      logger.warn("[aviso-de-caso] uso do canal não medido", {
        organizationId: orgId,
        causa: fonte.error.message,
      });
      continue;
    }
    for (const linha of (fonte.data ?? []) as Array<{ channel_session_id: string | null }>) {
      if (linha.channel_session_id) emUso.add(linha.channel_session_id);
    }
  }

  return canais.map((c) => ({
    id: c.id,
    nome: c.display_name,
    status: c.status,
    aceitaMensagemLivre: c.aceitaMensagemLivre,
    atendeClientes: emUso.has(c.id),
  }));
}

/**
 * Quantos agentes estão NO AR, e o que eles fazem.
 *
 * "No ar" é a versão publicada de um agente que não está arquivado nem pausado
 * — a mesma definição de `estadoDoAgente` (`lib/ai/agents/no-ar.ts`). Contar
 * versões publicadas de agentes pausados diria "há dois agentes abrindo casos"
 * sobre uma organização que pausou os dois.
 */
async function contarAgentesPublicados(
  db: SupabaseClient,
  orgId: string,
): Promise<AgentesPublicados | null> {
  const { data, error } = await db
    .from("ai_agents")
    .select("id, operation_mode, paused_at, archived_at, published_version_id")
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .is("paused_at", null)
    .not("published_version_id", "is", null);
  if (error) {
    logger.warn("[aviso-de-caso] agentes não contados", {
      organizationId: orgId,
      causa: error.message,
    });
    return null;
  }
  const linhas = (data ?? []) as Array<{
    id: string;
    operation_mode: string | null;
    published_version_id: string | null;
  }>;
  if (linhas.length === 0) return { total: 0, comCasos: 0, assistidos: 0 };

  const versoes = await db
    .from("ai_agent_versions")
    .select("id, cases_enabled")
    .eq("organization_id", orgId)
    .in(
      "id",
      linhas.map((l) => l.published_version_id).filter((v): v is string => Boolean(v)),
    );
  if (versoes.error) {
    logger.warn("[aviso-de-caso] versões publicadas não lidas", {
      organizationId: orgId,
      causa: versoes.error.message,
    });
    return null;
  }
  const comCasos = new Set(
    ((versoes.data ?? []) as Array<{ id: string; cases_enabled: boolean }>)
      .filter((v) => v.cases_enabled)
      .map((v) => v.id),
  );

  return {
    total: linhas.length,
    comCasos: linhas.filter((l) => l.published_version_id && comCasos.has(l.published_version_id))
      .length,
    assistidos: linhas.filter((l) => l.operation_mode === "assisted").length,
  };
}

async function ehAtendimentoExterno(db: SupabaseClient, orgId: string): Promise<boolean> {
  const { data, error } = await db
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  // Falha ABERTA: `false` é o default do produto (`aiDispatchModeSchema.catch`),
  // e afirmar "seu atendimento é externo" sem ter lido mandaria a pessoa
  // procurar um sistema que ela não usa.
  if (error || !data) return false;
  const settings = (data as { settings?: Record<string, unknown> | null }).settings ?? {};
  return settings.ai_dispatch_mode === "external";
}

async function lerEntregas(db: SupabaseClient, orgId: string): Promise<EntregaNaTela[]> {
  const { data, error } = await db
    .from("entregas_de_aviso_de_caso")
    .select(
      "id, case_id, destino, status, erro_codigo, tentativas, wait_generation, reminder_minute, enviado_em, created_at",
    )
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(ENTREGAS_NA_LISTA);
  if (error) {
    logger.warn("[aviso-de-caso] histórico de entregas não lido", {
      organizationId: orgId,
      causa: error.message,
    });
    return [];
  }
  return (
    (data ?? []) as Array<Omit<EntregaNaTela, "destino_mascarado"> & { destino: string }>
  ).map(({ destino, ...resto }) => ({ ...resto, destino_mascarado: mascara(destino) }));
}

/**
 * O teto de hoje do número que ENVIA os avisos (C2 da revisão).
 *
 * A composição que esta leitura existe para tornar visível: um número recém
 * pareado tem cap 20/dia; o 21º aviso vira `retry`, passa das 24 h e morre como
 * `expirou`. Sem o número na tela, o motivo real — aquecimento — não é dito em
 * lugar nenhum, e quem investiga procura defeito onde há regra.
 */
async function lerAquecimento(
  admin: SupabaseClient,
  orgId: string,
  channelSessionId: string,
  agora: Date,
): Promise<FatosDaTelaDeAviso["aquecimento"]> {
  try {
    const knobs = await knobsDoCanal(admin, orgId, channelSessionId);
    const estado = await lerEstadoDoPacing(admin, orgId, channelSessionId, {
      agora,
      timezone: knobs.timezone,
    });
    const idadeDias = estado.numberActivatedAt
      ? Math.max(0, (agora.getTime() - estado.numberActivatedAt.getTime()) / 86_400_000)
      : 0;
    const teto = warmupCapFor(idadeDias, knobs.warmupDailyCaps);

    // O fim do aquecimento é o primeiro degrau SEM teto — derivado da tabela de
    // knobs, nunca do número 31 escrito à mão: quem edita `warmup_daily_caps`
    // de um canal muda a resposta, e uma constante aqui mentiria para ele.
    const semTeto = [...knobs.warmupDailyCaps]
      .sort((a, b) => a.minAgeDays - b.minAgeDays)
      .find((passo) => passo.cap === null);
    const fimEm =
      estado.numberActivatedAt && semTeto
        ? new Date(
            estado.numberActivatedAt.getTime() + semTeto.minAgeDays * 86_400_000,
          ).toISOString()
        : null;

    return { enviadosHoje: estado.sentToday, teto, fimEm };
  } catch (err) {
    logger.warn("[aviso-de-caso] aquecimento do número não medido", {
      organizationId: orgId,
      channelSessionId,
      causa: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** O laço de retorno: casos avisados × casos não avisados, mesma organização. */
async function lerLaco(admin: SupabaseClient, orgId: string, agora: Date): Promise<LacoDoAviso> {
  const vazio = medirLacoDoAviso([]);
  const desde = new Date(agora.getTime() - DIAS_DO_LACO * 86_400_000).toISOString();

  // ⚠️ `organization_id` filtrado À MÃO nas três: o client BYPASSA a RLS, e a
  // organização vem da sessão resolvida pela rota.
  const casos = await admin
    .from("agent_cases")
    .select("id, opened_at")
    .eq("organization_id", orgId)
    .gte("opened_at", desde)
    .order("opened_at", { ascending: false })
    .limit(CASOS_DO_LACO);
  if (casos.error) {
    logger.warn("[aviso-de-caso] laço de retorno não medido", {
      organizationId: orgId,
      causa: casos.error.message,
    });
    return vazio;
  }
  const linhas = (casos.data ?? []) as Array<{ id: string; opened_at: string }>;
  if (linhas.length === 0) return vazio;
  const ids = linhas.map((c) => c.id);

  const [entregas, eventos] = await Promise.all([
    admin
      .from("entregas_de_aviso_de_caso")
      .select("case_id, enviado_em")
      .eq("organization_id", orgId)
      .eq("status", "enviado")
      .in("case_id", ids),
    admin
      .from("agent_case_events")
      .select("case_id, created_at")
      .eq("organization_id", orgId)
      .eq("actor_kind", "user")
      .in("case_id", ids)
      .order("created_at", { ascending: true }),
  ]);
  if (entregas.error || eventos.error) {
    logger.warn("[aviso-de-caso] laço de retorno incompleto", {
      organizationId: orgId,
      causa: (entregas.error ?? eventos.error)?.message,
    });
    return vazio;
  }

  const saiuEm = new Map<string, string>();
  for (const e of (entregas.data ?? []) as Array<{ case_id: string; enviado_em: string | null }>) {
    if (e.enviado_em) saiuEm.set(e.case_id, e.enviado_em);
  }
  // A consulta já vem ordenada crescente: o PRIMEIRO que aparece por caso é a
  // primeira ação humana, e o `has` impede que o segundo a sobrescreva.
  const primeiraAcao = new Map<string, string>();
  for (const e of (eventos.data ?? []) as Array<{ case_id: string; created_at: string }>) {
    if (!primeiraAcao.has(e.case_id)) primeiraAcao.set(e.case_id, e.created_at);
  }

  const amostra: CasoParaOLaco[] = linhas.map((c) => ({
    caseId: c.id,
    abertoEm: c.opened_at,
    avisoSaiuEm: saiuEm.get(c.id) ?? null,
    primeiraAcaoHumanaEm: primeiraAcao.get(c.id) ?? null,
  }));
  return medirLacoDoAviso(amostra);
}
