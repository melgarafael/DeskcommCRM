import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { precoDoModelo } from "@/lib/agent-engine/edge/llm/pricing";

/**
 * O CÓDIGO QUE GRAVA `cost_cents` E A TABELA QUE O ORÇAMENTO LÊ DIZEM O MESMO PREÇO.
 *
 * ═══ O defeito, medido na fonte (issue #1490) ══════════════════════════════
 *
 * Duas verdades sobre o mesmo modelo. O `pricing.ts` — de onde sai o
 * `llm_calls.cost_cents` que a tela Uso e orçamento soma — cobrava
 * `gpt-5.6-sol` a 400/2000 centavos por 1M (preço PROMOCIONAL medido em
 * 23/09/2026 na fonte oficial, faixa Standard; a promoção vale ao menos até
 * 21/11/2026). A tabela `ai_pricing` (o que `lib/ai/cost.ts` lê) seguia com
 * 500/3000, a versão não promocional do catálogo 0101 — 25% a mais na entrada
 * e 50% a mais na saída, do lado que nunca aparece na tela de escolha.
 *
 * É o eixo que este repo já errou várias vezes (ver o cabeçalho de
 * `pricing.ts`): duas listas que precisam concordar, vivendo separadas. O
 * invariante `catalogo-de-modelos` já vigia `ai_models × ai_pricing` contra o
 * Postgres; este teste vigia a outra fronteira, `pricing.ts × baseline`, sem
 * precisar de banco — é o que roda em todo `pnpm test:unit`.
 *
 * Fontes comparadas, ambas LIDAS DO DISCO (não de memória):
 *   - código: `lib/agent-engine/edge/llm/pricing.ts` — importado de verdade
 *     pelo caso direcionado, e espelhado por regex para enumerar os ids;
 *   - tabela: os `insert ... values` literais de `ai_pricing` no
 *     `supabase/baseline.sql` — é o catálogo que o self-hoster recebe.
 *
 * ⚠️ Um preço promocional muda sem aviso. O que este teste amarra é a
 * CONCORDÂNCIA entre as duas fontes, não o valor eterno: quando a promoção
 * acabar, mudam-se as DUAS fontes (migration + pricing.ts) e este teste é o
 * que reclama se só uma delas andar.
 */

interface PrecoTabela {
  prompt: number;
  completion: number;
  notes: string;
}

/** Literais de `insert into public.ai_pricing ... values ('modelo', N, N, 'notes')` no baseline. */
function precosDaTabela(): Map<string, PrecoTabela> {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const mapa = new Map<string, PrecoTabela>();
  // Cada segmento começa num `insert into `; só o bloco da tabela interessa, e o
  // backfill da 0113 (`insert ... select`) não tem linha literal — fica de fora
  // de propósito: ele deriva de `ai_models`, não é preço declarado.
  for (const segmento of baseline.split(/\ninsert into /).slice(1)) {
    if (!segmento.startsWith("public.ai_pricing")) continue;
    const corpo = segmento.split(/\ninsert into /)[0]!;
    for (const m of corpo.matchAll(/\('([^']+)',\s*(\d+),\s*(\d+),\s*'([^']*)'\)/g)) {
      mapa.set(m[1]!, { prompt: Number(m[2]), completion: Number(m[3]), notes: m[4]! });
    }
  }
  return mapa;
}

/** Ids `gpt-*` declarados no `pricing.ts`, com entrada/saída em USD por 1M. */
function precosDoCodigo(): Map<string, { entradaUsd: number; saidaUsd: number }> {
  const fonte = readFileSync(
    join(process.cwd(), "lib", "agent-engine", "edge", "llm", "pricing.ts"),
    "utf8",
  );
  const mapa = new Map<string, { entradaUsd: number; saidaUsd: number }>();
  for (const m of fonte.matchAll(/'(gpt-[a-z0-9.\-]+)':\s*\{\s*input:\s*([\d.]+),\s*output:\s*([\d.]+)/g)) {
    mapa.set(m[1]!, { entradaUsd: Number(m[2]), saidaUsd: Number(m[3]) });
  }
  return mapa;
}

const gptDaTabela = [...precosDaTabela().keys()].filter((k) => k.startsWith("gpt-")).sort();
const gptDoCodigo = [...precosDoCodigo().keys()].sort();

describe("o preço que o código cobra é o preço que a tabela soma", () => {
  it("as duas fontes têm os mesmos ids gpt (guarda de vacuidade, juntas)", () => {
    // `> 0` como guarda de vacuidade — sugerida pelo @melgarafael na revisão do
    // #1498: um `toBe(12)` reprovaria quem adicionasse um modelo novo nas DUAS
    // fontes corretamente. Quem adiciona de um UM lado só cai na igualdade de
    // conjuntos logo abaixo, que é a asserção que fecha o buraco da #1478.
    // Medido em 23/09/2026: 12 ids gpt em cada fonte.
    expect(gptDoCodigo.length, "ids gpt lidos do pricing.ts").toBeGreaterThan(0);
    expect(gptDaTabela.length, "ids gpt lidos do baseline").toBeGreaterThan(0);
    expect(gptDaTabela, "id em uma fonte e não na outra").toEqual(gptDoCodigo);
  });

  it("cada id gpt tem o MESMO número nos dois lados (centavos por 1M)", () => {
    const tabela = precosDaTabela();
    const codigo = precosDoCodigo();
    // expect.soft: o laço conta TODOS os divergentes em vez de parar no
    // primeiro — a sabotagem tem de devolver a contagem prevista, não 1.
    for (const id of gptDoCodigo) {
      const c = codigo.get(id)!;
      const t = tabela.get(id);
      expect.soft(t, `${id} não tem linha em ai_pricing`).toBeDefined();
      if (!t) continue;
      expect.soft(Math.round(c.entradaUsd * 100), `${id}: entrada código × tabela`).toBe(t.prompt);
      expect.soft(Math.round(c.saidaUsd * 100), `${id}: saída código × tabela`).toBe(t.completion);
    }
  });

  it("gpt-5.6-sol: o caso direcionado da #1490, com a notes declarando fonte e data", () => {
    // Módulo REAL, não o regex: é `precoDoModelo()` que `costCents()` chama.
    const codigo = precoDoModelo("gpt-5.6-sol");
    expect(codigo, "o pricing.ts precisa conhecer o modelo").toBeDefined();
    expect(Math.round(codigo!.input * 100)).toBe(400);
    expect(Math.round(codigo!.output * 100)).toBe(2000);

    const linha = precosDaTabela().get("gpt-5.6-sol");
    expect(linha, "ai_pricing precisa ter a linha do gpt-5.6-sol").toBeDefined();
    expect(linha!.prompt).toBe(400);
    expect(linha!.completion).toBe(2000);
    // Procedência: prefixo `catálogo` é o que o invariante
    // `catalogo-de-modelos` exige para diferenciar preço declarado de cura
    // automática, e a notes carrega a FONTE e a DATA porque promoção muda.
    expect(linha!.notes).toMatch(/^catálogo /);
    expect(linha!.notes).toContain("2026-09-23");
    expect(linha!.notes).toContain("developers.openai.com/api/docs/pricing");
  });
});
