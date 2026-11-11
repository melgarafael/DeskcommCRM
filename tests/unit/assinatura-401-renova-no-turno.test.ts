/**
 * O 401 DO TURNO RENOVE, RELÊA A CREDENCIAL E REPETE COM O TOKEN NOVO (#3371, fatia 4 + #4361).
 *
 * ## O que aconteceu em produção
 *
 * `chamarComRetryUnicoEm401` existia em `lib/ai/pontos/renovacao-da-assinatura.ts`
 * desde a fiação da assinatura e **não tinha chamador de produção** — só os
 * testes dele (`tests/unit/provedor-assinatura-login-pkce.test.ts`). No cliente
 * Obralivre, o `401 · Provided authentication token is expired` apareceu em 107
 * turnos seguidos: cada turno caía na política de reserva sem NUNCA tentar
 * renovar, e a IA ficou ~26 h calada com cota sobrando.
 *
 * ## O defeito que a fatia 4 deixou passar (#4361)
 *
 * O teste antigo CONTAVA duas chamadas mas não conferia QUAL TOKEN a segunda
 * enviou. E o seam renovava no banco e repetia com o MESMO `cfgUsada` — a 2ª
 * tentativa saía com o access_token que acabou de dar 401, tanto com renovação
 * bem-sucedida quanto com `em_curso` (a trava de 30 s de outro processo em
 * `renovarComTravaDeBanco`, que a repetição imediata não esperava). Com
 * renovação RECUSADA, a repetição era mantida: um POST certo de 401 com o token
 * morto. O conserto: reler a credencial e só repetir com o token NOVO; em
 * `em_curso`, esperar o dono da trava gravar; sem token novo, desistir com o
 * motivo — sem insistir.
 *
 * ## O que este arquivo prova
 *
 *  1. `401 → renova → relê → 200`: a 1ª tentativa envia o token velho, a 2ª
 *     envia o NOVO (a fábrica dublê grava o `apiKey` de cada POST).
 *  2. `em_curso`: o turno ESPERA a renovação de quem tem a trava (releitura em
 *     tentativas) e repete com o token do vencedor — sem abrir aviso de conta.
 *  3. `em_curso` sem token novo ao fim da espera: desiste, UM POST só.
 *  4. Renovação RECUSADA: não insiste — UM POST só e o aviso na Central.
 *  5. Releitura devolvendo o MESMO token: desiste com o motivo, UM POST só.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamText } from "ai";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  lerLoginCodex,
  lerLoginCodexRenovandoSeProxima,
  renovarAssinaturaNoTurno,
} from "@/lib/ai/credenciais/login-codex";
import { chamarComRetryUnicoEm401 } from "@/lib/ai/pontos/renovacao-da-assinatura";
import { sincronizarAvisoDaAssinatura } from "@/lib/ai/credenciais/aviso-da-assinatura";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: () => () => false,
  asSchema: vi.fn(),
  tool: (t: unknown) => t,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/ai/credenciais/aviso-da-assinatura", () => ({
  sincronizarAvisoDaAssinatura: vi.fn(async () => "aberto"),
}));
vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  lerLoginCodexRenovandoSeProxima: vi.fn(async () => ({
    access_token: "token-de-assinatura-de-teste",
    refresh_token: "refresh-de-teste",
    expires_at: Date.now() + 60_000,
  })),
  // A RELEITURA da credencial depois da renovação (#4361). Default: o par já
  // RENOVA DO — quem quiser o caminho da desistência (mesmo token) sobrescreve
  // no próprio teste.
  lerLoginCodex: vi.fn(),
  renovarAssinaturaNoTurno: vi.fn(),
  JANELA_DA_TRAVA_MS: 30_000,
}));

const ORG = "33333333-3333-4333-8333-333333333333";
const TOKEN_VELHO = "token-de-assinatura-de-teste";
const TOKEN_NOVO = "at-renovado";

/** Um par de tokens no formato que `lerLoginCodex` devolve. */
function par(access_token: string) {
  return {
    access_token,
    refresh_token: "refresh-de-teste",
    client_id: "cid-de-teste",
    scopes: ["chatgpt.tokens.use.direct"],
    expires_at: Date.now() + 3_600_000,
  } as never;
}

/** O erro que o provedor devolve: 401 com sinal de expiração. */
function erro401(): Error {
  return Object.assign(new Error("Provided authentication token is expired"), {
    statusCode: 401,
    name: "AI_APICallError",
  });
}

function poolDaAssinatura() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "openai-assinatura",
              default_model: "gpt-5.6-luna",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    // Sem chave `openai` cadastrada: não há reserva para onde cair — é o cenário
    // do cliente que ficou sem resposta.
    if (sql.includes("from ai_provider_credentials")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-401" }] };
    return { rows: [] };
  });
  return { query } as never;
}

/**
 * O TOKEN que cada POST levou. A fábrica do registry recebe o `apiKey` que o
 * seam montou, e é ele que o provedor manda no `Authorization`. Registrar aqui
 * é conferir, por baixo do SDK, qual credencial cada tentativa enviou — o
 * buraco que deixou o #4361 passar era exatamente a contagem de chamadas sem
 * esta conferência.
 */
const tokensPorTentativa: string[] = [];

const registry = {
  "openai-assinatura": (apiKey: string) => {
    tokensPorTentativa.push(apiKey);
    return {
      specificationVersion: "v3",
      provider: "openai-assinatura",
      modelId: "gpt-5.6-luna",
      doGenerate: async () => {
        throw new Error("SENTINELA: o ramo da assinatura usou generateText");
      },
      doStream: async () => {
        throw new Error("SENTINELA: o stream foi consumido fora do dublê");
      },
    } as never;
  },
} as never;

function respostaBoa() {
  return {
    text: Promise.resolve("Estamos abertos das 9h às 18h."),
    usage: Promise.resolve({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
    response: Promise.resolve({ id: "resp-1", modelId: "gpt-5.6-luna" }),
    steps: Promise.resolve([]),
    responseMessages: Promise.resolve([]),
    toolCalls: Promise.resolve([]),
    finishReason: Promise.resolve("stop"),
  };
}

function respostaRecusada(erro: Error) {
  return {
    ...respostaBoa(),
    text: Promise.reject(erro),
  };
}

/**
 * O dublê do stream com um roteiro: a n-ésima chamada devolve o que o roteiro
 * manda. É o que permite "401 na primeira, 200 na segunda" sem inventar estado
 * fora do seam.
 */
function roteiroDoProvedor(passos: Array<"ok" | "401">) {
  let indice = 0;
  const erro = erro401();
  vi.mocked(streamText).mockImplementation(((opcoes: { onError?: (a: { error: unknown }) => void }) => {
    const passo = passos[indice] ?? "ok";
    indice += 1;
    if (passo === "401") {
      // O SDK entrega o erro original ao callback; é ele que o seam relança.
      opcoes.onError?.({ error: erro });
      return respostaRecusada(erro) as never;
    }
    return respostaBoa() as never;
  }) as never);
  return () => indice;
}

/** Os avisos do turno, para asserções sobre o motivo da desistência. */
let errosDoTurno: Array<{ msg: string; campos?: Record<string, unknown> }>;
let avisosDoTurno: Array<{ msg: string; campos?: Record<string, unknown> }>;

async function rodar() {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (msg: string, campos?: Record<string, unknown>) => avisosDoTurno.push({ msg, campos }),
    error: (msg: string, campos?: Record<string, unknown>) => errosDoTurno.push({ msg, campos }),
  };
  return runModelCall(
    poolDaAssinatura(),
    { anthropicApiKey: "chave...te", openaiApiKey: "chave...te", cacheTtl: "1h" },
    {
      tenantId: ORG,
      purpose: "agent_turn",
      messages: [{ role: "user", content: "que horas abrem?" }],
    },
    {
      registry,
      log: log as never,
      // A espera do `em_curso` não pode custar 1 s REAL por espiada no teste —
      // é o único motivo deste dublê (o mesmo relógio injetável de `agora`).
      dormir: async () => undefined,
    },
  );
}

beforeEach(() => {
  tokensPorTentativa.length = 0;
  errosDoTurno = [];
  avisosDoTurno = [];
  vi.mocked(streamText).mockReset();
  vi.mocked(renovarAssinaturaNoTurno).mockReset();
  vi.mocked(renovarAssinaturaNoTurno).mockResolvedValue({
    ok: true,
    tokens: {
      access_token: TOKEN_NOVO,
      refresh_token: "rt-renovado",
      expires_at: Date.now() + 3_600_000,
    },
  });
  vi.mocked(lerLoginCodexRenovandoSeProxima).mockClear();
  vi.mocked(lerLoginCodex).mockReset();
  vi.mocked(lerLoginCodex).mockResolvedValue(par(TOKEN_NOVO));
  vi.mocked(sincronizarAvisoDaAssinatura).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("401 → renova → 200: o turno é entregue com o token NOVO", () => {
  it("⭐ dois POSTs, UMA renovação, e a resposta chega", async () => {
    roteiroDoProvedor(["401", "ok"]);

    const resultado = await rodar();

    expect(vi.mocked(renovarAssinaturaNoTurno), "o 401 não renovou nada").toHaveBeenCalledTimes(1);
    expect(vi.mocked(renovarAssinaturaNoTurno).mock.calls[0]?.[0]).toMatchObject({ orgId: ORG });
    expect(vi.mocked(streamText), "não repetiu a chamada depois de renovar").toHaveBeenCalledTimes(2);
    expect(resultado.result.text).toBe("Estamos abertos das 9h às 18h.");
    expect(resultado.provider).toBe("openai-assinatura");
  });

  it("⭐ a 2ª tentativa sai com o token RENOVADO, não com o que deu 401 (#4361)", async () => {
    roteiroDoProvedor(["401", "ok"]);

    await rodar();

    // A prova que faltava: não basta CONTAR duas chamadas — é preciso conferir
    // qual credencial cada uma levou. Sem isto, o repeat-com-token-velho passava
    // no teste verde e derrubava o turno na rua.
    expect(tokensPorTentativa, "cada tentativa deve sair por um POST").toHaveLength(2);
    expect(tokensPorTentativa[0], "a 1ª tentativa deve sair com o token em uso").toBe(TOKEN_VELHO);
    expect(tokensPorTentativa[1], "a 2ª tentativa repetiu o token que acabou de dar 401").toBe(TOKEN_NOVO);
  });

  it("a credencial é RELIDA antes da repetição (#4361)", async () => {
    roteiroDoProvedor(["401", "ok"]);

    await rodar();

    expect(vi.mocked(lerLoginCodex), "repetiu sem reler a credencial").toHaveBeenCalledTimes(1);
    expect(vi.mocked(lerLoginCodex).mock.calls[0]?.[0]).toMatchObject({ orgId: ORG });
  });

  it("⭐ releitura devolvendo o MESMO token: não insiste — UM POST só, com o motivo (#4361)", async () => {
    roteiroDoProvedor(["401", "401"]);
    // A renovação devolveu `ok`, mas a credencial no banco continua com o mesmo
    // access_token (a gravação não apareceu na leitura). Repetir seria o segundo
    // POST certo de 401 que o issue manda não fazer.
    vi.mocked(lerLoginCodex).mockResolvedValue(par(TOKEN_VELHO));

    await expect(rodar()).rejects.toThrow("Provided authentication token is expired");

    expect(vi.mocked(streamText), "insistiu com o token que a releitura confirmou velho").toHaveBeenCalledTimes(1);
    expect(tokensPorTentativa).toEqual([TOKEN_VELHO]);
    // A desistência tem nome no log do turno — senão a rua fica muda de novo.
    expect(
      avisosDoTurno.some((a) => a.campos?.motivo === "releitura_sem_token_novo"),
      "a desistência não saiu no log com o motivo",
    ).toBe(true);
  });
});

describe("em_curso: o turno ESPERA a renovação de quem tem a trava (#4361)", () => {
  it("⭐ relê até o vencedor gravar o token novo, e repete com ELE", async () => {
    vi.mocked(renovarAssinaturaNoTurno).mockResolvedValue({ ok: false, motivo: "em_curso" });
    roteiroDoProvedor(["401", "ok"]);
    // O dono da trava ainda não gravou na 1ª espiada; na espiada seguinte, gravou.
    vi.mocked(lerLoginCodex)
      .mockResolvedValueOnce(par(TOKEN_VELHO))
      .mockResolvedValueOnce(par("at-do-vencedor"));

    const resultado = await rodar();

    expect(resultado.result.text).toBe("Estamos abertos das 9h às 18h.");
    expect(vi.mocked(lerLoginCodex), "não esperou a renovação em curso").toHaveBeenCalledTimes(2);
    expect(tokensPorTentativa[0]).toBe(TOKEN_VELHO);
    expect(tokensPorTentativa[1], "a 2ª tentativa não esperou o token do vencedor").toBe("at-do-vencedor");
    // Esperar não é reconectar: a conta está boa, só havia uma trava em curso.
    expect(vi.mocked(sincronizarAvisoDaAssinatura), "em_curso virou aviso de conta").not.toHaveBeenCalled();
  });

  it("⭐ esgotada a espera sem token novo: desiste com o motivo, UM POST só", async () => {
    vi.mocked(renovarAssinaturaNoTurno).mockResolvedValue({ ok: false, motivo: "em_curso" });
    roteiroDoProvedor(["401", "401"]);
    // O dono da trava nunca chegou a gravar nada de novo nesta espera.
    vi.mocked(lerLoginCodex).mockResolvedValue(par(TOKEN_VELHO));

    await expect(rodar()).rejects.toThrow("Provided authentication token is expired");

    expect(vi.mocked(streamText), "repetiu com o token velho depois de esperar à toa").toHaveBeenCalledTimes(1);
    expect(tokensPorTentativa).toEqual([TOKEN_VELHO]);
    expect(
      avisosDoTurno.some((a) => a.campos?.motivo === "em_curso_sem_token_novo"),
      "a espera esgotada não saiu no log com o motivo",
    ).toBe(true);
  });

  it("⭐ `em_curso` (outro processo renovando) NÃO abre aviso de conta desconectada", async () => {
    vi.mocked(renovarAssinaturaNoTurno).mockResolvedValue({ ok: false, motivo: "em_curso" });
    roteiroDoProvedor(["401", "401"]);
    vi.mocked(lerLoginCodex).mockResolvedValue(par(TOKEN_VELHO));

    await expect(rodar()).rejects.toThrow();

    // A conta não desconectou: só a trava estava com outro processo.
    expect(vi.mocked(sincronizarAvisoDaAssinatura)).not.toHaveBeenCalled();
  });
});

describe("401 → renova → 401: dois POSTs e ponto (sem laço)", () => {
  it("⭐ a chamada falha DEPOIS de uma renovação e de uma repetição — nunca uma terceira", async () => {
    roteiroDoProvedor(["401", "401"]);

    await expect(rodar()).rejects.toThrow("Provided authentication token is expired");

    expect(vi.mocked(renovarAssinaturaNoTurno)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamText), "insistiu além do retry único").toHaveBeenCalledTimes(2);
    // Mesmo no 401 duplo, a 2ª tentativa é com o token NOVO: a recusa da segunda
    // tentativa precisa ser do estado do provedor, não de um token velho repetido.
    expect(tokensPorTentativa).toEqual([TOKEN_VELHO, TOKEN_NOVO]);
  });

  it("⭐ a recusa VIRA aviso na Central, com o motivo — não fica só no log", async () => {
    vi.mocked(renovarAssinaturaNoTurno).mockResolvedValue({
      ok: false,
      motivo: "falha",
      motivoDetalhe: "refresh_token_revoked",
    });
    roteiroDoProvedor(["401", "401"]);

    await expect(rodar()).rejects.toThrow();

    // A Central de avisos do cliente Obralivre ficou VAZIA em ~26 h de 401. O
    // turno que falha é quem abre o item — e o motivo vem da fatia 3.
    expect(vi.mocked(sincronizarAvisoDaAssinatura), "a recusa não virou aviso").toHaveBeenCalledTimes(1);
    expect(vi.mocked(sincronizarAvisoDaAssinatura).mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG,
      conectada: false,
      recusa: "falha:refresh_token_revoked",
    });
  });
});

describe("renovação RECUSADA: não insiste (#4361)", () => {
  it("⭐ recusa de login = UM POST só, o erro com o motivo, sem segundo 401 garantido", async () => {
    vi.mocked(renovarAssinaturaNoTurno).mockResolvedValue({
      ok: false,
      motivo: "falha",
      motivoDetalhe: "refresh_token_revoked",
    });
    roteiroDoProvedor(["401", "401"]);

    await expect(rodar()).rejects.toThrow("Provided authentication token is expired");

    expect(vi.mocked(renovarAssinaturaNoTurno)).toHaveBeenCalledTimes(1);
    // A asserção mudou de 2 POSTs para 1 COM O CONSENTIMENTO DO ISSUE #4361:
    // "se a releitura devolver o mesmo token, não insistir e devolver o erro
    // com o motivo". Repetir com um token que a renovação ACABOU DE RECUSAR é
    // o POST certo de 401 que o issue manda não fazer — não é afrouxamento.
    expect(vi.mocked(streamText), "insistiu depois de recusa de renovação").toHaveBeenCalledTimes(1);
    expect(tokensPorTentativa).toEqual([TOKEN_VELHO]);
    // O motivo da desistência sai no log do turno.
    expect(
      avisosDoTurno.some((a) => a.campos?.motivo === "renovacao_recusada"),
      "a desistência por recusa não saiu no log com o motivo",
    ).toBe(true);
  });
});

describe("o contrato do retry único, na função que agora tem chamador", () => {
  it("devolve `tentativas: 2` nos DOIS desfechos", async () => {
    const renovar = vi.fn(async () => undefined);

    const primeiro200 = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, corpo: "recusado" })
      .mockResolvedValueOnce({ status: 200, corpo: "ok" });
    expect(await chamarComRetryUnicoEm401({ tentar: primeiro200, renovarApos401: renovar })).toEqual({
      status: 200,
      corpo: "ok",
      tentativas: 2,
    });

    const dois401 = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, corpo: "recusado" })
      .mockResolvedValueOnce({ status: 401, corpo: "recusado de novo" });
    expect(await chamarComRetryUnicoEm401({ tentar: dois401, renovarApos401: renovar })).toEqual({
      status: 401,
      corpo: "recusado de novo",
      tentativas: 2,
    });

    // Um status que não é 401 não gasta renovação nem repetição.
    const outroErro = vi.fn().mockResolvedValue({ status: 500, corpo: "fora do ar" });
    expect(await chamarComRetryUnicoEm401({ tentar: outroErro, renovarApos401: renovar })).toEqual({
      status: 500,
      corpo: "fora do ar",
      tentativas: 1,
    });
    expect(renovar).toHaveBeenCalledTimes(2);
  });

  it("⭐ renovação que responde `repetir: false` devolve o PRIMEIRO erro com o motivo, sem segundo POST", async () => {
    const tentar = vi.fn(async () => ({ status: 401, corpo: "recusado" }));
    const renovarApos401 = vi.fn(async () => ({ repetir: false as const, motivo: "em_curso_sem_token_novo" }));

    const resultado = await chamarComRetryUnicoEm401({ tentar, renovarApos401 });

    expect(resultado).toEqual({
      status: 401,
      corpo: "recusado",
      tentativas: 1,
      motivoDaRenovacao: "em_curso_sem_token_novo",
    });
    expect(tentar).toHaveBeenCalledTimes(1);
  });
});
