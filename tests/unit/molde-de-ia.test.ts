/**
 * O MOLDE DE IA DAS EMPRESAS NOVAS — a regra do que se copia (migration 9096).
 *
 * Três coisas, e cada uma pega um defeito diferente:
 *
 *  1. a regra pura (`lib/ai/molde-de-ia.ts`) que a tela usa para mostrar o que
 *     vai ser copiado: endpoint próprio e provedor sem chave da instalação
 *     ficam de fora;
 *  2. a lista de provedores copiáveis é EXATAMENTE a dos que têm chave da
 *     instalação (`lerAmbiente`). Se alguém der chave de instalação a um
 *     provedor novo e não o puser aqui, ele deixa de ser copiado (o lado
 *     seguro, mas a tela mentiria); se puser aqui um provedor SEM chave da
 *     instalação, a empresa nova nasce com uma função que falha na primeira
 *     chamada;
 *  3. o gatilho do banco escreve os mesmos provedores — lido na ÚLTIMA
 *     definição de cada função no `baseline.sql` (CLAUDE.md, item 10: quem vale
 *     é a última, e `find` mediria a errada). O comportamento contra o
 *     Postgres de verdade é de `tests/invariants/molde-de-ia-empresas-novas.test.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROVEDORES_DO_MOLDE,
  funcaoCopiavel,
  padraoCopiavel,
  resumirMolde,
  type FuncaoDoMolde,
} from "@/lib/ai/molde-de-ia";
import { IDS_COM_CHAVE, PROVEDOR_POR_ASSINATURA, IDS_DE_PROVEDOR_DE_DECISAO } from "@/lib/ai/pontos/provedores";
import { lerAmbiente } from "@/lib/instalacao/ambiente";

const RAIZ = join(__dirname, "..", "..");

function funcao(parcial: Partial<FuncaoDoMolde> & Pick<FuncaoDoMolde, "purpose" | "provider">): FuncaoDoMolde {
  return { model_id: "modelo-x", base_url: null, is_enabled: true, ...parcial };
}

describe("o que se copia do molde", () => {
  it("copia a função de provedor com chave da instalação e sem endereço próprio", () => {
    expect(funcaoCopiavel(funcao({ purpose: "stage_classifier", provider: "anthropic" }))).toBe(true);
    expect(funcaoCopiavel(funcao({ purpose: "compaction", provider: "openai" }))).toBe(true);
    expect(funcaoCopiavel(funcao({ purpose: "flush", provider: "openrouter" }))).toBe(true);
  });

  it("deixa de fora a função com endereço próprio — o gateway é do molde", () => {
    expect(
      funcaoCopiavel(funcao({ purpose: "compaction", provider: "openai", base_url: "https://gw.exemplo.test/v1" })),
    ).toBe(false);
  });

  it("endereço em branco não é endereço próprio (o mesmo `nullif(btrim(...))` do gatilho)", () => {
    expect(funcaoCopiavel(funcao({ purpose: "compaction", provider: "openai", base_url: "   " }))).toBe(true);
  });

  it.each(["google", "deepseek", "requesty", "custom", PROVEDOR_POR_ASSINATURA, "typesafe", "inventado"])(
    "deixa de fora %s — sem chave da instalação a função nasceria sem chave",
    (provider) => {
      expect(funcaoCopiavel(funcao({ purpose: "compaction", provider }))).toBe(false);
    },
  );

  it("a função DESLIGADA também é copiada (com o is_enabled dela) — é escolha do molde", () => {
    expect(funcaoCopiavel(funcao({ purpose: "compaction", provider: "openai", is_enabled: false }))).toBe(true);
  });
});

describe("o padrão do molde", () => {
  it("copia provider + default_model quando o provedor tem chave da instalação", () => {
    expect(padraoCopiavel({ provider: "anthropic", default_model: "claude-sonnet-5" })).toEqual({
      provider: "anthropic",
      default_model: "claude-sonnet-5",
    });
  });

  it.each([
    ["sem llm", null],
    ["sem modelo", { provider: "anthropic" }],
    ["modelo vazio", { provider: "anthropic", default_model: "  " }],
    ["provedor sem chave da instalação", { provider: "google", default_model: "gemini-x" }],
    ["a assinatura do ChatGPT", { provider: PROVEDOR_POR_ASSINATURA, default_model: "gpt-x" }],
    ["jsonb torto", { provider: 1, default_model: ["x"] }],
  ])("não copia (%s): a empresa nova fica com o padrão do produto", (_caso, llm) => {
    expect(padraoCopiavel(llm as never)).toBeNull();
  });
});

describe("o resumo que a tela mostra", () => {
  it("conta as funções copiadas, agrupa por modelo e conta as que ficam de fora", () => {
    const resumo = resumirMolde(
      [
        funcao({ purpose: "stage_classifier", provider: "anthropic", model_id: "claude-haiku-5-5" }),
        funcao({ purpose: "sentiment_classify", provider: "anthropic", model_id: "claude-haiku-5-5" }),
        funcao({ purpose: "compaction", provider: "openai", model_id: "gpt-5.6-luna" }),
        funcao({ purpose: "flush", provider: "openai", model_id: "gpt-x", base_url: "https://gw.exemplo.test" }),
        funcao({ purpose: "visao_de_imagem", provider: "google", model_id: "gemini-x" }),
      ],
      { provider: "anthropic", default_model: "claude-sonnet-5" },
    );
    expect(resumo.funcoes).toBe(3);
    expect(resumo.deixadas).toBe(2);
    expect(resumo.modelos).toEqual([
      { provider: "anthropic", model_id: "claude-haiku-5-5", funcoes: 2 },
      { provider: "openai", model_id: "gpt-5.6-luna", funcoes: 1 },
    ]);
    expect(resumo.padrao).toEqual({ provider: "anthropic", default_model: "claude-sonnet-5" });
  });

  it("molde vazio resume em zero, sem inventar padrão", () => {
    expect(resumirMolde([], null)).toEqual({ funcoes: 0, deixadas: 0, modelos: [], padrao: null });
  });
});

describe("a lista de provedores do molde", () => {
  it("é exatamente a dos provedores com chave da INSTALAÇÃO (`lerAmbiente`)", () => {
    // Uma fonte em que TODA variável está preenchida: `lerAmbiente` só marca
    // `true` o provedor que tem nome de variável em `VARIAVEL_DA_CHAVE`.
    const tudoPreenchido = new Proxy({}, { get: () => "preenchida" }) as Record<string, string>;
    const comChave = Object.entries(lerAmbiente(tudoPreenchido).chavesDeProvedor)
      .filter(([, tem]) => tem)
      .map(([id]) => id)
      .sort();
    expect([...PROVEDORES_DO_MOLDE].sort()).toEqual(comChave);
  });

  it("controle: todo provedor da lista é um provedor que o sistema conhece", () => {
    for (const p of PROVEDORES_DO_MOLDE) expect(IDS_COM_CHAVE as readonly string[]).toContain(p);
  });

  it("nunca inclui a assinatura do ChatGPT nem provedor que só decide (o Jev)", () => {
    expect(PROVEDORES_DO_MOLDE as readonly string[]).not.toContain(PROVEDOR_POR_ASSINATURA);
    for (const p of IDS_DE_PROVEDOR_DE_DECISAO) expect(PROVEDORES_DO_MOLDE as readonly string[]).not.toContain(p);
  });
});

/** O corpo da ÚLTIMA definição de uma função — a que o banco instala. */
function ultimaDefinicao(sql: string, nome: string): string {
  const i = sql.lastIndexOf(`create or replace function public.${nome}(`);
  expect(i, `${nome} não está definida`).toBeGreaterThanOrEqual(0);
  const fim = sql.indexOf("$$;", i);
  return sql.slice(i, fim + 3);
}

/** Todas as listas `provider in ('a', 'b', ...)` do corpo, cada uma como conjunto ordenado. */
function listasDeProvedor(corpo: string): string[][] {
  return [...corpo.matchAll(/provider'?\s+in\s*\(([^)]*)\)/g)].map((m) =>
    [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort(),
  );
}

describe("o gatilho do banco escreve a mesma lista", () => {
  const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
  const arquivo = readdirSync(join(RAIZ, "supabase", "migrations")).find((f) => /_9096_molde_de_ia/.test(f));
  const migration = readFileSync(join(RAIZ, "supabase", "migrations", arquivo ?? "inexistente"), "utf8");
  const esperado = [...PROVEDORES_DO_MOLDE].sort();

  it.each([
    ["baseline", "fn_molde_de_ia_na_org_nova", 2],
    ["baseline", "fn_llm_do_molde_de_ia", 1],
    ["migration", "fn_molde_de_ia_na_org_nova", 2],
    ["migration", "fn_llm_do_molde_de_ia", 1],
  ] as const)("%s: %s lista exatamente PROVEDORES_DO_MOLDE (%i vez(es))", (onde, fn, vezes) => {
    const listas = listasDeProvedor(ultimaDefinicao(onde === "baseline" ? baseline : migration, fn));
    // Controle: sem achar as listas, "todas iguais" seria verdade vazia.
    expect(listas.length).toBe(vezes);
    for (const l of listas) expect(l).toEqual(esperado);
  });

  it("o padrão de quem nasce passa pelo molde na definição que vale", () => {
    expect(ultimaDefinicao(baseline, "fn_seed_org_llm_defaults")).toContain("public.fn_llm_do_molde_de_ia()");
  });

  it("nenhuma das três funções aceita EXECUTE de anon/public no apêndice (doutrina, item 9)", () => {
    for (const fn of ["fn_llm_do_molde_de_ia", "fn_seed_org_llm_defaults", "fn_molde_de_ia_na_org_nova"]) {
      expect(baseline).toContain(`revoke execute on function public.${fn}() from public, anon, authenticated;`);
    }
  });
});
