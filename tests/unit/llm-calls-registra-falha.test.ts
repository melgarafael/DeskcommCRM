/**
 * A FALHA DEIXA RASTRO — o buraco que fazia o log de IA mentir por omissão.
 *
 * `llm_calls` gravava uma linha por chamada de modelo, e só quando dava certo:
 * o INSERT vivia depois do `generateText`, sem `try` em volta. Provedor recusou
 * a chave, modelo não existe, conta sem saldo? A exceção subia e nada ficava
 * gravado.
 *
 * O efeito é pior que "faltar dado": a tabela que deveria explicar era
 * justamente a que ficava vazia no caso que precisa de explicação. O operador
 * abria o painel de uso, via o mês inteiro sem uma linha vermelha, e concluía
 * que a IA estava funcionando — enquanto o agente não respondia ninguém.
 *
 * Este arquivo prova as três coisas que a correção precisa garantir: que a
 * linha de erro é gravada, que o erro CONTINUA subindo para quem chamou, e que
 * a classificação distingue os três problemas que exigem conversas diferentes
 * com quem instalou (chave, saldo, indisponibilidade).
 */
import { describe, expect, it, vi } from "vitest";

import { redigirMensagemDoProvedor, runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

const ORG = "22222222-2222-4222-8222-222222222222";

function poolQueGrava() {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "anthropic",
              default_model: "claude-padrao",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("from ai_provider_credentials")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

/** Registry cuja fábrica devolve um modelo que SEMPRE falha do jeito pedido. */
function registryQueFalha(erro: unknown) {
  const fabrica = () =>
    ({
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: "claude-padrao",
      doGenerate: async () => {
        throw erro;
      },
    }) as never;
  return { anthropic: fabrica, openai: fabrica, google: fabrica, openrouter: fabrica };
}

/**
 * A chave precisa ser um sentinela IMPROVÁVEL. A primeira versão deste arquivo
 * usava "k", e o teste de vazamento falhava sempre — a letra "k" aparece em
 * qualquer JSON ("sql", "task"…). Um sentinela curto transforma o teste de
 * vazamento em ruído, e o reflexo seguinte seria afrouxá-lo até parar de
 * incomodar, que é como uma guarda de segredo morre.
 */
const CHAVE_SENTINELA = "sk-CHAVE-QUE-NUNCA-PODE-VAZAR-9f3a2b";
const cfg = { anthropicApiKey: CHAVE_SENTINELA, cacheTtl: "1h" as const };

async function chamarComErro(erro: unknown) {
  const { pool, inserts } = poolQueGrava();
  let lancou: unknown = null;
  try {
    await runModelCall(
      pool,
      cfg,
      { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
      { registry: registryQueFalha(erro) },
    );
  } catch (e) {
    lancou = e;
  }
  const linhaDeErro = inserts.find((i) => i.sql.includes("'erro'"));
  return { inserts, lancou, linhaDeErro };
}

describe("a chamada que falha vira linha no log", () => {
  it("grava uma linha em llm_calls quando o provedor recusa", async () => {
    const { linhaDeErro } = await chamarComErro(new Error("401 Unauthorized: invalid api key"));
    expect(
      linhaDeErro,
      "provedor recusou e nada foi gravado — é o buraco original, não uma regressão qualquer",
    ).toBeDefined();
    expect(linhaDeErro!.params).toContain(ORG);
    expect(linhaDeErro!.params).toContain("agent_turn");
  });

  it("o erro CONTINUA subindo para quem chamou", async () => {
    // Gravar e engolir trocaria uma falha invisível por uma silenciosa, que é
    // pior: o worker acharia que o turno deu certo e não reagendaria.
    const { lancou } = await chamarComErro(new Error("401 Unauthorized"));
    expect(lancou).toBeInstanceOf(Error);
  });

  it("não grava linha de SUCESSO quando falhou", async () => {
    // Duas linhas por chamada inflariam o contador de uso e o teto de
    // orçamento passaria a disparar antes da hora.
    const { inserts } = await chamarComErro(new Error("boom"));
    expect(inserts.filter((i) => i.sql.includes("'ok'"))).toHaveLength(0);
    expect(inserts).toHaveLength(1);
  });

  it("não cobra tokens nem custo de uma chamada que não aconteceu", async () => {
    const { linhaDeErro } = await chamarComErro(new Error("boom"));
    // input_tokens/output_tokens são zero literais no SQL; o custo é null —
    // "não sei" e não "de graça", a mesma doutrina de cost_cents.
    expect(linhaDeErro!.sql).toMatch(/0, 0, 0, 0, null/);
  });
});

describe("a classificação separa os problemas que exigem conversas diferentes", () => {
  const codigoDe = async (erro: unknown): Promise<string> => {
    const { linhaDeErro } = await chamarComErro(erro);
    // O código é o 9º parâmetro do insert de falha (ver registrarFalha).
    return String(linhaDeErro!.params[8]);
  };

  it("chave recusada", async () => {
    expect(await codigoDe(new Error("401 Unauthorized"))).toBe("credencial_recusada");
    expect(await codigoDe(new Error("invalid api key provided"))).toBe("credencial_recusada");
    expect(await codigoDe(Object.assign(new Error("nope"), { statusCode: 403 }))).toBe(
      "credencial_recusada",
    );
  });

  it("modelo que não existe", async () => {
    expect(await codigoDe(new Error("model not found: gpt-9"))).toBe("modelo_inexistente");
    expect(await codigoDe(Object.assign(new Error("x"), { statusCode: 404 }))).toBe(
      "modelo_inexistente",
    );
  });

  it("limite ou saldo", async () => {
    expect(await codigoDe(new Error("rate limit exceeded"))).toBe("limite_ou_saldo");
    expect(await codigoDe(new Error("insufficient credits"))).toBe("limite_ou_saldo");
    expect(await codigoDe(Object.assign(new Error("x"), { statusCode: 429 }))).toBe(
      "limite_ou_saldo",
    );
  });

  it("provedor fora do ar", async () => {
    expect(await codigoDe(Object.assign(new Error("x"), { statusCode: 503 }))).toBe(
      "provedor_indisponivel",
    );
    expect(await codigoDe(new Error("fetch failed"))).toBe("provedor_indisponivel");
  });

  it("o que não se encaixa vira desconhecido, e não um chute", async () => {
    // Classificar tudo em algum balde conhecido seria pior que admitir que não
    // sabemos: o operador seguiria a instrução errada com confiança.
    expect(await codigoDe(new Error("algo completamente inesperado"))).toBe("erro_desconhecido");
  });

  it("provedores diferentes com o MESMO problema recebem o mesmo código", async () => {
    // É a razão de existir a normalização: sem ela a tela mostraria
    // "AI_APICallError" para um e "401 Unauthorized" para outro, e a pessoa não
    // saberia que os dois são o mesmo problema — a chave.
    const anthropic = await codigoDe(new Error("authentication_error: invalid x-api-key"));
    const openai = await codigoDe(Object.assign(new Error("Incorrect API key"), { status: 401 }));
    expect(anthropic).toBe(openai);
  });
});

describe("o que NUNCA pode entrar no log", () => {
  it("remove chaves ecoadas em headers e mensagens de erro", () => {
    const segredo = "ponte-super-secreta-123456";
    const redigida = redigirMensagemDoProvedor(
      `sk-proj-chaveSuperSecreta123 X-CRM-Integration-Key: ${segredo} Authorization: Bearer ${segredo}`,
    );
    expect(redigida).not.toContain(segredo);
    expect(redigida).not.toContain("sk-proj-chaveSuperSecreta123");
    expect(redigida.match(/\[CHAVE\]/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("a mensagem de erro é truncada", async () => {
    const { linhaDeErro } = await chamarComErro(new Error("x".repeat(5000)));
    expect(String(linhaDeErro!.params[9]).length).toBeLessThanOrEqual(500);
  });

  it("o conteúdo da conversa não vai junto", async () => {
    // Mensagem de erro de provedor às vezes ecoa o corpo da requisição, e
    // conteúdo de mensagem é PII neste repo.
    const { pool, inserts } = poolQueGrava();
    await runModelCall(
      pool,
      cfg,
      {
        tenantId: ORG,
        purpose: "agent_turn",
        messages: [{ role: "user", content: "meu CPF é 123.456.789-00" }],
      },
      { registry: registryQueFalha(new Error("boom")) },
    ).catch(() => {});
    const tudo = JSON.stringify(inserts);
    expect(tudo).not.toContain("123.456.789-00");
    expect(tudo).not.toContain("CPF");
  });

  it("a chave do provedor não vai junto", async () => {
    const { pool, inserts } = poolQueGrava();
    await runModelCall(
      pool,
      cfg,
      { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
      { registry: registryQueFalha(new Error("boom")) },
    ).catch(() => {});
    expect(JSON.stringify(inserts)).not.toContain(CHAVE_SENTINELA);
  });
});

describe("a origem da escolha viaja com o log", () => {
  it("o sucesso registra de onde veio a decisão de usar aquele modelo", async () => {
    // É o que transforma o log de "o que aconteceu" em "por que aconteceu".
    const { pool, inserts } = poolQueGrava();
    const okRegistry = {
      anthropic: () =>
        ({
          specificationVersion: "v3",
          provider: "anthropic",
          modelId: "claude-padrao",
          doGenerate: async () => ({
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          }),
        }) as never,
    };
    await runModelCall(
      pool,
      cfg,
      { tenantId: ORG, purpose: "compaction", messages: [{ role: "user", content: "oi" }] },
      { registry: okRegistry },
    );
    expect(inserts[0]!.params).toContain("padrao_da_organizacao");
  });

  it("a falha também registra a origem", async () => {
    const { linhaDeErro } = await chamarComErro(new Error("boom"));
    expect(linhaDeErro!.params).toContain("padrao_da_organizacao");
  });
});
