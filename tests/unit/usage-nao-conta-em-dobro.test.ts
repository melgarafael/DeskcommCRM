/**
 * A UNIFICAÇÃO DA TELEMETRIA NÃO PODE CONTAR A MESMA LINHA DUAS VEZES.
 *
 * A migration 0130 fez `llm_calls` virar a única tabela de telemetria e migrou
 * `ai_invocations` para dentro dela. A rota de uso, que ANTES somava as duas,
 * passou a ler só uma.
 *
 * O perigo mora exatamente aí. Se alguém "restaurar" o bloco que somava a
 * segunda tabela — por engano, ou resolvendo um conflito de merge pelo lado
 * errado — a mesma linha entra duas vezes: o custo do mês **dobra** na tela, e
 * o teto de orçamento passa a disparar com metade do gasto real, pausando o
 * agente de um cliente que ainda tinha saldo.
 *
 * É uma falha silenciosa e cara, e nenhum teste de tipo a pega: somar duas
 * listas de linhas válidas compila perfeitamente.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const ROTA = "app/api/v1/ai/usage/route.ts";
const LOG = "lib/ai/log-invocation.ts";

describe("a rota de uso lê UMA tabela de telemetria", () => {
  it("consulta llm_calls", () => {
    // Controle positivo: sem esta asserção, apagar a consulta inteira faria os
    // testes abaixo passarem por vacuidade.
    const fonte = readFileSync(ROTA, "utf8");
    expect(fonte).toContain('.from("llm_calls")');
  });

  it("NÃO consulta ai_invocations", () => {
    // A tabela vira histórico na 0130. Uma leitura nova dela aqui é o caminho
    // de volta para a dupla contagem.
    const fonte = readFileSync(ROTA, "utf8");
    expect(
      fonte.includes('.from("ai_invocations")'),
      "a rota voltou a ler ai_invocations — com llm_calls já sendo a leitura primária, isso conta a mesma linha duas vezes",
    ).toBe(false);
  });

  it("agrega UMA fonte, não a concatenação de duas", () => {
    // O formato do defeito é literal: `[...invRows, ...engineRows]`. Guardar o
    // nome da variável é frágil de propósito — quem reintroduzir o spread vai
    // ter de passar por aqui e justificar.
    const fonte = readFileSync(ROTA, "utf8");
    const agregacao = fonte.slice(fonte.indexOf("aggregateUsage("));
    expect(agregacao.slice(0, 200)).not.toMatch(/\[\s*\.\.\..*,\s*\.\.\./s);
  });
});

describe("quem escreve telemetria escreve num lugar só", () => {
  it("logInvocation grava em llm_calls", () => {
    const fonte = readFileSync(LOG, "utf8");
    expect(fonte).toContain('.from("llm_calls")');
  });

  it("logInvocation NÃO grava mais em ai_invocations", () => {
    // Escrever nas duas faria a dupla contagem nascer no INSERT, e aí nem
    // remover a leitura resolveria.
    const fonte = readFileSync(LOG, "utf8");
    expect(fonte.includes('.from("ai_invocations")')).toBe(false);
  });
});

describe("o provedor derivado do modelo", () => {
  it("reconhece os quatro provedores suportados", async () => {
    const { providerDoModelo } = await import("@/lib/ai/log-invocation");
    expect(providerDoModelo("anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(providerDoModelo("claude-haiku-4-5")).toBe("anthropic");
    expect(providerDoModelo("openai/text-embedding-3-small")).toBe("openai");
    expect(providerDoModelo("gpt-5-mini")).toBe("openai");
    expect(providerDoModelo("gemini-2.5-pro")).toBe("google");
  });

  it("id com barra desconhecida vira openrouter, não um chute de fabricante", () => {
    // Ids `familia/modelo` de fabricante que não conhecemos vêm da OpenRouter,
    // que é o único caminho pelo qual eles chegam aqui.
    return import("@/lib/ai/log-invocation").then(({ providerDoModelo }) => {
      expect(providerDoModelo("meta-llama/llama-3.3-70b-instruct")).toBe("openrouter");
      expect(providerDoModelo("qwen/qwen3-max")).toBe("openrouter");
    });
  });

  it("o Jev é typesafe, não OpenRouter — mesmo com a barra no id", async () => {
    // `typesafe/jev-1.13.0` tem barra, e o ramo da barra atribuiria o custo do
    // Jev à OpenRouter na divisão por provedor da tela de Uso.
    const { providerDoModelo } = await import("@/lib/ai/log-invocation");
    expect(providerDoModelo("typesafe/jev-1.13.0")).toBe("typesafe");
    expect(providerDoModelo("jev-1.13.0")).toBe("typesafe");
  });

  it("o que não dá para saber vira 'desconhecido', nunca um palpite", async () => {
    // A coluna alimenta a divisão de custo por provedor. Um chute vira
    // estatística, e alguém decide onde cortar gasto olhando para ela.
    const { providerDoModelo } = await import("@/lib/ai/log-invocation");
    expect(providerDoModelo("modelo-sem-fabricante")).toBe("desconhecido");
    expect(providerDoModelo("")).toBe("desconhecido");
  });
});

describe("o backfill é idempotente", () => {
  it("o baseline marca a linha de origem e ignora conflito", () => {
    // O `update.sh` re-aplica o baseline INTEIRO a cada atualização do
    // self-hoster. Sem a marca + `on conflict`, cada execução re-inseriria as
    // mesmas linhas e o custo do mês passado cresceria sozinho — aparecendo
    // como "a conta subiu" sem nenhuma chamada nova.
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const bloco = baseline.slice(baseline.indexOf("insert into public.llm_calls ("));
    expect(bloco).toContain("legacy_invocation_id");
    expect(bloco.slice(0, 3000)).toContain("on conflict do nothing");
    expect(baseline).toContain("llm_calls_legacy_invocation_unique");
  });
});
