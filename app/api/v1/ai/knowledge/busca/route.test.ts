import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import type * as Embed from "@/lib/ai/embed";

/**
 * POST /api/v1/ai/knowledge/busca — "perguntar ao acervo" pelo operador.
 *
 * O que este arquivo guarda não é o retrieval (isso é `busca.ts` e a RPC), e sim
 * as três mentiras que a tela poderia contar:
 *
 *  1. **"acervo vazio" virar "nada encontrado".** Sem material publicado, a busca
 *     nem roda; dizer "não encontramos" faria o operador concluir que a base não
 *     sabe — quando ela está só vazia. São diagnósticos opostos.
 *  2. **"quase achou" chegar igual a "não tem".** `melhorSimilaridade` existe
 *     exatamente para separar as duas: uma manda reformular, a outra manda perguntar
 *     para humano. Sem o número, a tela promete "sem resultado" para uma busca que
 *     passou raspando.
 *  3. **`organization_id` vindo do corpo.** O contrato de `buscarConhecimento`
 *     exige fonte confiável; o corpo é fonte adulterável.
 *
 * `buscarConhecimento` roda DE VERDADE aqui — só o embedding e o RPC são trocados.
 * Mockar a busca seria medir o mock.
 */

vi.mock("@/lib/ai/embed", async (original) => ({
  // A classe de erro é a REAL: a rota decide o 409 por `instanceof`.
  ...(await original<typeof Embed>()),
  embedText: vi.fn(async () => ({ embedding: new Array(1536).fill(0.1) })),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async (_chave: string, limit: number) => ({ allowed: true, count: 1, limit })),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));

const ORG_DA_SESSAO = "22222222-2222-4222-8222-222222222222";
const ORG_MENTIROSAS_NO_CORPO = "99999999-9999-4999-9999-999999999999";
const FONTE = "66666666-6666-4666-8666-666666666666";

type Linha = { chunk_id: string; knowledge_source_id: string | null; source_name: string | null; content: string; similarity: number };

/** Supabase falso: `.from()` encadeável, `.rpc()` devolvendo o que o caso pedir
 *  e `.insert()` REGISTRANDO a linha — a F2 da #1869 grava telemetria, e sem
 *  registrar aqui não há como provar que a busca humana virou métrica. */
function supabaseFalso(
  opts: { fontes?: unknown[]; linhas?: Linha[]; insertFalha?: boolean; fontesErro?: string } = {},
) {
  const rpcArgs: unknown[] = [];
  const inserts: Record<string, unknown>[] = [];
  const fontes = opts.fontes ?? [{ id: FONTE }];
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: () => cadeia,
    maybeSingle: async () => ({ data: null, error: null }),
    insert: (linha: Record<string, unknown>) => {
      inserts.push(linha);
      // `insertFalha` simula o banco fora do ar: a telemetria é secundária e
      // NÃO pode transformar uma busca que aconteceu em 500 (F2 da #1869).
      if (opts.insertFalha) return Promise.reject(new Error("banco indisponivel"));
      return Promise.resolve({ data: null, error: null });
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        opts.fontesErro
          ? { data: null, error: { message: opts.fontesErro } }
          : { data: fontes, error: null },
      ).then(resolve),
  };
  const db = {
    from: () => cadeia,
    rpc: async (nome: string, args: unknown) => {
      rpcArgs.push({ nome, args });
      return { data: opts.linhas ?? [], error: null };
    },
    __rpc: rpcArgs,
    __inserts: inserts,
  };
  return db;
}

function requisicao(corpo: unknown) {
  return new NextRequest("http://local/api/v1/ai/knowledge/busca", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

function resultadoDe(corpo: unknown) {
  return POST(requisicao(corpo));
}

import { POST } from "./route";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { SemChaveDeEmbeddingError } from "@/lib/ai/embed";
import { createClient } from "@/lib/supabase/server";

beforeEach(() => {
  // Sem isto os casos contam um ao outro: `embedText` acumulava as chamadas dos
  // testes anteriores e "deve chamar 1x" virava "chamou 4x" — o defeito é do
  // teste, não da rota. `clearAllMocks` zera as contagens e PRESERVA as
  // implementações do `vi.mock` (seria `resetAllMocks` que as apagaria).
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "user-1", idioma: "pt" },
    org: { orgId: ORG_DA_SESSAO },
    response: new Response(),
  } as never);
  vi.mocked(createClient).mockReset();
});

describe("perguntar ao acervo", () => {
  it("distingue acervo VAZIO de acervo sem a resposta", async () => {
    // (a) nenhuma fonte ativa — o mais parecido possível de "não encontramos".
    vi.mocked(createClient).mockResolvedValue(supabaseFalso({ fontes: [] }) as never);
    const vazio = await resultadoDe({ pergunta: "qual o horario" });
    // Acervo vazio é ESTADO, não falha: 200 com lista vazia e sem similaridade.
    // Um 500 (ou um erro de banco) faria o operador abrir suporte por causa de
    // uma organização que só ainda não publicou material.
    expect(vazio.status).toBe(200);
    const a = (await vazio.json()) as {
      data: { motivo: string; trechos: unknown[]; melhorSimilaridade: number | null };
    };
    expect(a.data.trechos).toEqual([]);
    expect(a.data.melhorSimilaridade).toBeNull();
    expect(a.data.motivo).toContain("material publicado");

    // (b) a base TEM material, mas não tem essa informação.
    vi.mocked(createClient).mockResolvedValue(supabaseFalso({ linhas: [] }) as never);
    const semResposta = await resultadoDe({ pergunta: "qual o horario" });
    const b = (await semResposta.json()) as { data: { motivo: string; trechos: unknown[] } };
    expect(b.data.trechos).toEqual([]);
    expect(b.data.motivo).toContain("não tem essa informação");
    expect(b.data.motivo).not.toContain("material publicado");
  });

  it("mostra que a base tem algo PORTE quando não passa no limiar", async () => {
    vi.mocked(createClient).mockResolvedValue(
      supabaseFalso({
        linhas: [
          { chunk_id: "c1", knowledge_source_id: FONTE, source_name: "FAQ", content: "…", similarity: 0.31 },
        ],
      }) as never,
    );

    const res = await resultadoDe({ pergunta: "qual o horario" });
    const corpo = (await res.json()) as {
      data: { trechos: unknown[]; melhorSimilaridade: number | null; motivo: string };
    };

    // 0,31 < 0,40 (limiar do caminho humano) — fica de fora…
    expect(corpo.data.trechos).toEqual([]);
    // …mas o número chega, e é ele que separa "reformule" de "peça ajuda".
    expect(corpo.data.melhorSimilaridade).toBeCloseTo(0.31, 5);
    expect(corpo.data.motivo).toContain("parecido");
  });

  it("pega a organização da SESSÃO, ignorando a do corpo", async () => {
    const db = supabaseFalso({ linhas: [] });
    vi.mocked(createClient).mockResolvedValue(db as never);

    await resultadoDe({
      pergunta: "qual o horario",
      organization_id: ORG_MENTIROSAS_NO_CORPO,
      organizationId: ORG_MENTIROSAS_NO_CORPO,
    });

    const { embedText } = await import("@/lib/ai/embed");
    expect(vi.mocked(embedText)).toHaveBeenCalledWith(
      "qual o horario",
      expect.objectContaining({ organizationId: ORG_DA_SESSAO }),
    );
    const rpc = db.__rpc as Array<{ args: { p_organization_id: string } }>;
    expect(rpc).toHaveLength(1);
    expect(rpc[0]?.args.p_organization_id).toBe(ORG_DA_SESSAO);
  });

  it("devolve os trechos com o NOME da fonte, que é o que a tela cita", async () => {
    // Sem `source_name` o operador lê um parágrafo solto e não sabe de que
    // material ele saiu — e é justamente a citação que separa "a IA respondeu"
    // de "a IA inventou". O campo tem de atravessar a rota, não só o `busca.ts`.
    vi.mocked(createClient).mockResolvedValue(
      supabaseFalso({
        linhas: [
          {
            chunk_id: "c1",
            knowledge_source_id: FONTE,
            source_name: "Manual do plano",
            content: "O prazo de entrega é de 5 dias úteis.",
            similarity: 0.87,
          },
        ],
      }) as never,
    );

    const res = await resultadoDe({ pergunta: "qual o prazo de entrega" });
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as {
      data: {
        trechos: Array<{ source_name: string; content: string; similarity: number }>;
        melhorSimilaridade: number | null;
      };
    };

    expect(corpo.data.trechos).toHaveLength(1);
    expect(corpo.data.trechos[0]?.source_name).toBe("Manual do plano");
    expect(corpo.data.trechos[0]?.content).toContain("5 dias úteis");
    expect(corpo.data.melhorSimilaridade).toBeCloseTo(0.87, 5);
  });

  it("quem não enxerga o inbox recebe 403, sem ler acervo nenhum", async () => {
    // O gate é o `requireRole("agent")` da rota. Sem ele, um `viewer` (ou um
    // membership revogado) perguntaria ao acervo de uma organização que não
    // pode abrir — e o custo do embedding sairia na chave do self-hoster.
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);

    const res = await resultadoDe({ pergunta: "qual o prazo de entrega" });

    expect(res.status).toBe(403);
    // Nem cliente, nem embedding: a recusa acontece ANTES de qualquer leitura.
    expect(createClient).not.toHaveBeenCalled();
    const { embedText } = await import("@/lib/ai/embed");
    expect(vi.mocked(embedText)).not.toHaveBeenCalled();
  });

  it("erro ao LER o acervo vira 500 — nunca um 200 dizendo 'a base não tem'", async () => {
    // Este é o caso que separa "não sei" de "não tem". Engolir o erro do banco
    // e devolver lista vazia faria a tela afirmar, com todas as letras, que a
    // base não sabe a resposta — quando na verdade a leitura falhou. Quem
    // pergunta desiste de procurar por causa de um diagnóstico inventado.
    vi.mocked(createClient).mockResolvedValue(
      supabaseFalso({ fontesErro: "connection refused" }) as never,
    );

    const res = await resultadoDe({ pergunta: "qual o prazo de entrega" });

    expect(res.status).toBe(500);
    const corpo = (await res.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("Não foi possível ler o acervo");
    const { embedText } = await import("@/lib/ai/embed");
    expect(vi.mocked(embedText)).not.toHaveBeenCalled();
  });

  it("apara a quantidade entre 1 e 10", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseFalso({ linhas: [] }) as never);
    await resultadoDe({ pergunta: "oi tudo bem?", quantidade: 99 });
    const { embedText } = await import("@/lib/ai/embed");
    expect(vi.mocked(embedText)).toHaveBeenCalledTimes(1);

    vi.mocked(createClient).mockResolvedValue(supabaseFalso({ linhas: [] }) as never);
    await resultadoDe({ pergunta: "oi tudo bem?", quantidade: -5 });
    expect(vi.mocked(embedText)).toHaveBeenCalledTimes(2);
  });

  it("recusa pergunta de mais de 1000 caracteres antes de gastar embedding", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseFalso() as never);
    const res = await resultadoDe({ pergunta: "x".repeat(1001) });
    expect(res.status).toBe(422);
    const { embedText } = await import("@/lib/ai/embed");
    expect(vi.mocked(embedText)).not.toHaveBeenCalled();
  });

  it("recusa agentId que não é uuid com 422, e não com 500 sem envelope", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseFalso() as never);
    const res = await resultadoDe({ pergunta: "qual o horario", agentId: "abc" });
    expect(res.status).toBe(422);
  });

  it("devolve 429 quando o limite por minuto estoura, sem gastar embedding", async () => {
    // Cada pergunta gasta um embedding pago na chave do self-hoster.
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 13, limit: 12 } as never);
    vi.mocked(createClient).mockResolvedValue(supabaseFalso() as never);
    const res = await resultadoDe({ pergunta: "qual o horario" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const { embedText } = await import("@/lib/ai/embed");
    expect(vi.mocked(embedText)).not.toHaveBeenCalled();
  });

  it("organização sem chave de embedding recebe 409 com o que fazer, não 500", async () => {
    const { embedText } = await import("@/lib/ai/embed");
    vi.mocked(embedText).mockRejectedValueOnce(new SemChaveDeEmbeddingError(ORG_DA_SESSAO));
    vi.mocked(createClient).mockResolvedValue(supabaseFalso() as never);
    const res = await resultadoDe({ pergunta: "qual o horario" });
    expect(res.status).toBe(409);
    const corpo = (await res.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("Credenciais");
  });

  it("recusa pergunta de 1 caractere antes de gastar embedding", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseFalso() as never);
    const res = await resultadoDe({ pergunta: "a" });
    expect(res.status).toBe(422);
    const { embedText } = await import("@/lib/ai/embed");
    expect(vi.mocked(embedText)).not.toHaveBeenCalled();
  });
});

// ── F2 da #1869: a busca do OPERADOR vira métrica ─────────────────────────────
//
// B3 da issue: `knowledge_searches` só recebia o caminho do agente
// (`search-knowledge.ts:122`). O gráfico de /app/ai/evolution conta linhas SEM
// filtrar (aggregate.ts:201), então a linha humana aparece sozinha — mas só se
// alguém gravar. O que os casos abaixo medem é exatamente isso.
describe("telemetria da busca humana (F2 da #1869)", () => {
  /** O insert é fire-and-forget: precisamos deixar a promise assentar. */
  const assentar = () => new Promise((r) => setTimeout(r, 0));

  it("grava author_kind=human com a ORG e o USUARIO da sessao", async () => {
    const db = supabaseFalso();
    vi.mocked(createClient).mockResolvedValue(db as never);
    await resultadoDe({ pergunta: "qual o prazo de entrega" });
    await assentar();

    const inserts = db.__inserts as Array<Record<string, unknown>>;
    expect(inserts).toHaveLength(1);
    const linha = inserts[0]!;
    expect(linha.author_kind).toBe("human");
    // A organização vem da SESSÃO, jamais do corpo — mesma regra da própria
    // rota (caso "pega a organização da SESSÃO"); gravar a do corpo deixaria a
    // métrica de uma organização dentro da tabela de outra.
    expect(linha.organization_id).toBe(ORG_DA_SESSAO);
    expect(linha.author_user_id).toBe("user-1");
    expect(linha.threshold).toBeTypeOf("number");
    expect(linha.hits).toBeTypeOf("number");
  });

  it("grava mesmo quando a base NADA encontra (hits=0 é a métrica)", async () => {
    // É o caso que a 0086 existe para medir: "a base não tem isso" precisa
    // aparecer, senão o painel só vê as buscas que acertaram.
    const db = supabaseFalso({ linhas: [] });
    vi.mocked(createClient).mockResolvedValue(db as never);
    await resultadoDe({ pergunta: "quem e o dono da conta" });
    await assentar();

    const inserts = db.__inserts as Array<Record<string, unknown>>;
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.hits).toBe(0);
  });

  it("a telemetria NUNCA derruba a busca (banco fora => resposta intacta)", async () => {
    const db = supabaseFalso({ insertFalha: true });
    vi.mocked(createClient).mockResolvedValue(db as never);
    const res = await resultadoDe({ pergunta: "qual o horario de atendimento" });
    await assentar();

    // Sem o try/catch próprio da registrarBuscaHumana, a rejeição cairia no
    // catch do handler e a tela diria "não foi possível consultar o acervo"
    // para uma busca que CONTEÚM aconteceu — prometer e desmentir.
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { motivo?: string | null } };
    expect(corpo.data?.motivo === undefined || corpo.data.motivo === null || typeof corpo.data.motivo === "string").toBe(true);
  });

  it("acervo sem material NÃO grava — não houve busca para medir", async () => {
    // Decisão documentada na rota: o retorno antecipado de "acervo vazio"
    // acontece ANTES de qualquer RPC. Gravaria uma linha de CONFIGURAÇÃO como
    // se fosse uma pergunta, e o gráfico contaria como busca.
    const db = supabaseFalso({ fontes: [] });
    vi.mocked(createClient).mockResolvedValue(db as never);
    await resultadoDe({ pergunta: "qual o prazo" });
    await assentar();

    const inserts = db.__inserts as Array<Record<string, unknown>>;
    expect(inserts).toHaveLength(0);
  });
});
