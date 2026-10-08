import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { costCents, precoDoModelo } from "@/lib/agent-engine/edge/llm/pricing";

/**
 * TODO MODELO QUE A TELA OFERECE TEM PREÇO NO MOTOR.
 *
 * O defeito medido: o catálogo (`ai_models`) oferecia seis modelos Gemini e o
 * `pricing.ts` não conhecia nenhum. `costCents` devolvia NULL em todo turno de
 * organização em Google, e `fn_gasto_de_ia_do_mes` soma `coalesce(cost_cents, 0)`
 * — o gasto aparecia zerado e o teto mensal nunca disparava.
 *
 * O vizinho `preco-openai-codigo-e-tabela-concordam` amarra o NÚMERO dos ids
 * `gpt-*`; este amarra a PRESENÇA de todo modelo de chat curado dos três
 * provedores nativos, e o número dos Gemini. Lê o `baseline.sql`, que é o
 * catálogo que o self-hoster recebe.
 */

const PROVEDORES = ["anthropic", "openai", "google"] as const;

/**
 * Exceções conhecidas — esta lista só encolhe.
 *
 * `gpt-5` e `gpt-5-mini` vêm do seed 0023 com 500/4000 e 150/600, preço que não
 * bate com a tabela oficial da OpenAI ($1,25/$10 e $0,25/$2). Dar-lhes linha no
 * motor exige decidir o preço e corrigir `ai_models` e `ai_pricing` por
 * migration, e o vizinho de paridade gpt exige a linha literal nas duas fontes.
 * Fica de fora desta mudança; até lá esses dois seguem com custo NULL.
 */
const SEM_PRECO_NO_MOTOR_CONHECIDOS = new Set(["gpt-5", "gpt-5-mini"]);

const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const segmentos = baseline.split(/\ninsert into /).slice(1);

/** Modelos de chat dos provedores nativos nos `insert into public.ai_models` literais. */
function modelosDeChatDoCatalogo(): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const segmento of segmentos) {
    if (!segmento.startsWith("public.ai_models")) continue;
    const corpo = segmento.split(";\n")[0]!;
    // Modelo de embedding não passa por `costCents`: quem indexa não é o motor de chat.
    if (/^public\.ai_models\s*\([^)]*supports_embedding/.test(corpo)) continue;
    for (const m of corpo.matchAll(/\('(anthropic|openai|google)',\s*'([^']+)'/g)) {
      mapa.set(m[2]!, m[1]!);
    }
  }
  return mapa;
}

/** Último preço literal de cada modelo em `ai_pricing` (o apêndice mais tarde vence). */
function precosDaTabela(): Map<string, { prompt: number; completion: number }> {
  const mapa = new Map<string, { prompt: number; completion: number }>();
  for (const segmento of segmentos) {
    if (!segmento.startsWith("public.ai_pricing")) continue;
    for (const m of segmento.split(";\n")[0]!.matchAll(/\('([^']+)',\s*(\d+),\s*(\d+),\s*'/g)) {
      mapa.set(m[1]!, { prompt: Number(m[2]), completion: Number(m[3]) });
    }
  }
  return mapa;
}

const catalogo = modelosDeChatDoCatalogo();
const gemini = [...catalogo].filter(([, p]) => p === "google").map(([id]) => id).sort();

describe("o catálogo e a tabela de preço do motor", () => {
  it("lê modelos dos três provedores (guarda de vacuidade)", () => {
    const provedores = new Set(catalogo.values());
    for (const p of PROVEDORES) expect(provedores.has(p), `nenhum modelo ${p} lido`).toBe(true);
  });

  it("todo modelo de chat curado tem preço em USD_PER_MTOK", () => {
    const semPreco = [...catalogo.keys()]
      .filter((id) => !SEM_PRECO_NO_MOTOR_CONHECIDOS.has(id))
      .filter((id) => precoDoModelo(id) === undefined)
      .sort();
    expect(semPreco, "modelo oferecido na tela que o motor grava com custo NULL").toEqual([]);
  });

  it("a lista de exceções só tem quem ainda falta", () => {
    // Quem ganhar preço sai da lista; senão a exceção vira salvo-conduto.
    for (const id of SEM_PRECO_NO_MOTOR_CONHECIDOS) {
      expect(catalogo.has(id), `${id} saiu do catálogo`).toBe(true);
      expect(precoDoModelo(id), `${id} já tem preço — tire da lista`).toBeUndefined();
    }
  });

  it("cada Gemini cobra no motor o mesmo que ai_pricing soma (centavos por 1M)", () => {
    expect(gemini.length).toBeGreaterThan(0);
    const tabela = precosDaTabela();
    for (const id of gemini) {
      const t = tabela.get(id);
      expect.soft(t, `${id} sem linha em ai_pricing`).toBeDefined();
      if (!t) continue;
      const vazio = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      expect.soft(costCents(id, { ...vazio, inputTokens: 1_000_000 }), `${id}: entrada`).toBeCloseTo(t.prompt, 6);
      expect.soft(costCents(id, { ...vazio, outputTokens: 1_000_000 }), `${id}: saída`).toBeCloseTo(t.completion, 6);
    }
  });
});
