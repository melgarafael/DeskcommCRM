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

/**
 * DIVERGÊNCIA DECLARADA entre o banco e o motor — sem migration nesta onda.
 *
 * `gemini-3.5-flash` está em `ai_pricing` com 150/900 (migration 0101, preço
 * inventado: a página oficial nunca teve seção dele). O endpoint foi aposentado
 * em 19/05/2026 e encaminha ao 3.6 Flash, então o motor cobra a tarifa do 3.6:
 * 75/375 na promo até 31/12/2026 e 150/750 depois (aistudio.google.com/docs/
 * deprecations e /docs/pricing, lidas em 18/11/2026). Enquanto a linha do banco
 * não for corrigida: saída 900 contra 750 (20% acima) e, durante a promo, entrada
 * em dobro. Trocar 150/900 por 150/750 no `baseline.sql` é trabalho de migration
 * — a próxima que tocar `ai_pricing` traz este par e APAGA a entrada desta lista.
 */
const DIVERGENCIA_DE_BANCO: Record<
  string,
  { banco: { prompt: number; completion: number }; motor: { input: number; output: number }; em: Date }
> = {
  "gemini-3.5-flash": {
    banco: { prompt: 150, completion: 900 },
    motor: { input: 150, output: 750 },
    em: new Date("2027-01-01T00:00:00.000Z"),
  },
};

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
      const divergente = DIVERGENCIA_DE_BANCO[id];
      if (divergente) {
        // Declarada, medida e com data de validade: banco no preço velho, motor no
        // preço oficial do modelo que de fato atende a chamada.
        expect.soft(t.prompt, `${id}: entrada em ai_pricing`).toBe(divergente.banco.prompt);
        expect.soft(t.completion, `${id}: saída em ai_pricing`).toBe(divergente.banco.completion);
        expect
          .soft(costCents(id, { ...vazio, inputTokens: 1_000_000 }, "1h", divergente.em), `${id}: entrada`)
          .toBeCloseTo(divergente.motor.input, 6);
        expect
          .soft(costCents(id, { ...vazio, outputTokens: 1_000_000 }, "1h", divergente.em), `${id}: saída`)
          .toBeCloseTo(divergente.motor.output, 6);
        continue;
      }
      // 3.6/3.7/3.8 Flash: a tabela só cabe um preço (PK em `model`) e guarda a
      // tarifa de 2027. O motor só a aplica a partir de 2027-01-01T00:00:00Z;
      // comparar com `new Date()` ficaria vermelho até lá e verde depois, sem mudança.
      // O 4 Argon (0703) segue o mesmo desenho com a tarifa de 2026-12-01T00:00:00Z.
      const em =
        id === "gemini-3.6-flash" || id === "gemini-3.7-flash" || id === "gemini-3.8-flash"
          ? new Date("2027-01-01T00:00:00.000Z")
          : id === "gemini-4-argon"
            ? new Date("2026-12-01T00:00:00.000Z")
            : undefined;
      expect.soft(costCents(id, { ...vazio, inputTokens: 1_000_000 }, "1h", em), `${id}: entrada`).toBeCloseTo(
        t.prompt,
        6,
      );
      expect.soft(costCents(id, { ...vazio, outputTokens: 1_000_000 }, "1h", em), `${id}: saída`).toBeCloseTo(
        t.completion,
        6,
      );
    }
  });
});
