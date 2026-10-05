/**
 * GET/POST /api/v1/ai/cases/:id/chat — a consulta interna da equipe à IA que
 * ABRIU o caso (migration 0281).
 *
 * ## A guarda de visibilidade, que é a razão de esta rota existir com cuidado
 *
 * As rotas de caso usam cliente privilegiado filtrando só `organization_id`,
 * enquanto conversas e mensagens têm RLS por atendente. Este chat AMPLIA o que
 * um `agent` enxerga de "resumo + nome + telefone" para "a conversa inteira,
 * em prosa". Então, ANTES de qualquer leitura privilegiada, o conjunto de
 * conversas visíveis é resolvido pelo cliente de SESSÃO — quem responde é a
 * RLS, não uma regra reescrita em TypeScript. Conjunto vazio ⇒ **404**, nunca
 * 403: um 403 confirmaria que o caso existe.
 *
 * O recorte é `conversasVisiveisDosCasos` (a função da onda anterior), e não uma
 * consulta nova: UM dono para a regra. Duas implementações do mesmo recorte
 * divergiriam no dia em que `visibility_mode` mudasse.
 *
 * ## A idempotência do POST é o `turn_id`, e NÃO `comIdempotencia`
 *
 * `lib/api/idempotency.ts` grava `response_body` — uma cópia da resposta sobre
 * uma pessoa identificável, numa tabela FORA da cascata de LGPD e sem expurgo
 * nenhum (`grep -rn "idempotency_keys" app/api/v1/cron lib/retencao lib/lgpd` →
 * vazio). A unique `(organization_id, case_id, turn_id, author_kind)` resolve o
 * clique duplo E a corrida que o próprio helper declara não cobrir, sem criar
 * uma segunda cópia do texto num lugar que ninguém apaga.
 *
 * ## i18n
 *
 * `PASTAS_IGNORADAS` do gate de espanhol inclui `api`, então as frases desta
 * rota NÃO são cobradas por catraca nenhuma. Elas entram no dicionário por
 * DISCIPLINA, e esta frase existe para que a próxima pessoa saiba que a
 * ausência aqui não é aprovação — é ausência de gate.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { responderSobreOCaso } from "@/lib/agent-engine/agent/conversa-do-caso";
import {
  montarBlocoDeDados,
  montarSystem,
  PERSONA_NEUTRA,
} from "@/lib/agent-engine/agent/conversa-do-caso/contexto";
import {
  falasDoSnapshot,
  lerCaso,
  lerConversaDoCaso,
  lerDecisoesDaEquipe,
  lerEventosDoCaso,
  lerMemoriaDoAtendimento,
} from "@/lib/agent-engine/agent/conversa-do-caso/leitura";
import {
  leitorNoPool,
  resolverPersona,
  type PersonaDaConversa,
} from "@/lib/agent-engine/agent/conversa-do-caso/persona";
import { fusoDaOrganizacao } from "@/lib/agent-engine/agent/fuso-da-org";
import { loadOrgMemory, renderOrgMemory } from "@/lib/agent-engine/agent/org-memory";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import {
  LIMIAR_PADRAO_BUSCA,
  buscarConhecimento,
  resolverAcervoDoAgente,
  type TrechoEncontrado,
} from "@/lib/ai/knowledge/busca";
import type { Citation } from "@/lib/ai/citations/types";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { parseServiceBoundary, assertCurrentServiceBoundary } from "@/lib/atendimento/fronteira";
import { readCurrentServiceBoundary } from "@/lib/atendimento/fronteira-server";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { motivoDaConversaDoCaso } from "@/lib/ai/conversa-do-caso/motivo";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { conversasVisiveisDosCasos } from "@/lib/escalacao/chamados";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = {
  params: Promise<{ id: string }>;
  /** Seam de teste (F3): injeta os resolvedores do acervo sem depender do mock de módulo. */
  citacoes?: { resolverAcervo?: typeof resolverAcervoDoAgente; buscar?: typeof buscarConhecimento };
};

/** Teto por PESSOA. Cada pergunta é uma chamada paga — o custo é externo. */
const TETO_POR_USUARIO = 12;
/**
 * Teto por ORGANIZAÇÃO, e ele não é zelo: "12 por pessoa" com 20 pessoas é 240
 * chamadas por minuto na chave do self-hoster. É a única coisa entre o chat e o
 * teto de orçamento que CALA o agente que fala com o cliente.
 */
const TETO_POR_ORGANIZACAO = 60;
const JANELA_SEGUNDOS = 60;
/**
 * Teto por CASO, contado no BANCO — o único que sobrevive a múltiplos processos
 * e à ausência de Redis. Sem Redis, `checkRateLimit` conta em memória, POR
 * PROCESSO: com duas réplicas do contêiner, o teto real dobra.
 */
const TETO_POR_CASO_EM_24H = 120;

const MAX_MENSAGENS = 200;

const corpoDoPost = z
  .object({
    turn_id: z.string().uuid(),
    // O teto de 1000 é limite de CUSTO, não de estilo: é uma pergunta, não um
    // documento. O piso de 3 barra o clique acidental que gastaria uma chamada.
    pergunta: z.string().trim().min(3).max(1000),
  })
  .strict();

const consultaDoGet = z.object({ antes: z.string().datetime().optional() }).strict();

const COLUNAS_DO_CHAT =
  "id, turn_id, author_kind, author_user_id, body, error_code, agent_id, service_stale, redacted_at, created_at";

interface ContextoDaRota {
  requestId: string;
  orgId: string;
  userId: string;
  t: (texto: string) => string;
  caseId: string;
  db: Awaited<ReturnType<typeof createClient>>;
}

/**
 * Autenticação + guarda de visibilidade, comum ao GET e ao POST.
 *
 * Devolve `{ response }` quando algo barrou — o chamador repassa, e não inventa
 * uma segunda frase para a mesma recusa.
 */
async function contexto(ctx: Ctx, requestId: string): Promise<{ response: Response } | ContextoDaRota> {
  const authz = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!authz.ok) return { response: authz.response };
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: caseId } = await ctx.params;

  const db = await createClient();
  let visiveis: string[];
  try {
    visiveis = await conversasVisiveisDosCasos(db, authz.org.orgId, { caseId });
  } catch (erro) {
    // Falha de leitura do recorte é falha FECHADA na ação: sem saber o que a
    // pessoa pode ver, a resposta não é "mostre tudo".
    logger.error("[conversa-do-caso] não consegui resolver a visibilidade", {
      requestId,
      organizationId: authz.org.orgId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return {
      response: fail("unavailable", t("Não deu para abrir a conversa do caso agora."), 503, {
        requestId,
      }),
    };
  }
  // Conjunto vazio cobre os TRÊS casos de uma vez, e de propósito: o caso não
  // existe, é de outra organização, ou a conversa dele é invisível para quem
  // pediu. Distinguir seria confirmar a existência de um caso que a pessoa não
  // pode ver.
  if (visiveis.length === 0) {
    return { response: fail("not_found", t("Caso não encontrado."), 404, { requestId }) };
  }

  return { requestId, orgId: authz.org.orgId, userId: authz.user.id, t, caseId, db };
}

/** A persona de AGORA, recalculada a cada requisição (a coluna é histórico). */
async function personaDeAgora(
  pool: ReturnType<typeof getRequestPool>,
  orgId: string,
  agentId: string | null,
): Promise<PersonaDaConversa> {
  return resolverPersona(leitorNoPool(pool, orgId), agentId);
}

function personaParaTela(p: PersonaDaConversa): { fonte: string; nome: string | null; motivo: string | null } {
  return p.fonte === "agente_do_caso"
    ? { fonte: p.fonte, nome: p.nome, motivo: null }
    : { fonte: p.fonte, nome: null, motivo: p.motivo };
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const c = await contexto(ctx, requestId);
  if ("response" in c) return c.response;

  const consulta = consultaDoGet.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!consulta.success) {
    return fail("validation_failed", c.t("Filtro inválido."), 422, {
      requestId,
      details: consulta.error.flatten(),
    });
  }

  // Pelo cliente de SESSÃO: a RLS trabalha de novo (defesa em profundidade) e,
  // principalmente, a policy da tabela deixa de ser decorativa.
  let leitura = c.db
    .from("agent_case_chat_messages")
    .select(COLUNAS_DO_CHAT)
    .eq("organization_id", c.orgId)
    .eq("case_id", c.caseId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_MENSAGENS);
  if (consulta.data.antes) leitura = leitura.lt("created_at", consulta.data.antes);
  const { data: mensagens, error } = await leitura;
  if (error) {
    return fail("unavailable", c.t("Não deu para abrir a conversa do caso agora."), 503, {
      requestId,
    });
  }

  // ─── Degradação HONESTA do pool ────────────────────────────────────────
  //
  // `caso_obsoleto` e a persona precisam de `pg.Pool`. Se ele falhar — banco
  // reiniciando, limite de conexões, rede —, o GET NÃO vira 503: devolve as
  // mensagens e `caso_obsoleto: null` (desconhecido), e a tela diz que não deu
  // para conferir se o atendimento mudou. Falhar FECHADO na ação, ABERTO na
  // informação. (A causa citada aqui não é "sem SUPABASE_DB_URL": essa variável
  // é obrigatória, e um comentário que descreve um cenário impossível ensina o
  // próximo a procurar no lugar errado.)
  let estado: Record<string, unknown> = {
    caso_obsoleto: null,
    contato_bloqueado: null,
    contato_anonimizado: null,
    status: null,
    ia_configurada: null,
  };
  let persona: { fonte: string; nome: string | null; motivo: string | null } | null = null;
  try {
    const pool = getRequestPool();
    const caso = await lerCaso(pool, c.orgId, c.caseId);
    if (caso !== null) {
      persona = personaParaTela(await personaDeAgora(pool, c.orgId, caso.agent_id));
      const { rows: contato } = await pool.query<{ is_blocked: boolean; is_anonymized: boolean }>(
        `select is_blocked, is_anonymized from contacts where organization_id = $1 and id = $2`,
        [c.orgId, caso.contact_id],
      );
      const cfg = requestTurnDeps().llmCfg;
      estado = {
        caso_obsoleto: await casoEstaObsoleto(pool, c.orgId, caso.context_snapshot),
        contato_bloqueado: contato[0]?.is_blocked ?? null,
        contato_anonimizado: contato[0]?.is_anonymized ?? null,
        status: caso.status,
        // Sem chave de IA a tela não oferece o clique: numa instalação fresca,
        // um botão que sempre falha é pior que um botão ausente com a frase que
        // diz onde configurar.
        ia_configurada: Boolean(cfg.anthropicApiKey || cfg.openaiApiKey || cfg.openrouterApiKey),
      };
    }
  } catch (erro) {
    logger.warn("[conversa-do-caso] estado do caso indisponível — o GET segue", {
      requestId,
      organizationId: c.orgId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
  }

  return ok({ mensagens: mensagens ?? [], persona, estado }, { requestId });
}

/** `true`/`false` quando dá para saber; `null` quando não dá. */
async function casoEstaObsoleto(
  pool: ReturnType<typeof getRequestPool>,
  orgId: string,
  snapshot: Record<string, unknown> | null,
): Promise<boolean | null> {
  const fronteira = parseServiceBoundary(snapshot?.service_boundary);
  if (fronteira === null) return null;
  try {
    assertCurrentServiceBoundary(
      fronteira,
      await readCurrentServiceBoundary(pool, orgId, fronteira.conversation_id),
    );
    return false;
  } catch {
    // `StaleServiceBoundaryError` NÃO derruba o chat — vira bandeira. O
    // atendimento mudou; a conversa continua valendo como leitura.
    return true;
  }
}

/** Quantos trechos do acervo a tela pode mostrar — mesmo teto da F1 (#1869). */
const QUANTIDADE_DE_CITACOES = 6;

/**
 * Parte da F3 da #1869: consulta o acervo e devolve os trechos ligados à
 * PERGUNTA. Eles NÃO entram no prompt — a busca roda depois de
 * `responderSobreOCaso` —, então não sustentam a resposta e a tela não pode
 * dizer que sustentam. Ancorar a resposta neles é o passo seguinte da #1869.
 *
 * Espelha o padrão que a F1 já fixou (`app/api/v1/ai/knowledge/busca`): o MESMO
 * `resolverAcervoDoAgente` + `buscarConhecimento` + `LIMIAR_PADRAO_BUSCA`. Não
 * existe segunda régua — o operador perguntando ao caso lê o mesmo material que
 * a IA usaria.
 *
 * É um AUMENTO, nunca uma trava do POST: qualquer falha (acervo, embedding,
 * banco) devolve `[]`, e a resposta de IA sai sem citação — nunca 500. "Sem
 * acervo" (fonte nenhuma) E "nada acima do limiar" (`melhorSimilaridade`) caem
 * no mesmo `[]`: o chat não alucina uma fonte que a busca não achou.
 */
async function buscarCitacoes(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  agentId: string | null,
  pergunta: string,
  deps: { resolverAcervo?: typeof resolverAcervoDoAgente; buscar?: typeof buscarConhecimento } = {},
): Promise<Citation[]> {
  if (agentId === null) return [];
  const resolver = deps.resolverAcervo ?? resolverAcervoDoAgente;
  const buscar = deps.buscar ?? buscarConhecimento;
  const fontes = await resolver(supabase, orgId, agentId);
  if (fontes.length === 0) return [];
  const resultado = await buscar(supabase, {
    organizationId: orgId,
    knowledgeSourceIds: fontes,
    pergunta,
    topK: QUANTIDADE_DE_CITACOES,
    limiar: LIMIAR_PADRAO_BUSCA,
  });
  return resultado.trechos.map(trechoParaCitacao);
}

/** Trecho do acervo → `Citation` que `CitationsPanel` já sabe renderizar. */
function trechoParaCitacao(t: TrechoEncontrado): Citation {
  return {
    chunk_id: t.chunk_id,
    knowledge_source_id: t.knowledge_source_id,
    // `source_name` é o nome do material; vira a âncora que o painel mostra.
    source_anchor: t.source_name ?? null,
    score: t.similarity,
    snippet: t.content.slice(0, 200),
  };
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  // PRIMEIRO passo do handler, e a ordem é o ponto: sem a guarda de suporte, um
  // admin de plataforma em acompanhamento somente-leitura gastaria o orçamento
  // do cliente e leria dado pessoal com rastro só de acompanhamento.
  //
  // ⚠️ O gate que cobra esta linha (`tests/unit/suporte-cobertura-de-efeitos`)
  // casa o TEXTO do handler INCLUINDO COMENTÁRIOS — medido na sabotagem desta
  // onda. Por isso esta prosa NÃO escreve o nome da função seguido de parêntese:
  // escrevê-lo satisfaria o gate sozinho, e apagar a chamada de verdade ficaria
  // verde. Comentário que desarma o próprio gate é pior que comentário nenhum.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const c = await contexto(ctx, requestId);
  if ("response" in c) return c.response;

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", c.t("Body inválido."), 400, { requestId });
  }
  const parsed = corpoDoPost.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", c.t("Body inválido."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { turn_id: turnId, pergunta } = parsed.data;

  const porUsuario = await checkRateLimit(`caso-chat:${c.userId}`, TETO_POR_USUARIO, JANELA_SEGUNDOS);
  const porOrganizacao = await checkRateLimit(
    `caso-chat-org:${c.orgId}`,
    TETO_POR_ORGANIZACAO,
    JANELA_SEGUNDOS,
  );
  if (!porUsuario.allowed || !porOrganizacao.allowed) {
    return fail("rate_limited", c.t("Muitas perguntas seguidas. Tente em um minuto."), 429, {
      requestId,
      headers: {
        "Retry-After": String(JANELA_SEGUNDOS),
        "X-RateLimit-Limit": String(porUsuario.limit),
        "X-RateLimit-Remaining": String(Math.max(0, porUsuario.limit - porUsuario.count)),
      },
    });
  }

  let pool;
  try {
    pool = getRequestPool();
  } catch {
    return fail("unavailable", c.t("Conversa do caso indisponível (configuração)."), 503, {
      requestId,
    });
  }

  // ids resolvidos do BANCO, nunca do body (anti-pattern 10).
  const caso = await lerCaso(pool, c.orgId, c.caseId);
  if (caso === null || caso.contact_id === null) {
    return fail("not_found", c.t("Caso não encontrado."), 404, { requestId });
  }
  const contactId = caso.contact_id;

  const { rows: contato } = await pool.query<{ is_blocked: boolean; is_anonymized: boolean }>(
    `select is_blocked, is_anonymized from contacts where organization_id = $1 and id = $2`,
    [c.orgId, contactId],
  );
  if (contato[0]?.is_anonymized === true) {
    // SEM gravar linha e SEM chamar o modelo: responder sobre um contato
    // anonimizado é reconstituir, num prompt, o que a cascata acabou de apagar.
    return fail(
      "reply_context_unavailable",
      c.t(
        "Este contato foi anonimizado a pedido dele. A IA não responde sobre casos de contato anonimizado.",
      ),
      422,
      { requestId },
    );
  }
  const bloqueado = contato[0]?.is_blocked === true;

  // O TETO POR CASO, contado no banco — ver a constante.
  const { rows: contagem } = await pool.query<{ n: string }>(
    `select count(*)::text as n from agent_case_chat_messages
      where organization_id = $1 and case_id = $2 and author_kind = 'human'
        and created_at > now() - interval '1 day'`,
    [c.orgId, c.caseId],
  );
  if (Number(contagem[0]?.n ?? 0) >= TETO_POR_CASO_EM_24H) {
    return fail("rate_limited", c.t("Este caso já recebeu muitas perguntas hoje."), 429, {
      requestId,
      headers: { "Retry-After": "3600" },
    });
  }

  // ─── A pergunta é gravada ANTES da chamada ──────────────────────────────
  //
  // Uma falha do modelo deixa RASTRO em vez de silêncio. E a unique é a
  // idempotência: `23505` significa que este `turn_id` já entrou, então o
  // pedido é um replay (clique duplo, retentativa do cliente) e a resposta sai
  // do banco — SEM uma segunda chamada paga ao modelo.
  let replay = false;
  try {
    await pool.query(
      `insert into agent_case_chat_messages
         (organization_id, case_id, conversation_id, contact_id, turn_id, author_kind,
          author_user_id, body)
       values ($1, $2, $3, $4, $5, 'human', $6, $7)`,
      [c.orgId, c.caseId, caso.conversation_id, contactId, turnId, c.userId, pergunta],
    );
  } catch (erro) {
    if ((erro as { code?: string }).code !== "23505") throw erro;
    replay = true;
  }
  if (replay) {
    const { rows } = await pool.query(
      `select ${COLUNAS_DO_CHAT} from agent_case_chat_messages
        where organization_id = $1 and case_id = $2 and turn_id = $3
        order by created_at asc, id asc`,
      [c.orgId, c.caseId, turnId],
    );
    // Sem `citacoes`: quem consome este POST trata o campo como opcional
    // (`useAskCase`), porque o `apiClient` refaz o POST em 429/503 com o
    // mesmo `turn_id` e pode receber ESTE formato.
    return ok({ turno: rows, replay: true }, { requestId });
  }

  const deps = requestTurnDeps();
  const fuso = await fusoDaOrganizacao(pool, c.orgId, deps.log);
  const persona = await personaDeAgora(pool, c.orgId, caso.agent_id);
  const fronteira = parseServiceBoundary(caso.context_snapshot?.service_boundary);
  const obsoleto = await casoEstaObsoleto(pool, c.orgId, caso.context_snapshot);
  const janela =
    persona.fonte === "agente_do_caso" ? persona.agente.historyMessageWindow : 20;

  const [eventos, conversa, memoria, decisoes, orgMemory, historicoBruto] = await Promise.all([
    lerEventosDoCaso(pool, c.orgId, c.caseId),
    lerConversaDoCaso(pool, c.orgId, {
      conversationId: caso.conversation_id,
      serviceRevision: fronteira?.service_revision ?? null,
      abertoEm: caso.opened_at,
      limite: janela,
    }),
    lerMemoriaDoAtendimento(pool, c.orgId, contactId, caso.conversation_id),
    lerDecisoesDaEquipe(createAdminClient(), c.orgId, caso.conversation_id),
    loadOrgMemory(pool, c.orgId),
    pool.query<{ author_kind: "human" | "ai"; body: string | null }>(
      `select author_kind, body from agent_case_chat_messages
        where organization_id = $1 and case_id = $2 and body is not null and turn_id <> $3
        order by created_at asc, id asc limit 20`,
      [c.orgId, c.caseId, turnId],
    ),
  ]);

  const { rows: nome } = await pool.query<{ display_name: string | null; name: string | null }>(
    `select display_name, name from contacts where organization_id = $1 and id = $2`,
    [c.orgId, contactId],
  );
  // SÓ o primeiro nome — o bloco de dados não leva telefone nem e-mail.
  //
  // A cadeia sai de `nomeDoContato` e NÃO é remontada aqui. Escrita à mão, ela
  // saiu com a ordem TROCADA — o nome do perfil do WhatsApp antes do que o
  // operador digitou —, que é o defeito da issue #906: o nome escolhido por uma
  // pessoa nunca aparecia. Pior, ela não filtrava identificador técnico, e um
  // rótulo como `Contato 543134@lid` entraria no prompt como se fosse o primeiro
  // nome de alguém — a IA chamaria o cliente assim na frente de quem atende.
  //
  // Quem reprova a cópia à mão é `tests/unit/rotulo-do-contato.test.ts`, e esta
  // prosa evita escrever a cadeia literal de propósito: aquela régua casa o
  // TEXTO do arquivo, comentários inclusive, e citá-la aqui reprovaria
  // justamente o arquivo que faz a coisa certa.
  const primeiroNome =
    (nomeDoContato(nome[0] ?? null) ?? "o cliente").trim().split(/\s+/)[0] ?? "o cliente";

  const blocoDeDados = montarBlocoDeDados({
    fuso,
    caso: {
      titulo: caso.title,
      tipo: caso.kind ?? "outro",
      estado: caso.status,
      resumo: caso.summary,
      bloqueio: caso.blocker,
      abertoEm: caso.opened_at,
    },
    primeiroNomeDoContato: primeiroNome,
    contatoBloqueado: bloqueado,
    casoObsoleto: obsoleto === true,
    eventos,
    decisoesDaEquipe: decisoes,
    memoria,
    origemDoCaso: falasDoSnapshot(caso.context_snapshot, caso.opened_at),
    depoisDaAbertura: conversa.depois,
  });
  const system = montarSystem({
    persona: persona.fonte === "agente_do_caso" ? persona.agente.systemPrompt : PERSONA_NEUTRA,
    memoriaDaOrganizacao: renderOrgMemory(orgMemory) || null,
  });

  let erroCodigo: string | null = null;
  let resposta: Awaited<ReturnType<typeof responderSobreOCaso>> | null = null;
  let motivo: ReturnType<typeof motivoDaConversaDoCaso> | null = null;
  try {
    resposta = await responderSobreOCaso(
      pool,
      deps.llmCfg,
      {
        tenantId: c.orgId,
        contactId,
        system,
        blocoDeDados,
        historico: historicoBruto.rows.map((r) => ({
          author_kind: r.author_kind,
          body: r.body ?? "",
        })),
        pergunta,
        persona,
      },
      { registry: deps.registry, log: deps.log },
    );
  } catch (erro) {
    motivo = motivoDaConversaDoCaso(erro);
    erroCodigo = motivo.codigo;
    // O `catch` daqui NÃO é sem nome: os três erros de configuração acontecem
    // ANTES do `try` de `runModelCall` e não geram linha em `llm_calls` — sem
    // este log, a única pista viveria na bolha de erro da tela.
    logger.error("[conversa-do-caso] o modelo não respondeu", {
      requestId,
      organizationId: c.orgId,
      caseId: c.caseId,
      motivo: erroCodigo,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
  }

  await pool.query(
    `insert into agent_case_chat_messages
       (organization_id, case_id, conversation_id, contact_id, turn_id, author_kind,
        body, error_code, agent_id, llm_call_id, service_stale)
     values ($1, $2, $3, $4, $5, 'ai', $6, $7, $8, $9, $10)
     on conflict do nothing`,
    [
      c.orgId,
      c.caseId,
      caso.conversation_id,
      contactId,
      turnId,
      resposta?.texto ?? null,
      erroCodigo,
      resposta?.agentId ?? null,
      resposta?.callId ?? null,
      obsoleto === true,
    ],
  );

  // SEM a pergunta e SEM a resposta no metadata: `api_audit_log` é append-only,
  // sem UPDATE nem DELETE para papel nenhum — o que entra ali não sai pela
  // cascata de LGPD.
  void audit({
    action: "ai.case_chat_asked",
    actorUserId: c.userId,
    organizationId: c.orgId,
    resourceType: "agent_case",
    resourceId: c.caseId,
    requestId,
    metadata: {
      turn_id: turnId,
      llm_call_id: resposta?.callId ?? null,
      persona: persona.fonte,
      persona_motivo: persona.fonte === "padrao_da_organizacao" ? persona.motivo : null,
      service_stale: obsoleto === true,
      respondeu: erroCodigo === null,
      error_code: erroCodigo,
    },
  });

  // ─── F3 (#1869): os trechos do acervo ligados à pergunta ─────────────────
  // A busca vem DEPOIS do modelo: o que ela acha vai à tela, não ao prompt.
  // A busca acontece SÓ se a resposta saiu (resposta != null). Não mede o que
  // não aconteceu. E nunca derruba o POST: falha vira `[]`, e a resposta segue
  // sem citação — sem erro, sem alucinar uma fonte.
  let citacoes: Citation[] = [];
  if (resposta !== null) {
    try {
      citacoes = await buscarCitacoes(c.db, c.orgId, caso.agent_id, pergunta, ctx.citacoes);
    } catch (erro) {
      logger.warn("[conversa-do-caso] o acervo não foi consultado — a resposta sai sem citação", {
        requestId,
        organizationId: c.orgId,
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  if (motivo !== null) {
    // A linha FICA gravada e a rota devolve 422 — os dois juntos de propósito:
    // o status honra o monitoramento, a linha honra quem abrir o caso depois.
    return fail(motivo.codigo, c.t(motivo.texto), 422, { requestId });
  }

  return ok(
    {
      turn_id: turnId,
      resposta: resposta?.texto ?? "",
      persona: personaParaTela(persona),
      service_stale: obsoleto === true,
      contato_bloqueado: bloqueado,
      // F3 (#1869): os trechos do acervo ligados à pergunta — não ao que o
      // modelo leu, que não os recebeu. `[]`
      // quando não há acervo, nada passou no limiar, ou a busca falhou.
      citacoes,
    },
    { requestId },
  );
}
