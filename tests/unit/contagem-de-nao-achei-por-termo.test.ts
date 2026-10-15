import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { termosSemResultado, type LinhaDeTermo } from "@/lib/ai/agents/uso-de-capacidades";

/**
 * "NÃO ACHEI" CONTA POR TERMO, NÃO SÓ POR FERRAMENTA (#484, caminho 2).
 *
 * O caminho 1 do #484 (PR #1182) fez o vazio declarado da busca parar de ser
 * auditado como sucesso. O que faltava era o painel dizer QUAL termo não foi
 * encontrado: `fn_agent_tool_usage` (migration 0103) agrega SÓ por `tool_name`,
 * então "crm_search_products: 12 falhas" não separa "falta cadastrar um produto"
 * de "a busca erra sempre no mesmo termo".
 *
 * A cerca prende as duas pontas do SQL, porque SQL nenhum teste de TypeScript
 * exercita sem Docker (`pnpm test:db`, que roda a suíte `invariants`):
 *
 *   - ANTES: a `fn_agent_tool_usage` NÃO conhece termo — agrega por tool só;
 *   - DEPOIS: a irmã `fn_agent_tool_usage_por_termo` agrupa por (tool, termo),
 *     lendo a chave única `metadata.termo` que a tool passa a declarar.
 *
 * A leitura pura que alimenta a tela (`termosSemResultado`) é testada aqui
 * também — é o dado, não a tela: o aviso na Central (caminho 3) está fora do
 * recorte.
 */
const RAIZ = join(__dirname, "..", "..", "supabase");
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");
const CADEIA = readdirSync(join(RAIZ, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(RAIZ, "migrations", f), "utf8"))
  .join("\n");

/** Última definição de uma função, com o delimitador lido do próprio texto. */
function corpoDaFuncao(sql: string, nome: string): string | null {
  const re = new RegExp(`create or replace function public\\.${nome}\\s*\\(`, "gi");
  let ultimo: string | null = null;
  for (const m of sql.matchAll(re)) {
    const i = (m.index ?? 0) + m[0].length;
    const abertura = /\$([a-z_]*)\$/i.exec(sql.slice(i, i + 400));
    if (!abertura) continue;
    const fim = sql.indexOf(abertura[0], i + abertura.index + abertura[0].length);
    if (fim < 0) continue;
    ultimo = sql.slice(m.index, fim + abertura[0].length);
  }
  return ultimo;
}

describe("hoje a contagem agrega só por ferramenta; depois distingue o termo (#484)", () => {
  it("controle: as duas funções existem no baseline e na cadeia", () => {
    for (const nome of ["fn_agent_tool_usage", "fn_agent_tool_usage_por_termo"]) {
      expect(corpoDaFuncao(BASELINE, nome), `${nome} sumiu do baseline`).not.toBeNull();
      expect(corpoDaFuncao(CADEIA, nome), `${nome} sumiu da cadeia`).not.toBeNull();
    }
  });

  it("ANTES: fn_agent_tool_usage agrega por tool_name e NÃO conhece termo", () => {
    const corpo = corpoDaFuncao(BASELINE, "fn_agent_tool_usage")!;
    // Agrupa por UMA coluna (`tool_name`); acrescentar `termo` aqui quebraria
    // `montarUsoDeCapacidades`, que deduplica por nome de tool.
    expect(corpo).toMatch(/group\s+by\s+1\b/i);
    expect(corpo).not.toMatch(/group\s+by\s+1\s*,/i);
    expect(corpo).not.toMatch(/metadata->>'termo'/);
  });

  it("DEPOIS: fn_agent_tool_usage_por_termo agrupa por (tool_name, termo)", () => {
    // Nas DUAS pontas — o que chega ao cliente (baseline) e o que aplica a
    // cadeia (migrations) têm de contar o termo igual.
    for (const fonte of [BASELINE, CADEIA]) {
      const corpo = corpoDaFuncao(fonte, "fn_agent_tool_usage_por_termo")!;
      // Lê a chave ÚNICA que a tool declara — não `metadata.args.termo`.
      expect(corpo).toMatch(/metadata->>'termo'/);
      expect(corpo).toMatch(/group\s+by\s+1\s*,\s*2\b/i);
      // Só entra chamada que TEM termo declarado.
      expect(corpo).toMatch(/metadata->>'termo'\s+is\s+not\s+null/i);
      // A régua de falha é a MESMA da 0103: o vazio declarado continua contado.
      expect(corpo).toMatch(/metadata->>'success'\s*=\s*'false'/i);
    }
  });

  it("o mesmo caminho de acesso da 0103: request_id = ai_agent_runs.id", () => {
    const corpo = corpoDaFuncao(BASELINE, "fn_agent_tool_usage_por_termo")!;
    expect(corpo).toMatch(/a\.request_id\s*=\s*r\.id::text/i);
    expect(corpo).toMatch(/action\s*=\s*'mcp\.tool_called'/i);
  });
});

/** Uma linha como a função devolve, já convertida (bigint → number). */
function linha(over: Partial<LinhaDeTermo> = {}): LinhaDeTermo {
  return { tool_name: "crm_search_products", termo: "iphone", total: 3, falhas: 3, ultima_vez: null, ...over };
}

describe("termosSemResultado: a lista do que não acharam", () => {
  it("só entram termos que falharam — termo que sempre acha é sucesso", () => {
    const linhas = [linha({ termo: "iphone" }), linha({ termo: "capa", total: 5, falhas: 0 })];
    const lista = termosSemResultado(linhas);
    expect(lista.map((t) => t.termo)).toEqual(["iphone"]);
  });

  it("ordena por falhas; empate desempata pela taxa e o termo dá estabilidade", () => {
    const linhas = [
      linha({ termo: "iphone", total: 10, falhas: 2 }), // falha às vezes
      linha({ termo: "iphone 15 pro 512", total: 3, falhas: 3 }), // falha SEMPRE
      linha({ termo: "fone", total: 4, falhas: 2 }), // mesmo número, taxa menor
    ];
    const lista = termosSemResultado(linhas);
    // 3 falhas primeiro (o que mais dói); no empate de 2 falhas, quem falha
    // SEMPRE (taxa 0,5) vem antes de quem falha às vezes (taxa 0,2).
    expect(lista.map((t) => t.termo)).toEqual(["iphone 15 pro 512", "fone", "iphone"]);
  });

  it("carrega a taxa de falha, que separa 'termo difícil' de 'termo que não existe'", () => {
    const [so] = termosSemResultado([linha({ total: 4, falhas: 3 })]);
    expect(so?.taxa_de_falha).toBeCloseTo(0.75);
  });

  it("lista vazia quando ninguém falhou", () => {
    expect(termosSemResultado([linha({ total: 5, falhas: 0 })])).toEqual([]);
    expect(termosSemResultado([])).toEqual([]);
  });
});
