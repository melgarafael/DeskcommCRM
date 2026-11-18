import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import type { AvaliacaoDaConversa, MedidaDoPar } from "@/lib/agent-engine/agent/abertura/comparar-fechamentos";
import { esquemaParaOProvedor } from "@/lib/agent-engine/edge/llm/stable-prefix";
import {
  contarAterro,
  CRITERIOS_C,
  CRITERIOS_F5,
  CRITERIOS_G,
  custoDoLote,
  custoDosTokens,
  idNaOpenRouter,
  indicadores,
  jsonPrimeiro,
  juizoDaResposta,
  knobsDoBraco,
  lerVoto,
  nosComPadraoEFormato,
  pedidoDoJuiz,
  precoDaOpenRouter,
  promptDoJuiz,
  provaDoBraco,
  sequencia,
  sondaPassa,
  tokensDoUso,
  validarChamada,
  vereditoC,
  vereditoF5,
  vereditoG,
  type ChamadaGravada,
  type Execucao,
  type Juizo,
  type Sonda,
  type Validade,
} from "@/scripts/lib/avaliacao-de-tokens";

/**
 * O roteiro das avaliações C, F5 e G (docs/runbooks/avaliacoes-de-tokens.md)
 * provado SEM rede e sem banco. A avaliação paga só vale o que este relatório
 * vale: cada caso abaixo é uma das maneiras de ele aprovar o que não devia.
 */

const ESQUEMA = z.object({
  id: z.string().uuid(),
  quando: z.string().datetime({ offset: true }),
  email: z.string().email().optional(),
  n: z.number(),
});
const PEDIDO = new Set(["marcar"]);
const esquemaDe = (nome: string) => (nome === "marcar" ? ESQUEMA : null);
const UUID = "3f2b8c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c";

describe("a validade de cada chamada é a do zod da ferramenta, não a do fio", () => {
  it("separa ok, formato, inválida, JSON quebrado, inexistente e sem referência", () => {
    const v = (nome: string, entrada: unknown) => validarChamada(nome, typeof entrada === "string" ? entrada : JSON.stringify(entrada), new Set([...PEDIDO, "sem_esquema"]), esquemaDe);
    expect(v("marcar", { id: UUID, quando: "2026-11-06T10:30:00-03:00", n: 1 })).toBe("ok");
    expect(v("marcar", { id: "3f2b8c1a-9d4e", quando: "2026-11-06T10:30:00-03:00", n: 1 })).toBe("formato");
    expect(v("marcar", { id: UUID, quando: "2026-11-06 10:30", n: 1 })).toBe("formato");
    expect(v("marcar", { id: UUID, quando: "2026-11-06T10:30:00-03:00", email: "camila.r@gmail", n: 1 })).toBe("formato");
    expect(v("marcar", { id: UUID, quando: "2026-11-06T10:30:00-03:00" })).toBe("invalida");
    expect(v("marcar", "{nao e json")).toBe("json_quebrado");
    expect(v("crm_schedule_followup", {})).toBe("inexistente");
    expect(v("sem_esquema", {})).toBe("sem_referencia");
  });

  it("o fio do braço on não tem pattern ao lado de format, e o do off tem — a prova do braço lê isto", async () => {
    const off = await esquemaParaOProvedor(ESQUEMA, { semPadrao: false });
    const on = await esquemaParaOProvedor(ESQUEMA, { semPadrao: true });
    expect(nosComPadraoEFormato(off)).toBeGreaterThanOrEqual(3);
    expect(nosComPadraoEFormato(on)).toBe(0);
  });

  it("conta uuid de aterro em qualquer profundidade do argumento", () => {
    const aterro = (v: unknown) => v === "00000000-0000-0000-0000-000000000000";
    expect(contarAterro(JSON.stringify({ a: "00000000-0000-0000-0000-000000000000", b: [{ c: "00000000-0000-0000-0000-000000000000" }], d: UUID }), aterro)).toBe(2);
    expect(contarAterro("{quebrado", aterro)).toBe(0);
  });
});

const chamada = (nomes: Array<[string, Validade?]>, over: Partial<ChamadaGravada> = {}): ChamadaGravada => ({
  comFerramentas: true,
  padraoComFormato: 0,
  ferramentas: nomes.map(([nome, validade]) => ({ nome, validade: validade ?? "ok", temFormato: nome !== "send_message", aterro: 0 })),
  tokens: { entrada: 1000, lidos: 0, gravados: 0, saida: 10 },
  custoUsd: 0.001,
  ...over,
});

const execucao = (over: Partial<Execucao> & Pick<Execucao, "braco" | "conversa">): Execucao => ({
  avaliacao: "C",
  modelo: "anthropic:claude-sonnet-5",
  k: 1,
  chamadas: [chamada([["crm_find_free_slots"]], { padraoComFormato: over.braco === "on" ? 0 : 4 }), chamada([["send_message"]])],
  candidatos: ["ok"],
  vetos: [],
  erro: null,
  ...over,
});

describe("o braço C se prova pelo fio", () => {
  it("on com pattern ao lado de format, ou off sem nenhum, derruba a execução", () => {
    expect(provaDoBraco(execucao({ braco: "off", conversa: "c" }))).toBeNull();
    expect(provaDoBraco(execucao({ braco: "on", conversa: "c" }))).toBeNull();
    expect(provaDoBraco(execucao({ braco: "on", conversa: "c", chamadas: [chamada([["x"]], { padraoComFormato: 2 })] }))).toMatch(/knob não chegou/);
    expect(provaDoBraco(execucao({ braco: "off", conversa: "c", chamadas: [chamada([["x"]])] }))).toMatch(/não mandou nenhum pattern/);
    expect(provaDoBraco(execucao({ braco: "off", conversa: "c", chamadas: [chamada([], { comFerramentas: false })] }))).toMatch(/nenhum passo/);
  });

  it("os knobs do braço fixam o outro knob no padrão", () => {
    expect(knobsDoBraco("C", "on")).toEqual({ LLM_TOOL_SCHEMA_SEM_PADRAO: "on", LEAD_CONTEXT_HISTORY_FORMAT: "json" });
    expect(knobsDoBraco("F5", "linhas")).toEqual({ LLM_TOOL_SCHEMA_SEM_PADRAO: "off", LEAD_CONTEXT_HISTORY_FORMAT: "linhas" });
    expect(knobsDoBraco("F5", "json_b")).toEqual(knobsDoBraco("F5", "json"));
    expect(() => knobsDoBraco("C", "linhas")).toThrow(/não é de C/);
  });
});

describe("indicadores e sequência", () => {
  it("funde repetições seguidas e ignora chamadas sem ferramentas (fechamento, classificador)", () => {
    const e = execucao({
      braco: "off",
      conversa: "c",
      chamadas: [chamada([["crm_find_free_slots"], ["send_message"], ["send_message"]]), chamada([], { comFerramentas: false }), chamada([["send_message"]])],
    });
    expect(sequencia(e)).toEqual(["crm_find_free_slots", "send_message"]);
    expect(indicadores(e).passos).toBe(2);
  });

  it("inválida não conta a inexistente, que tem coluna própria", () => {
    const e = execucao({ braco: "on", conversa: "c", chamadas: [chamada([["a", "formato"], ["b", "invalida"], ["c", "inexistente"], ["d", "sem_referencia"]])], vetos: ["v"] });
    expect(indicadores(e)).toMatchObject({ chamadas: 4, invalidas: 3, porFormato: 1, inexistentes: 1, vetos: 1 });
  });
});

describe("veredito C: nenhum indicador sai da banda off×off", () => {
  const conversas = Array.from({ length: 10 }, (_, i) => `C${i}`);
  const lote = (braco: string, k: number, ruim: (cv: string) => boolean = () => false) =>
    conversas.map((cv) =>
      execucao({
        braco,
        k,
        conversa: cv,
        chamadas: [chamada([["crm_find_free_slots", ruim(cv) ? "formato" : "ok"]], { padraoComFormato: braco === "on" ? 0 : 4 }), chamada([["send_message"]])],
      }),
    );
  const baixo = { minimoComFormato: 1 };

  it("on igual ao off aprova", () => {
    const es = [...lote("off", 1), ...lote("off", 2), ...lote("off", 3), ...lote("on", 1), ...lote("on", 2), ...lote("on", 3)];
    expect(vereditoC(es, "anthropic:claude-sonnet-5", baixo).resultado).toBe("aprova");
  });

  it("uma inválida a mais no on, com o off sempre limpo, reprova", () => {
    const es = [...lote("off", 1), ...lote("off", 2), ...lote("off", 3), ...lote("on", 1, (cv) => cv === "C3"), ...lote("on", 2), ...lote("on", 3)];
    const v = vereditoC(es, "anthropic:claude-sonnet-5", baixo);
    expect(v.resultado).toBe("reprova");
    expect(v.motivos.join(" ")).toMatch(/invalidas|porFormato/);
  });

  it("sem ≥2 execuções do off não há banda: inconclusivo", () => {
    expect(vereditoC([...lote("off", 1), ...lote("on", 1)], "anthropic:claude-sonnet-5", baixo).resultado).toBe("inconclusivo");
  });

  it("abaixo do mínimo de chamadas com formato, o que seria aprovação vira inconclusivo", () => {
    const es = [...lote("off", 1), ...lote("off", 2), ...lote("on", 1)];
    expect(CRITERIOS_C.minimoComFormato).toBeGreaterThan(20);
    expect(vereditoC(es, "anthropic:claude-sonnet-5").resultado).toBe("inconclusivo");
  });

  it("execução com erro fica fora (não conta como turno limpo)", () => {
    const es = [...lote("off", 1), ...lote("off", 2), ...lote("on", 1).map((e) => ({ ...e, erro: "prova do braço: x" }))];
    expect(vereditoC(es, "anthropic:claude-sonnet-5", baixo).resultado).toBe("inconclusivo");
  });
});

describe("sondas do F5", () => {
  const s: Sonda = { tipo: "horario", espera: ["15h"], proibe: ["amanhã às 15"] };
  it("sem acento e sem caixa; o proibido vence o esperado; sem resposta não passa", () => {
    expect(sondaPassa(s, ["É hoje às 15h!"])).toBe(true);
    expect(sondaPassa(s, ["É AMANHA AS 15h"])).toBe(false);
    expect(sondaPassa(s, [])).toBe(false);
    expect(sondaPassa({ tipo: "grupo", espera: [], proibe: [] }, ["qualquer"])).toBe(true);
  });
});

describe("o juiz par a par", () => {
  it("a ordem é estável por conversa e o voto volta ao braço certo", () => {
    expect(jsonPrimeiro("S-QD1")).toBe(jsonPrimeiro("S-QD1"));
    const ordens = new Set(Array.from({ length: 20 }, (_, i) => jsonPrimeiro(`c${i}`)));
    expect(ordens.size).toBe(2);
    expect(lerVoto("A", true)).toBe("json");
    expect(lerVoto("b.", true)).toBe("linhas");
    expect(lerVoto("A", false)).toBe("linhas");
    expect(lerVoto("Empate", true)).toBe("empate");
    expect(lerVoto("Prefiro a primeira", true)).toBe("invalido");
  });

  it("o juízo guarda o texto cru e diz por que o voto saiu inválido", () => {
    expect(juizoDaResposta({ text: "B", finishReason: "stop", outputTokens: 912 }, true)).toEqual({
      voto: "linhas",
      texto: "B",
      motivo: null,
      tokensDeSaida: 912,
    });
    // O voto do Sonnet 5 no piloto de 03/11: 1024 tokens de saída (pelo custo), o teto inteiro.
    expect(juizoDaResposta({ text: "", finishReason: "length", outputTokens: 1024 }, true)).toEqual({
      voto: "invalido",
      texto: "",
      motivo: "cortada no teto de saída (1024 tokens) antes de terminar",
      tokensDeSaida: 1024,
    });
    expect(juizoDaResposta({ text: "", finishReason: "stop", outputTokens: 3 }, true).motivo).toBe("resposta vazia (fim: stop)");
    expect(juizoDaResposta({ text: "Prefiro a primeira", finishReason: "stop", outputTokens: 4 }, false)).toMatchObject({
      voto: "invalido",
      texto: "Prefiro a primeira",
      motivo: "a primeira palavra não é A, B nem EMPATE",
    });
  });

  it("o pedido do juiz leva o teto de saída de 4096, e o `julgar` o passa inteiro ao generateText", () => {
    // 4096 = 4× o voto que bateu no teto de 1024 no piloto (ver TETO_DE_SAIDA_DO_JUIZ).
    expect(pedidoDoJuiz("t", "a", "b")).toEqual({ prompt: promptDoJuiz("t", "a", "b"), maxOutputTokens: 4096 });
    // O roteiro roda `main()` ao ser importado, então esta parte lê o fonte: a chamada
    // do juiz espalha o pedido inteiro e não põe outro teto por cima.
    const fonte = readFileSync(join(__dirname, "..", "..", "scripts", "avaliar-tokens.ts"), "utf8");
    const chamada = /generateText\(\{([^}]*)\}\)/.exec(fonte.slice(fonte.indexOf("async function julgar(")))?.[1];
    expect(chamada).toBeDefined();
    expect(chamada).toContain("...pedidoDoJuiz(");
    expect(chamada).not.toContain("maxOutputTokens");
  });
});

describe("veredito F5", () => {
  const sondas = new Map<string, Sonda>([["S1", { tipo: "quem_disse", espera: ["acacias"], proibe: [] }]]);
  const par = (cv: string, over: { json?: Partial<Execucao>; linhas?: Partial<Execucao> } = {}) => [
    execucao({ avaliacao: "F5", braco: "json", conversa: cv, chamadas: [chamada([["send_message"]])], candidatos: ["Rua das Acácias, 120"], ...over.json }),
    execucao({ avaliacao: "F5", braco: "linhas", conversa: cv, chamadas: [chamada([["send_message"]])], candidatos: ["Rua das Acácias, 120"], ...over.linhas }),
  ];
  const juizos = (votos: Array<Juizo["voto"]>): Juizo[] => votos.map((voto, i) => ({ modelo: "anthropic:claude-sonnet-5", conversa: `c${i}`, voto, custoUsd: 0 }));
  const baixo = { ...CRITERIOS_F5, minimoDePares: 1 };
  const m = "anthropic:claude-sonnet-5";

  it("tudo igual e juiz empatado aprova", () => {
    expect(vereditoF5([...par("S1"), ...par("x")], juizos(["empate", "empate"]), sondas, m, baixo).resultado).toBe("aprova");
  });

  it("a sonda que o json passa e o linhas não reprova", () => {
    const v = vereditoF5(par("S1", { linhas: { candidatos: ["Av. Brasil, 900"] } }), juizos(["empate"]), sondas, m, baixo);
    expect(v.resultado).toBe("reprova");
    expect(v.motivos.join(" ")).toMatch(/sonda quem_disse/);
  });

  it("mais turnos com veto no linhas reprova", () => {
    expect(vereditoF5(par("x", { linhas: { vetos: ["human_promise_without_handoff"] } }), juizos(["empate"]), sondas, m, baixo).resultado).toBe("reprova");
  });

  it("sequência diferente em mais de 5% dos pares reprova, e o A/A só informa", () => {
    const es = [...par("a"), ...par("b", { linhas: { chamadas: [chamada([["save_lead_note"], ["send_message"]])] } })];
    const v = vereditoF5(es, juizos(["empate", "empate"]), sondas, m, baixo);
    expect(v.resultado).toBe("reprova");
    expect(v.motivos.join(" ")).toMatch(/sequência/);
  });

  it("o juiz preferindo o json com folga reprova", () => {
    const es = Array.from({ length: 20 }, (_, i) => par(`c${i}`)).flat();
    expect(vereditoF5(es, juizos(Array(20).fill("json")), sondas, m, baixo).resultado).toBe("reprova");
  });

  it("abaixo do mínimo de pares (60, o do desenho), aprovação vira inconclusivo", () => {
    expect(CRITERIOS_F5.minimoDePares).toBe(60);
    expect(vereditoF5(par("x"), juizos(["empate"]), sondas, m).resultado).toBe("inconclusivo");
  });
});

describe("veredito G: não-inferioridade da sombra contra o controle", () => {
  const medida = (over: Partial<MedidaDoPar> = {}): MedidaDoPar => ({
    promessas_atual: 1,
    promessas_braco: 1,
    promessas_em_comum: 1,
    prazos_atual: 1,
    prazos_em_comum: 1,
    intencoes_atual: 1,
    intencoes_braco: 1,
    intencoes_em_comum: 1,
    nada_atual: false,
    nada_braco: false,
    declaracao_ausente_atual: false,
    declaracao_ausente_braco: false,
    next_nulo_atual: false,
    next_nulo_braco: false,
    entidades_anteriores: 3,
    retidas_atual: 3,
    retidas_braco: 3,
    similaridade_resumo: 0.8,
    ...over,
  });
  const conversa = (i: number, sombra: MedidaDoPar, formato: "ok" | "recusado" = "ok"): AvaliacaoDaConversa => ({
    conversa: `g${i}`,
    atual: { modelo: "claude-sonnet-5", formato: "ok" },
    bracos: [
      { braco: "controle", modelo: "claude-sonnet-5", formato: "ok", medida: medida() },
      { braco: "sombra", modelo: "claude-haiku-5-5", formato, medida: formato === "ok" ? sombra : null },
    ],
  });
  const baixo = { ...CRITERIOS_G, minimos: { promessas: 1, prazos: 1, intencoes: 1, comAnterior: 1, turnos: 1 } };

  it("sombra igual ao controle aprova", () => {
    expect(vereditoG(Array.from({ length: 50 }, (_, i) => conversa(i, medida())), baixo).resultado).toBe("aprova");
  });

  it("sombra que perde promessas reprova", () => {
    const v = vereditoG(Array.from({ length: 50 }, (_, i) => conversa(i, medida({ promessas_em_comum: i % 4 === 0 ? 0 : 1 }))), baixo);
    expect(v.resultado).toBe("reprova");
    expect(v.motivos.join(" ")).toMatch(/promessas/);
  });

  it("recusado da sombra acima de 3% reprova", () => {
    expect(vereditoG(Array.from({ length: 50 }, (_, i) => conversa(i, medida(), i < 5 ? "recusado" : "ok")), baixo).resultado).toBe("reprova");
  });

  it("com os mínimos do desenho, 50 conversas são inconclusivas e o que não foi medido é dito", () => {
    const v = vereditoG(Array.from({ length: 50 }, (_, i) => conversa(i, medida())));
    expect(v.resultado).toBe("inconclusivo");
    expect(v.motivos.join(" ")).toMatch(/turnos \(pares válidos\): 50, o mínimo é 300/);
    expect(v.linhas.join(" ")).toMatch(/NÃO medido offline/);
  });
});

describe("preço e custo", () => {
  const CATALOGO = {
    data: [
      { id: "anthropic/claude-sonnet-4.6", pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", input_cache_write: "0.00000375", input_cache_write_1h: "0.000006" } },
      { id: "openai/gpt-5.6-luna", pricing: { prompt: "0.0000002", completion: "0.0000012", input_cache_read: "0.00000002" } },
    ],
  };

  it("o id da OpenRouter sai do provedor:modelo do motor", () => {
    expect(idNaOpenRouter("anthropic", "claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4.6");
    expect(idNaOpenRouter("anthropic", "claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(idNaOpenRouter("anthropic", "claude-haiku-5-5")).toBe("anthropic/claude-haiku-5.5");
    expect(idNaOpenRouter("openai", "gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
    expect(idNaOpenRouter("openrouter", "anthropic/claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
  });

  it("grava pelo preço de 1 hora quando existe; sem preço publicado, lança", () => {
    expect(precoDaOpenRouter(CATALOGO, "anthropic/claude-sonnet-4.6")).toEqual({ entrada: 3e-6, saida: 1.5e-5, leitura: 3e-7, gravacao: 6e-6 });
    expect(precoDaOpenRouter(CATALOGO, "openai/gpt-5.6-luna").gravacao).toBe(2e-7);
    expect(() => precoDaOpenRouter(CATALOGO, "openai/gpt-9")).toThrow(/não publica preço/);
  });

  it("lê o uso do V3 (objetos) e do V2 (números)", () => {
    expect(tokensDoUso({ inputTokens: { total: 1000, noCache: 200, cacheRead: 700, cacheWrite: 100 }, outputTokens: { total: 50 } })).toEqual({ entrada: 1000, lidos: 700, gravados: 100, saida: 50 });
    expect(tokensDoUso({ inputTokens: 1000, outputTokens: 50, cachedInputTokens: 400 })).toEqual({ entrada: 1000, lidos: 400, gravados: 0, saida: 50 });
    expect(tokensDoUso(undefined)).toEqual({ entrada: 0, lidos: 0, gravados: 0, saida: 0 });
    const p = precoDaOpenRouter(CATALOGO, "anthropic/claude-sonnet-4.6");
    expect(custoDosTokens({ entrada: 1000, lidos: 700, gravados: 100, saida: 50 }, p)).toBeCloseTo(200 * 3e-6 + 700 * 3e-7 + 100 * 6e-6 + 50 * 1.5e-5, 12);
  });

  it("no lote com cache, só o 1º pedido de cada prefixo grava; sem cache, tudo cheio; o fator escala a entrada", () => {
    const p = { entrada: 1, saida: 10, leitura: 0.1, gravacao: 2 };
    const cs = [
      { prefixo: 100, chavePrefixo: "a", resto: 10, saida: 1 },
      { prefixo: 100, chavePrefixo: "a", resto: 10, saida: 1 },
      { prefixo: 100, chavePrefixo: "b", resto: 10, saida: 1 },
    ];
    expect(custoDoLote(cs, p, true)).toBeCloseTo(100 * 2 + 10 + 100 * 0.1 + 10 + 100 * 2 + 10 + 30, 9);
    expect(custoDoLote(cs, p, false)).toBeCloseTo(3 * 110 + 30, 9);
    expect(custoDoLote(cs, p, false, 2)).toBeCloseTo(3 * 220 + 30, 9);
  });
});
