import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { SemChaveDeEmbeddingError } from "@/lib/ai/embed";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  KNOWLEDGE_SEARCH_AUTHOR_KINDS,
  LIMIAR_PADRAO_BUSCA,
  buscarConhecimento,
  resolverAcervoDoAgente,
} from "@/lib/ai/knowledge/busca";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * "Perguntar ao acervo" — a superfície do OPERADOR sobre a MESMA busca que a IA faz.
 *
 * Não reimplementa retrieval: chama `buscarConhecimento`, que o próprio docblock
 * define como "operação única, compartilhada". Duas implementações divergiriam em
 * limiar e em top-K, e o sistema passaria a responder diferente para a IA e para o
 * humano sobre o MESMO acervo — que é exatamente o defeito que a casa já corrigiu
 * uma vez (limiares 0,40 / 0,72 / 0,72 unificados na migração 0097).
 *
 * `organization_id` sai da sessão autenticada ou da linha do token de servidor
 * (`resolveAuthDual`), NUNCA do corpo — mesma regra documentada em
 * `lib/ai/knowledge/busca.ts`.
 *
 * Devolve `motivo` junto de um `trechos` possivelmente vazio, porque "a base não
 * tem essa informação" e "a base tem algo perto, mas não o bastante" são situações
 * que pedem ações opostas (reformular × perguntar para humano) e não podem chegar
 * iguais a quem pergunta. Sem isso a tela promete "sem resultado" para uma busca
 * que quase acertou.
 */

const QUANTIDADE_PADRAO = 6;
const QUANTIDADE_MAXIMA = 10;

/**
 * Cada pergunta gasta um embedding pago na chave do self-hoster. Mesmo padrão
 * da conversa do caso (`ai/cases/[id]/chat`): teto por PESSOA e por
 * ORGANIZAÇÃO — "12 por pessoa" com 20 pessoas seria 240 chamadas por minuto.
 */
const TETO_POR_USUARIO = 12;
const TETO_POR_ORGANIZACAO = 60;
const JANELA_SEGUNDOS = 60;

const corpoDaBusca = z.object({
  // `max` antes de gastar embedding: sem ele, um texto de megabytes vira
  // tokens pagos numa única chamada.
  pergunta: z.string().trim().min(2).max(1000),
  agentId: z.string().uuid().nullish(),
  // Tolerante de propósito: fora da faixa é aparado, não recusado (ver `numero`).
  quantidade: z.unknown().optional(),
});

/** Converte o corpo sem confiar em tipo algum — qualquer coisa fora vira o default. */
function numero(v: unknown, padrao: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // A rota MUTA: a F2 da #1869 grava a pergunta em `knowledge_searches`.
  // Sem esta guarda, o modo support_readonly seria ignorado por um handler que
  // escreve — quem está acompanhando em leitura veria linhas novas nascendo
  // métrica da própria instalação. `requireSupportWrite` (retorno não-nulo é a
  // recusa) cuida do MODO DE ACOMPANHAMENTO; o `requireRole` abaixo cuida do
  // PAPEL (`resolveAuthDual`). Um não substitui o outro.
  const support = await requireSupportWrite();
  if (support) return support;

  // Papel mínimo do inbox: um atendente lê conversa e lê acervo.
  // Sessão de navegador OU token de servidor (config:write + papel admin).
  // PLANO: a tabela do plano R1 não traz escopo para esta rota (é POST, com
  // gasto de embedding); usei config:write, o da escrita do plano.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_knowledge",
    role: "agent",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "ai_knowledge", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("unprocessable", t("Corpo inválido."), 422, { requestId });
  }
  const parsed = corpoDaBusca.safeParse(bruto);
  if (!parsed.success) {
    return fail("unprocessable", t("Corpo inválido."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { pergunta } = parsed.data;

  const organizationId = authz.organizationId;
  const porUsuario = await checkRateLimit(
    `acervo-busca:${authz.actor.type === "user" ? authz.actor.id : (authz.apiTokenId ?? authz.actor.id)}`,
    TETO_POR_USUARIO,
    JANELA_SEGUNDOS,
  );
  const porOrganizacao = await checkRateLimit(
    `acervo-busca-org:${organizationId}`,
    TETO_POR_ORGANIZACAO,
    JANELA_SEGUNDOS,
  );
  if (!porUsuario.allowed || !porOrganizacao.allowed) {
    return fail("rate_limited", t("Muitas perguntas seguidas. Tente em um minuto."), 429, {
      requestId,
      headers: {
        "Retry-After": String(JANELA_SEGUNDOS),
        "X-RateLimit-Limit": String(porUsuario.limit),
        "X-RateLimit-Remaining": String(Math.max(0, porUsuario.limit - porUsuario.count)),
      },
    });
  }

  const supabase = authz.supabase;
  const agentId = parsed.data.agentId ?? null;
  const quantidade = numero(parsed.data.quantidade, QUANTIDADE_PADRAO, 1, QUANTIDADE_MAXIMA);

  try {
    let knowledgeSourceIds: string[];
    let limiar = LIMIAR_PADRAO_BUSCA;

    if (agentId) {
      // Escopo do agente: mesmo acervo e MESMO limiar que a IA usaria para responder.
      knowledgeSourceIds = await resolverAcervoDoAgente(supabase, organizationId, agentId);
      const { data: agente } = await supabase
        .from("ai_agents")
        .select("config")
        .eq("id", agentId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      const cfg = agente?.config as { rag_similarity_threshold?: unknown } | null;
      // Mesma faixa que `agent-config.ts` aceita; fora dela o turno usa o padrão.
      const lido = cfg?.rag_similarity_threshold;
      if (typeof lido === "number" && lido >= 0 && lido <= 1) {
        limiar = lido;
      }
    } else {
      // Acervo da organização inteira — a biblioteca é da org; a escolha por
      // assistente é do AGENTE, não do operador que está apenas perguntando.
      const { data: fontes, error } = await supabase
        .from("ai_knowledge_sources")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("is_active", true);
      if (error) {
        return fail("internal_error", t("Não foi possível ler o acervo."), 500, { requestId });
      }
      knowledgeSourceIds = (fontes ?? []).map((f) => f.id as string);
    }

    if (knowledgeSourceIds.length === 0) {
      // Acervo vazio NÃO é "sem resultado": é acervo errado ou recém-criado.
      // Dizer "nada encontrado" aqui seria mentir e soaria como defeito.
      return ok(
        {
          trechos: [],
          melhorSimilaridade: null,
          motivo: t("Este acervo ainda não tem material publicado."),
          acervo: { fontes: 0, limiar },
        },
        { requestId },
      );
    }

    const resultado = await buscarConhecimento(supabase, {
      organizationId,
      knowledgeSourceIds,
      pergunta,
      topK: quantidade,
      limiar,
    });

    const vazio = resultado.trechos.length === 0;
    const melhor = resultado.melhorSimilaridade;

    // Três coisas diferentes chegam como "vazio" e pedem respostas opostas.
    const motivo = vazio
      ? melhor === null
        ? t("A base não tem essa informação.")
        : t("Há algo parecido no acervo, mas ainda abaixo do limiar — tente outras palavras.")
      : null;

    // Telemetria de busca HUMANA: só na sessão. Token de servidor não grava aqui
    // (função logo abaixo, fora do handler — ela nunca pode derrubar a busca).
    if (authz.actor.type === "user") {
      void registrarBuscaHumana(supabase, {
        organizationId,
        hits: resultado.trechos.length,
        topScore: melhor,
        threshold: limiar,
        fontes: knowledgeSourceIds,
        agentId: agentId ?? null,
        userId: authz.actor.id,
      });
    }

    return ok(
      {
        trechos: resultado.trechos,
        melhorSimilaridade: melhor,
        motivo,
        acervo: { fontes: knowledgeSourceIds.length, limiar },
      },
      { requestId },
    );
  } catch (e) {
    if (e instanceof SemChaveDeEmbeddingError) {
      // Estado da organização, não acidente: a tela diz o que fazer.
      return fail(
        e.code,
        t(
          "Esta organização ainda não tem chave de embedding. Cadastre uma chave OpenAI ou OpenRouter em Credenciais para consultar o acervo.",
        ),
        409,
        { requestId },
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ai-knowledge-busca] falhou:", msg);
    return fail("internal_error", t("Não foi possível consultar o acervo."), 500, { requestId });
  }
}

/**
 * Grava a pergunta do OPERADOR em `knowledge_searches` — F2 da #1869.
 *
 * ## Por que existe
 *
 * Só o caminho do agente gravava (`search-knowledge.ts:122`). O gráfico de
 * `/app/ai/evolution` conta linhas SEM filtrar (`aggregate.ts:201`), então uma
 * linha humana aparece sozinha — mas só aparece se alguém gravar. `author_kind`
 * (`'human'`) é o que a torna distinguível depois; `agent_id is null` não
 * serviria, porque é `on delete set null` desde a 0181.
 *
 * ## Por que nunca pode derrubar a busca
 *
 * O `catch` do handler devolveria 500 "não foi possível consultar o acervo" para
 * uma busca que CONTEÚM aconteceu e cujos trechos já estão na mão. É o defeito
 * de "prometer primeiro e desmentir depois" que o docblock desta página avisa —
 * só que no sentido inverso: aqui a tela mentiria sobre a própria falha.
 *
 * Mesma decisão do insert do agente (que é engolido de propósito lá, com o
 * `warn` encurtado para não vazar a pergunta no log — esta tabela nunca guarda
 * o texto, decisão da 0086).
 */
async function registrarBuscaHumana(
  supabase: Awaited<ReturnType<typeof createClient>>,
  p: {
    organizationId: string;
    hits: number;
    topScore: number | null;
    threshold: number;
    fontes: string[];
    agentId: string | null;
    userId: string;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from("knowledge_searches").insert({
      organization_id: p.organizationId,
      hits: p.hits,
      top_score: p.topScore,
      threshold: p.threshold,
      knowledge_source_ids: p.fontes,
      // Guarda o ACERVO consultado, não "quem perguntou": com author_kind='human'
      // a dupla lê "operador perguntou sobre o acervo do assistente X".
      agent_id: p.agentId,
      author_kind: KNOWLEDGE_SEARCH_AUTHOR_KINDS[0],
      author_user_id: p.userId,
    });
    if (error) console.warn("[ai-knowledge-busca] telemetria não gravada:", error.message);
  } catch (err) {
    console.warn(
      "[ai-knowledge-busca] telemetria não gravada:",
      err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
    );
  }
}
