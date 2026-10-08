/**
 * O CATÁLOGO QUE A TELA OFERECE E O PREÇO QUE A CONTA USA SÃO A MESMA LISTA.
 *
 * `ai_models` é o que o dono do negócio escolhe na tela. `ai_pricing` é o que o
 * orçamento usa para somar o gasto. São duas tabelas, e é o eixo que este repo
 * já errou várias vezes: duas listas que precisam concordar, vivendo separadas,
 * divergindo em silêncio. O sintoma aqui é caro e mudo — o cliente escolhe um
 * modelo e o gasto dele é somado com o preço de outro, ou não é somado, e o teto
 * de orçamento nunca dispara.
 *
 * Roda contra o Postgres efêmero nascido do `baseline.sql` — é o catálogo que o
 * self-hoster recebe de fato, não o do banco de dev de alguém.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

interface LinhaDeModelo {
  provider: string;
  model_id: string;
  entrada: number;
  saida: number;
}

function modelosDoCatalogo(): LinhaDeModelo[] {
  const out = sql(
    `select provider || '|' || model_id || '|' ||
            coalesce(input_price_per_million_cents::text, 'null') || '|' ||
            coalesce(output_price_per_million_cents::text, 'null')
       from public.ai_models
      where deprecated_at is null
      order by provider, model_id;`,
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [provider, model_id, entrada, saida] = l.split("|");
      return {
        provider: provider!,
        model_id: model_id!,
        entrada: Number(entrada),
        saida: Number(saida),
      };
    });
}

describe("catálogo de modelos", () => {
  it("não vem vazio (guarda de vacuidade)", () => {
    // Sem isto, um baseline que deixasse de semear o catálogo passaria em todas
    // as asserções abaixo por ausência de dado — e a tela do cliente ficaria sem
    // nenhum modelo para escolher, com o CI verde.
    expect(modelosDoCatalogo().length).toBeGreaterThan(0);
  });

  it("cada provedor tem EXATAMENTE um padrão", () => {
    // O índice parcial UNIQUE garante "no máximo um". Zero também quebra: a tela
    // abriria sem nada pré-selecionado e o self-hoster teria de adivinhar.
    const out = sql(
      `select provider || '=' || count(*) from public.ai_models
        where is_default_for_provider group by provider order by provider;`,
    );
    const padroes = out.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(padroes.sort()).toEqual(["anthropic=1", "google=1", "openai=1"]);
  });

  it("o padrão de cada provedor não está depreciado", () => {
    const out = sql(
      `select provider from public.ai_models
        where is_default_for_provider and deprecated_at is not null;`,
    );
    expect(out.trim()).toBe("");
  });

  it("todo modelo do catálogo tem preço nos dois lados", () => {
    const semPreco = modelosDoCatalogo().filter(
      (m) => !Number.isFinite(m.entrada) || !Number.isFinite(m.saida),
    );
    expect(semPreco.map((m) => m.model_id)).toEqual([]);
  });

  it("o preço da tela é o MESMO que a conta usa", () => {
    // A divergência que este par existe para pegar: escolher na tela por um
    // preço e ser cobrado por outro.
    const out = sql(
      `select m.model_id || ': catalogo=' ||
              m.input_price_per_million_cents || '/' || m.output_price_per_million_cents ||
              ' conta=' || p.prompt_cents_per_million_tokens::int || '/' ||
              p.completion_cents_per_million_tokens::int
         from public.ai_models m
         join public.ai_pricing p on p.model = m.model_id
        where m.deprecated_at is null
          and (m.input_price_per_million_cents <> p.prompt_cents_per_million_tokens
            or m.output_price_per_million_cents <> p.completion_cents_per_million_tokens)
        order by m.model_id;`,
    );
    expect(out.trim(), `divergência de preço entre ai_models e ai_pricing:\n${out}`).toBe("");
  });

  /**
   * ⚠️ ESTE CASO FOI REESCRITO DEPOIS DE UMA SABOTAGEM QUE ELE NÃO PEGOU.
   *
   * A versão ingênua era `left join ai_pricing ... where p.model is null`.
   * Removi de propósito a linha de preço de um modelo do apêndice e ela passou
   * VERDE. Motivo: `scripts/test-db.sh` aplica o baseline DUAS vezes (install e
   * update), e o backfill da 0068 — que deriva `ai_pricing` de `ai_models` e é
   * auto-curativo de propósito — preenche a falta na segunda passada. O teste
   * não estava errado; ele estava medindo um estado que o harness já curou.
   *
   * O risco real é a instalação FRESCA, de passada única: ali o modelo fica sem
   * preço até alguém rodar um update, e nesse intervalo `computeCost()` devolve
   * 0 sem log e o teto de `ai_budgets` nunca dispara — exatamente o bug que a
   * 0068 existe para consertar.
   *
   * O que sobrevive ao harness é a PROCEDÊNCIA do preço: se a linha veio do
   * apêndice, `notes` diz o catálogo; se veio da cura automática, diz
   * `backfill 0068`. Preço curado é preço que faltou.
   */
  it("o preço dos modelos do catálogo vem do catálogo, não da cura automática", () => {
    const out = sql(
      `select m.model_id || ' (preço veio de: ' || coalesce(p.notes, '(sem linha)') || ')'
         from public.ai_models m
         left join public.ai_pricing p on p.model = m.model_id
        where m.deprecated_at is null
          and m.model_id in ('claude-opus-5','claude-sonnet-5','claude-opus-4-8',
                             'gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5',
                             'gpt-5.5-pro','gpt-5.4','gpt-5.4-mini','gpt-5.4-nano',
                             'gpt-5.4-pro','gemini-3.1-pro-preview','gemini-3.5-flash',
                             'gemini-3.5-flash-lite',
                             'gemini-2.5-flash-lite','gemini-2.0-flash')
          and (p.model is null or p.notes not like 'catálogo%')
        order by 1;`,
    );
    expect(
      out.trim(),
      `modelo do catálogo sem preço PRÓPRIO — numa instalação fresca (passada única) ` +
        `ele fica sem preço até o primeiro update:\n${out}`,
    ).toBe("");
  });

  it("a geração corrente dos três provedores está no catálogo", () => {
    // Ids VERIFICADOS no provedor (GET /v1/models) para Anthropic e OpenAI. Este
    // caso é o que reprova quando o catálogo envelhece: sem ele, "o padrão é o
    // melhor disponível" vira uma frase que ninguém mede.
    const ids = new Set(modelosDoCatalogo().map((m) => m.model_id));
    for (const esperado of [
      "claude-opus-5",
      "claude-sonnet-5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
    ]) {
      expect(ids.has(esperado), `${esperado} ausente do catálogo`).toBe(true);
    }
  });

  it("Gemini 3.5 Flash-Lite pode ser selecionado e validado para ferramentas e visão", () => {
    const out = sql(
      `select provider || '|' || model_id || '|' || supports_tools || '|' ||
              supports_vision || '|' || is_default_for_provider
         from public.ai_models
        where provider = 'google' and model_id = 'gemini-3.5-flash-lite'
          and deprecated_at is null;`,
    );
    expect(out.trim()).toBe("google|gemini-3.5-flash-lite|true|true|false");
  });
});
