/**
 * O PREÇO DO MODELO QUE O MOTOR NÃO TEM NA TABELA SAI DO CATÁLOGO DA INSTALAÇÃO (#3013).
 *
 * ## O defeito, medido pelo dono
 *
 * Instalação própria, provedor PERSONALIZADO apontando para o Groq, modelo
 * `openai/gpt-oss-120b` no propósito `checkpoint`. De 12/10 a 16/10: 180 chamadas
 * `custom` + `openai/gpt-oss-120b` e 256 `custom` + `openai/gpt-oss-20b`, TODAS
 * com `llm_calls.cost_cents` nulo — enquanto o Haiku 5.5 do mesmo turno tinha
 * custo. `grep -c gpt-oss` em `pricing.ts` dava 0: a tabela estática do motor não
 * conhece o id, `costCents` devolve `null` e o teto de orçamento não via a
 * chamada (o gasto é somado como `coalesce(cost_cents, 0)`).
 *
 * ## O que este arquivo amarra
 *
 * 1. a PREMISSA — a tabela estática do motor não conhece `gpt-oss`, e o preço não
 *    foi CHUTADO para dentro dela (catraca que lê o arquivo-fonte);
 * 2. o CAMINHO — com a linha de preço que a instalação tem (`ai_pricing`/
 *    `ai_models`), o custo do id fora da tabela passa a ser calculado, em centavo
 *    fracionado, sem arredondar;
 * 3. o CONTROLE NEGATIVO — id que não está em tabela nenhuma continua sem preço:
 *    `null`, nunca um número inventado;
 * 4. a MARCA — sem preço em lugar nenhum o `null` sai ACOMPANHADO de aviso, uma
 *    vez por (provedor, modelo).
 *
 * ## Sobre os números usados aqui
 *
 * 15/60 centavos por milhão são os da linha `openai/gpt-oss-120b` que o dono
 * MEDIU na `ai_pricing` da instalação dele, e que a issue cita. Este teste usa
 * esses números como DUBLÊ do banco dele — não como preço que o repo declara. É
 * por isso que a catraca do item (1) existe: quem tiver o preço do Groq conferido
 * na fonte oficial e quiser a linha em `pricing.ts` também tem de pôr a linha
 * correspondente em `ai_pricing` (o vizinho
 * `tests/unit/preco-openai-codigo-e-tabela-concordam.test.ts` cobra a paridade).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../obs/logger";
import { costCents, precoDoModelo, type TokenUsage } from "./pricing";
import {
  _esquecerPrecosDoCatalogoParaTestes,
  candidatosDeId,
  custoComPrecoDaInstalacao,
  custoDoModeloForaDoMotor,
  precoDaInstalacao,
} from "./pricing-do-catalogo";

/** Uso de um turno de fundo (`checkpoint`): entra contexto, sai pouca coisa. */
const USO: TokenUsage = {
  inputTokens: 12_000,
  outputTokens: 300,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** 1 MTok inteiro em cada tarifa — isola entrada e saída na conta. */
const UM_MILHAO: TokenUsage = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

interface LinhaFalsa {
  id: string;
  provider: string | null;
  entrada: number | null;
  saida: number | null;
  origem: "catalogo" | "tabela_de_preco";
}

/**
 * `pg.Pool` fingido para a consulta do preço. Identifica a consulta pelo nome do
 * CTE — trocar a consulta de preço tem de quebrar alto, e não devolver `undefined`
 * em silêncio. Devolve as linhas cujo id está entre os CANDIDATOS passados, que é
 * o que o `join` do SQL faz do outro lado.
 */
function bancoFalso(linhas: LinhaFalsa[] = []) {
  const consultas: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (!sql.includes("candidatos_de_preco")) return { rows: [] };
    consultas.push(params);
    const ids = new Set((params[0] as string[] | undefined) ?? []);
    return { rows: linhas.filter((l) => ids.has(l.id)) };
  });
  return { db: { query } as never, consultas, query };
}

/** A linha que a instalação da issue tem: `openai/gpt-oss-120b` a 15/60. */
const LINHA_DO_GPT_OSS: LinhaFalsa = {
  id: "openai/gpt-oss-120b",
  provider: "openrouter",
  entrada: 15,
  saida: 60,
  origem: "catalogo",
};

function logEspiao(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => _esquecerPrecosDoCatalogoParaTestes());

describe("a premissa da #3013: a tabela estática do motor não conhece o gpt-oss", () => {
  it("o id do provedor personalizado continua fora da tabela estática", () => {
    // Se este caso ficar vermelho, alguém pôs um preço de gpt-oss na tabela
    // estática — e aí o teste do caminho pelo banco perde o sentido (o defeito
    // deixaria de existir por outro motivo, não por este).
    expect(precoDoModelo("openai/gpt-oss-120b")).toBeUndefined();
    expect(costCents("openai/gpt-oss-120b", USO, "1h")).toBeNull();
  });

  it("o preço do gpt-oss NÃO foi chutado para pricing.ts", () => {
    // O repo não tem preço verificável de gpt-oss (nem em `supabase/`, nem em
    // `lib/`, nem nos scripts de preço). A linha estática nasce quando alguém a
    // MEDIR na fonte — junto com a linha de `ai_pricing`, que o vizinho de
    // paridade cobra. Chutar aqui seria trocar um nulo honesto por um número
    // errado, que é o defeito pior: não acende o sinal de gasto incompleto.
    const fonte = readFileSync(
      join(process.cwd(), "lib", "agent-engine", "edge", "llm", "pricing.ts"),
      "utf8",
    );
    expect(fonte).not.toContain("gpt-oss");
  });
});

describe("🔴 #3013 — o custo do provedor personalizado pelo catálogo da INSTALAÇÃO", () => {
  it("com a linha de preço no banco, a chamada deixa de gravar custo nulo", async () => {
    const { db } = bancoFalso([LINHA_DO_GPT_OSS]);

    const custo = await custoDoModeloForaDoMotor(db, {
      model: "openai/gpt-oss-120b",
      provider: "custom",
      usage: USO,
    });

    // O defeito: `null` aqui era toda chamada paga da instalação.
    expect(custo).not.toBeNull();
    // Centavo FRACIONADO, sem arredondar: 12 mil de entrada a 15¢/M mais 300 de
    // saída a 60¢/M = 0,198 centavo. Arredondar para 1¢ seria 5× o real.
    expect(custo).toBeCloseTo((12_000 * 15 + 300 * 60) / 1_000_000, 12);
    expect(custo).toBeGreaterThan(0);
    expect(custo).toBeLessThan(0.2);
  });

  it("as duas tarifas são lidas separadamente (trocar entrada por saída não passa)", async () => {
    const { db } = bancoFalso([LINHA_DO_GPT_OSS]);
    const preco = await precoDaInstalacao(db, "openai/gpt-oss-120b", "custom");

    expect(preco).toEqual({
      entradaCentsPorMilhao: 15,
      saidaCentsPorMilhao: 60,
      origem: "catalogo",
    });
    // Somadas, as duas dariam o mesmo se 15 e 60 estivessem trocados; isoladas,
    // não. O teto de orçamento sente a diferença.
    expect(custoComPrecoDaInstalacao(preco!, UM_MILHAO)).toBeCloseTo(15, 12);
    expect(
      custoComPrecoDaInstalacao(preco!, { ...UM_MILHAO, inputTokens: 0, outputTokens: 1_000_000 }),
    ).toBeCloseTo(60, 12);
  });

  it("a linha de ai_pricing (sem catálogo) também resolve — é a tabela que o dono mediu", async () => {
    const { db } = bancoFalso([{ ...LINHA_DO_GPT_OSS, provider: null, origem: "tabela_de_preco" }]);

    const preco = await precoDaInstalacao(db, "openai/gpt-oss-120b", "custom");
    expect(preco).toMatchObject({
      entradaCentsPorMilhao: 15,
      saidaCentsPorMilhao: 60,
      origem: "tabela_de_preco",
    });
    expect(
      await custoDoModeloForaDoMotor(db, {
        model: "openai/gpt-oss-120b",
        provider: "custom",
        usage: USO,
      }),
    ).toBeGreaterThan(0);
  });

  it("o catálogo (linha VIVA) vence a cópia de ai_pricing quando as duas existem", async () => {
    const { db } = bancoFalso([
      { ...LINHA_DO_GPT_OSS, entrada: 15, saida: 60, origem: "catalogo" },
      { ...LINHA_DO_GPT_OSS, provider: null, entrada: 99, saida: 999, origem: "tabela_de_preco" },
    ]);

    expect(await precoDaInstalacao(db, "openai/gpt-oss-120b", "custom")).toMatchObject({
      entradaCentsPorMilhao: 15,
      saidaCentsPorMilhao: 60,
      origem: "catalogo",
    });
  });

  it("o provedor da chamada desempata o MESMO id em dois provedores do catálogo", async () => {
    const dois = bancoFalso([
      { ...LINHA_DO_GPT_OSS, provider: "openrouter", entrada: 15, saida: 60 },
      { ...LINHA_DO_GPT_OSS, provider: "requesty", entrada: 10, saida: 50 },
    ]);
    expect(await precoDaInstalacao(dois.db, "openai/gpt-oss-120b", "requesty")).toMatchObject({
      entradaCentsPorMilhao: 10,
    });

    // `custom` não é nenhum dos dois: o desempate cai na ordem de nome, e é
    // DETERMINÍSTICO — o mesmo id não pode cobrar dois preços em dois turnos.
    const semDono = await precoDaInstalacao(dois.db, "openai/gpt-oss-120b", "custom");
    expect(semDono).toMatchObject({ entradaCentsPorMilhao: 15 });
    _esquecerPrecosDoCatalogoParaTestes();
    expect(await precoDaInstalacao(dois.db, "openai/gpt-oss-120b", "custom")).toEqual(semDono);
  });
});

describe("controle negativo — id sem preço continua sem preço inventado", () => {
  it("id que não está em tabela nenhuma devolve null, e não um número", async () => {
    const { db } = bancoFalso([LINHA_DO_GPT_OSS]);

    const custo = await custoDoModeloForaDoMotor(db, {
      model: "provedor-x/modelo-que-nao-existe",
      provider: "custom",
      usage: USO,
    });

    expect(custo).toBeNull();
    expect(typeof custo).not.toBe("number");
  });

  it("o banco CONHECE o id e não tem preço (as duas taxas nulas) → null, nunca 0", async () => {
    const { db } = bancoFalso([{ ...LINHA_DO_GPT_OSS, entrada: null, saida: null }]);

    // Conhecer o modelo e não saber o preço não é melhor que não o conhecer, e
    // devolver 0 aqui declararia "de graça" um modelo que a instalação paga.
    expect(
      await custoDoModeloForaDoMotor(db, {
        model: "openai/gpt-oss-120b",
        provider: "custom",
        usage: USO,
      }),
    ).toBeNull();
  });

  it("0/0 é grátis DE VERDADE e continua sendo 0 — não vira 'desconhecido'", async () => {
    const { db } = bancoFalso([{ ...LINHA_DO_GPT_OSS, entrada: 0, saida: 0 }]);
    expect(
      await custoDoModeloForaDoMotor(db, {
        model: "openai/gpt-oss-120b",
        provider: "custom",
        usage: USO,
      }),
    ).toBe(0);
  });

  it("leitura que falha não derruba a chamada já paga: null, sem exceção", async () => {
    const query = vi.fn(async () => {
      throw new Error('relation "ai_models" does not exist');
    });
    const custo = await custoDoModeloForaDoMotor({ query } as never, {
      model: "openai/gpt-oss-120b",
      provider: "custom",
      usage: USO,
    });
    expect(custo).toBeNull();
  });

  it("a falha da leitura é DITA como falha — não como 'sem preço' — e não é memoizada", async () => {
    let falhar = true;
    const query = vi.fn(async (_sql: string, params: unknown[] = []) => {
      if (falhar) throw new Error("connection terminated unexpectedly");
      const ids = new Set((params[0] as string[] | undefined) ?? []);
      return { rows: [LINHA_DO_GPT_OSS].filter((l) => ids.has(l.id)) };
    });
    const log = logEspiao();
    const entrada = { model: "openai/gpt-oss-120b", provider: "custom", usage: USO, log };

    expect(await custoDoModeloForaDoMotor({ query } as never, entrada)).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toContain("leitura do preço do catálogo falhou");
    expect(log.warn.mock.calls[0]![1]).toMatchObject({
      provider: "custom",
      model: "openai/gpt-oss-120b",
      erro: "connection terminated unexpectedly",
    });

    // O banco voltou: a chamada seguinte lê de novo (a falha não ficou no memo
    // por 5 minutos) e o custo sai.
    falhar = false;
    expect(await custoDoModeloForaDoMotor({ query } as never, entrada)).not.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("a consulta leva UM parâmetro — o SQL só referencia $1 e o Postgres recusa bind a mais", async () => {
    const { db, consultas } = bancoFalso([LINHA_DO_GPT_OSS]);
    await precoDaInstalacao(db, "openai/gpt-oss-120b", "custom");
    expect(consultas).toHaveLength(1);
    expect(consultas[0]).toHaveLength(1);
  });
});

describe("o nulo deixa de ser CALADO — o aviso sai uma vez por (provedor, modelo)", () => {
  it("avisa, e não repete o mesmo aviso em cada chamada do turno", async () => {
    const { db } = bancoFalso([]);
    const log = logEspiao();

    for (let i = 0; i < 3; i++) {
      await custoDoModeloForaDoMotor(db, {
        model: "provedor-x/desconhecido",
        provider: "custom",
        usage: USO,
        log,
      });
    }

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![1]).toEqual({
      provider: "custom",
      model: "provedor-x/desconhecido",
    });
  });

  it("com preço resolvido, aviso nenhum", async () => {
    const { db } = bancoFalso([LINHA_DO_GPT_OSS]);
    const log = logEspiao();
    await custoDoModeloForaDoMotor(db, {
      model: "openai/gpt-oss-120b",
      provider: "custom",
      usage: USO,
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("as tolerâncias de id do motor valem para a consulta ao banco", () => {
  it("sufixo de data e prefixo `provider/` acham a mesma linha", async () => {
    const { db } = bancoFalso([LINHA_DO_GPT_OSS]);
    const esperado = {
      entradaCentsPorMilhao: 15,
      saidaCentsPorMilhao: 60,
      origem: "catalogo" as const,
    };

    // Id com prefixo de roteador + sufixo de data, como `chaveDoModelo` já tolera.
    expect(await precoDaInstalacao(db, "openai/gpt-oss-120b-20250805", "custom")).toEqual(esperado);
    _esquecerPrecosDoCatalogoParaTestes();
    // O mesmo modelo servido por um roteador com o id SEM prefixo.
    const semPrefixo = bancoFalso([{ ...LINHA_DO_GPT_OSS, id: "gpt-oss-120b" } as LinhaFalsa]);
    expect(await precoDaInstalacao(semPrefixo.db, "openai/gpt-oss-120b", "custom")).toEqual(
      esperado,
    );
  });

  it("a ordem dos candidatos começa no id EXATO", () => {
    expect(candidatosDeId("openai/gpt-oss-120b-20250805")).toEqual([
      "openai/gpt-oss-120b-20250805",
      "openai/gpt-oss-120b",
      "gpt-oss-120b-20250805",
      "gpt-oss-120b",
    ]);
  });

  it("as variantes com PONTO trocado por hífen entram no FIM, sem perder as de hoje", () => {
    // Issue #1931: o OpenRouter publica `anthropic/claude-haiku-5.5` e a linha da
    // instalação fica gravada `claude-haiku-5-5`. O id exato continua vencendo — as
    // formas com hífen são o último recurso, não um atalho de prefixo.
    expect(candidatosDeId("anthropic/claude-haiku-5.5")).toEqual([
      "anthropic/claude-haiku-5.5",
      "claude-haiku-5.5",
      "claude-haiku-5-5",
      "anthropic/claude-haiku-5-5",
    ]);
    // Com sufixo de data: o hífen vale também para a forma sem data.
    expect(candidatosDeId("anthropic/claude-haiku-4.5-20251001")).toEqual([
      "anthropic/claude-haiku-4.5-20251001",
      "anthropic/claude-haiku-4.5",
      "claude-haiku-4.5-20251001",
      "claude-haiku-4.5",
      "claude-haiku-4-5-20251001",
      "claude-haiku-4-5",
      "anthropic/claude-haiku-4-5-20251001",
    ]);
  });

  it("o id com PONTO acha a linha do catálogo gravada com hífen", async () => {
    // A linha da instalação: `claude-haiku-5-5` a 10/50 centavos por milhão.
    const linhaDoHaiku: LinhaFalsa = {
      id: "claude-haiku-5-5",
      provider: "openrouter",
      entrada: 10,
      saida: 50,
      origem: "catalogo",
    };
    expect(candidatosDeId("anthropic/claude-haiku-5.5")).toContain("claude-haiku-5-5");
    const { db } = bancoFalso([linhaDoHaiku]);
    expect(await precoDaInstalacao(db, "anthropic/claude-haiku-5.5", "openrouter")).toEqual({
      entradaCentsPorMilhao: 10,
      saidaCentsPorMilhao: 50,
      origem: "catalogo",
    });
  });

  it("o id exato vence a forma sem prefixo quando as duas têm linha", async () => {
    const { db } = bancoFalso([
      { ...LINHA_DO_GPT_OSS, entrada: 15, saida: 60 },
      { ...LINHA_DO_GPT_OSS, id: "gpt-oss-120b", provider: "requesty", entrada: 10, saida: 50 },
    ]);
    expect(await precoDaInstalacao(db, "openai/gpt-oss-120b", "custom")).toMatchObject({
      entradaCentsPorMilhao: 15,
    });
  });
});

describe("uma ida ao banco por (provedor, modelo) dentro do TTL", () => {
  it("a primeira chamada consulta e as seguintes usam o memo", async () => {
    const { db, consultas } = bancoFalso([LINHA_DO_GPT_OSS]);

    await custoDoModeloForaDoMotor(db, {
      model: "openai/gpt-oss-120b",
      provider: "custom",
      usage: USO,
    });
    await custoDoModeloForaDoMotor(db, {
      model: "openai/gpt-oss-120b",
      provider: "custom",
      usage: USO,
    });

    expect(consultas).toHaveLength(1);
  });

  it("o ausente também é memoizado — o modelo sem preço não paga uma query por turno", async () => {
    const { db, consultas } = bancoFalso([]);

    await custoDoModeloForaDoMotor(db, {
      model: "provedor-x/desconhecido",
      provider: "custom",
      usage: USO,
    });
    await custoDoModeloForaDoMotor(db, {
      model: "provedor-x/desconhecido",
      provider: "custom",
      usage: USO,
    });

    expect(consultas).toHaveLength(1);
  });

  it("provedor diferente é outra chave — o memo não mistura preços", async () => {
    const { db, consultas } = bancoFalso([LINHA_DO_GPT_OSS]);
    await precoDaInstalacao(db, "openai/gpt-oss-120b", "custom");
    await precoDaInstalacao(db, "openai/gpt-oss-120b", "openrouter");
    expect(consultas).toHaveLength(2);
  });
});

describe("o preço do catálogo não mexe no custo de quem já tem linha na tabela estática", () => {
  it("o número da tabela estática continua sendo o que o motor cobra", () => {
    // A recíproca do arquivo inteiro: `pricing.ts` segue sendo a PRIMEIRA verdade,
    // e é o `null` dele que dispara o caminho do banco (provado pelo seam, em
    // `tests/unit/custo-do-provedor-personalizado-vem-do-catalogo.test.ts`).
    expect(precoDoModelo("claude-haiku-5-5")).toBeDefined();
    expect(costCents("claude-haiku-5-5", UM_MILHAO, "1h")).toBeCloseTo(10, 12);
  });
});
