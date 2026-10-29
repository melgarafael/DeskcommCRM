import { describe, expect, it, vi } from "vitest";
import {
  criarColetorDeFerramentas,
  envolverFerramentasComTraco,
  montarTracoDoTurno,
  LIMITE_DE_FERRAMENTAS,
  LIMITE_DO_ERRO,
  type EntradaDoTraco,
} from "./traco-do-turno";
import type { ToolSet } from "../edge/llm/run-model-call";

/** Relógio de mentira: cada leitura avança 5ms — a duração é previsível. */
function relogioDeMentira(): () => number {
  let t = 0;
  return () => {
    t += 5;
    return t;
  };
}

function ferramenta(execute: (input: unknown, options: unknown) => unknown) {
  return { description: "teste", parameters: {}, execute };
}

describe("criarColetorDeFerramentas", () => {
  it("guarda a chamada com estado, erro e duração arredondada", () => {
    const coletor = criarColetorDeFerramentas();
    coletor.registrar({ nome: "search_knowledge", estado: "ok", erro: null, duracao_ms: 12.4 });

    expect(coletor.listar()).toEqual([
      { nome: "search_knowledge", estado: "ok", erro: null, duracao_ms: 12 },
    ]);
    expect(coletor.truncado()).toBe(false);
  });

  it("trunca o texto do erro no teto, em vez de guardar o stack inteiro", () => {
    const coletor = criarColetorDeFerramentas({ limiteDoErro: 10 });
    coletor.registrar({ nome: "x", estado: "falhou", erro: "a".repeat(50), duracao_ms: 1 });

    expect(coletor.listar()[0]?.erro).toBe("a".repeat(10));
  });

  it("avisa o corte quando o turno estoura o teto de chamadas", () => {
    const coletor = criarColetorDeFerramentas({ limite: 2 });
    for (let i = 0; i < 5; i++) {
      coletor.registrar({ nome: `t${i}`, estado: "ok", erro: null, duracao_ms: 1 });
    }

    expect(coletor.listar()).toHaveLength(2);
    expect(coletor.truncado()).toBe(true);
  });

  it("devolve cópia — quem lê o traço não mexe no que o turno coletou", () => {
    const coletor = criarColetorDeFerramentas();
    coletor.registrar({ nome: "x", estado: "ok", erro: null, duracao_ms: 1 });
    coletor.listar().push({ nome: "injetada", estado: "ok", erro: null, duracao_ms: 1 });

    expect(coletor.listar()).toHaveLength(1);
  });
});

describe("envolverFerramentasComTraco", () => {
  it("sem coletor devolve o MESMO objeto — turno sem traço não paga nada", () => {
    const tools = { get_lead_context: ferramenta(() => ({ ok: true })) } as unknown as ToolSet;

    expect(envolverFerramentasComTraco(tools, undefined)).toBe(tools);
  });

  it("registra a chamada bem-sucedida e devolve o MESMO resultado", async () => {
    const resultado = { ok: true, dados: 42 };
    const tools = { get_lead_context: ferramenta(() => resultado) } as unknown as ToolSet;
    const coletor = criarColetorDeFerramentas();
    const envolvidas = envolverFerramentasComTraco(tools, coletor, relogioDeMentira());

    const devolvido = await (envolvidas.get_lead_context as { execute: (input: unknown, options: unknown) => unknown }).execute({}, {});

    expect(devolvido).toBe(resultado);
    expect(coletor.listar()).toEqual([
      { nome: "get_lead_context", estado: "ok", erro: null, duracao_ms: 5 },
    ]);
  });

  it("classifica `{ ok: false }` como falha e guarda a mensagem do erro", async () => {
    const tools = {
      send_message: ferramenta(() => ({ ok: false, error: { code: "x", message: "sem canal" } })),
    } as unknown as ToolSet;
    const coletor = criarColetorDeFerramentas();
    const envolvidas = envolverFerramentasComTraco(tools, coletor, relogioDeMentira());

    await (envolvidas.send_message as { execute: (input: unknown, options: unknown) => unknown }).execute({}, {});

    expect(coletor.listar()[0]).toMatchObject({
      nome: "send_message",
      estado: "falhou",
      erro: "sem canal",
    });
  });

  it("classifica o bloqueio do breaker como `bloqueada` — não é a ferramenta que quebrou", async () => {
    const tools = {
      search_knowledge: ferramenta(() => ({
        ok: false,
        error: { code: "circuit_breaker_same_tool", message: "desativada neste turno" },
      })),
    } as unknown as ToolSet;
    const coletor = criarColetorDeFerramentas();
    const envolvidas = envolverFerramentasComTraco(tools, coletor, relogioDeMentira());

    await (envolvidas.search_knowledge as { execute: (input: unknown, options: unknown) => unknown }).execute({}, {});

    expect(coletor.listar()[0]?.estado).toBe("bloqueada");
  });

  it("registra a exceção e RELANÇA o mesmo erro — observar não engole a falha", async () => {
    const erro = new Error("banco fora");
    const tools = {
      get_lead_context: ferramenta(() => {
        throw erro;
      }),
    } as unknown as ToolSet;
    const coletor = criarColetorDeFerramentas();
    const envolvidas = envolverFerramentasComTraco(tools, coletor, relogioDeMentira());

    await expect(
      (envolvidas.get_lead_context as { execute: (input: unknown, options: unknown) => unknown }).execute({}, {}),
    ).rejects.toBe(erro);
    expect(coletor.listar()[0]).toMatchObject({
      nome: "get_lead_context",
      estado: "falhou",
      erro: "banco fora",
    });
  });

  it("passa intocada a ferramenta sem execute (nada a observar)", () => {
    const def = { description: "sem execute", parameters: {} };
    const tools = { estatica: def } as unknown as ToolSet;
    const coletor = criarColetorDeFerramentas();
    const envolvidas = envolverFerramentasComTraco(tools, coletor, relogioDeMentira());

    expect(envolvidas.estatica).toBe(def);
  });

  it("não conta chamada de tool que nem existe no run (estado é por turno)", async () => {
    const tools = {
      a: ferramenta(() => ({ ok: true })),
      b: ferramenta(() => ({ ok: true })),
    } as unknown as ToolSet;
    const coletor = criarColetorDeFerramentas();
    const envolvidas = envolverFerramentasComTraco(tools, coletor, relogioDeMentira());

    await (envolvidas.a as { execute: (input: unknown, options: unknown) => unknown }).execute({}, {});

    expect(coletor.listar().map((c) => c.nome)).toEqual(["a"]);
  });
});

describe("montarTracoDoTurno", () => {
  const base: EntradaDoTraco = {
    organizationId: "org-1",
    jobId: "job-1",
    previewRunId: null,
    conversationId: "conv-1",
    contactId: "lead-1",
    agentId: "agent-1",
    agentVersionId: "ver-1",
    isDryRun: false,
    status: "completed",
    abortReason: null,
    errorCode: null,
    errorMessage: null,
    provider: "openai",
    model: "gpt-x",
    messagesSent: 2,
    historicoMensagens: 12,
    knowledgeSourceIds: ["fonte-1"],
    ferramentas: [],
  };

  it("copia a entrada para a linha do banco, com o nome das colunas", () => {
    const linha = montarTracoDoTurno(base);

    expect(linha).toMatchObject({
      organization_id: "org-1",
      job_id: "job-1",
      is_dry_run: false,
      status: "completed",
      messages_sent: 2,
      historico_mensagens: 12,
      knowledge_source_ids: ["fonte-1"],
      ferramentas_truncadas: false,
    });
  });

  it("trunca o erro do turno no teto (um stack inteiro não ajuda quem lê)", () => {
    const linha = montarTracoDoTurno({ ...base, errorMessage: "e".repeat(LIMITE_DO_ERRO + 50) });

    expect(linha.error_message).toHaveLength(LIMITE_DO_ERRO);
  });

  it("nunca grava mensagens_sent nem duração negativas", () => {
    const linha = montarTracoDoTurno({
      ...base,
      messagesSent: -3,
      ferramentas: [{ nome: "x", estado: "ok", erro: null, duracao_ms: -8 }],
    });

    expect(linha.messages_sent).toBe(0);
    expect(linha.ferramentas[0]?.duracao_ms).toBe(0);
  });

  it("corta a lista de ferramentas no teto e levanta a bandeira do corte", () => {
    const ferramentas = Array.from({ length: LIMITE_DE_FERRAMENTAS + 3 }, (_, i) => ({
      nome: `t${i}`,
      estado: "ok" as const,
      erro: null,
      duracao_ms: 1,
    }));

    const linha = montarTracoDoTurno({ ...base, ferramentas });

    expect(linha.ferramentas).toHaveLength(LIMITE_DE_FERRAMENTAS);
    expect(linha.ferramentas_truncadas).toBe(true);
  });

  it("o corte feito pelo COLETOR chega à linha: a lista já vem cortada, a bandeira não", () => {
    const linha = montarTracoDoTurno({
      ...base,
      ferramentas: [{ nome: "x", estado: "ok", erro: null, duracao_ms: 1 }],
      ferramentasTruncadas: true,
    });

    expect(linha.ferramentas_truncadas).toBe(true);
  });

  it("a prévia tem chave própria: sem job, o run id é quem identifica a linha", () => {
    const linha = montarTracoDoTurno({
      ...base,
      jobId: null,
      previewRunId: "run-9",
      isDryRun: true,
    });

    expect(linha.job_id).toBeNull();
    expect(linha.preview_run_id).toBe("run-9");
    expect(linha.is_dry_run).toBe(true);
  });

  it("id vazio vira NULL — a prévia de cenário não carrega uuid nenhum", () => {
    const linha = montarTracoDoTurno({ ...base, conversationId: "", contactId: "", agentId: "" });

    expect(linha.conversation_id).toBeNull();
    expect(linha.contact_id).toBeNull();
    expect(linha.agent_id).toBeNull();
  });
});
