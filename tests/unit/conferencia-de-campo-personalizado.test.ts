/**
 * A CONFERÊNCIA DE CAMPO PERSONALIZADO DO NEGÓCIO (#2234) — os quatro exemplos
 * da issue, dublados, mais a catraca por origem, o fail-open e o que NÃO vaza.
 *
 * Os quatro exemplos (imobiliária fictícia) medem o degrau 1 e o degrau 2:
 * `orcamento_max: 2000` tem de ser gravado SEM chamada nenhuma, `quartos: 2` e
 * `tipo_imovel: "apartamento"` gravados, `quartos: 1` e `bairro: "Asa Norte"`
 * devolvidos com erro de ensino — todos em `decidindo`.
 */
import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  degrauUmCobre,
  extrairNumeros,
  valorDitoLiteralmente,
} from "@/lib/ai/decisao/campo-do-negocio";
import { CONFERENCIA_DE_CAMPO } from "@/lib/ai/decisao/tarefas";
import {
  conferirCamposPersonalizados,
  mensagensPendentesDoTurno,
  origemEhAgenteDeIa,
} from "@/lib/mcp/conferencia-de-campos";
import type { McpContext } from "@/lib/mcp/types";

const avisos = vi.hoisted(() => [] as Array<[string, Record<string, unknown>]>);
vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (mensagem: string, ctx: Record<string, unknown>) => avisos.push([mensagem, ctx]),
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";

/** Jev ligado, com o ACEITE DA CONVERSA (o alcance que a tarefa exige) e decidindo. */
const DECIDINDO = {
  jev: {
    ligado: true,
    modo: "decide",
    aceite: {
      em: "2026-09-01T12:00:00.000Z",
      por: "22222222-2222-4222-8222-222222222222",
      alcance: "conversa",
    },
    tarefas: { campo_do_negocio: { estado: "decidindo" } },
  },
};

interface FalsoBanco {
  inseridas: Record<string, unknown[]>;
  lidas: string[];
  settings: unknown;
  conversa: string | null;
  mensagens: Array<{ direction: string; body: string | null; created_at: string }>;
  pipelineSettings: unknown;
}

function bancoFalso(f: FalsoBanco): SupabaseClient {
  const linhaDe = (tabela: string, alvo: Record<string, unknown>): unknown => {
    if (tabela === "organizations") return f.settings === null ? null : { settings: f.settings };
    if (tabela === "crm_leads") return { pipeline_id: "pipe-1" };
    if (tabela === "crm_pipelines") return { settings: f.pipelineSettings };
    if (tabela === "conversations") return f.conversa === null ? null : { id: f.conversa };
    void alvo;
    return null;
  };
  const de = (tabela: string) => {
    const alvo: Record<string, unknown> = {};
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = (chave: string, valor: unknown) => {
      alvo[chave] = valor;
      return c;
    };
    // Como o PostgREST: a ordem pedida e o limite valem — a leitura das
    // mensagens depende dos dois (as mais recentes, do mais novo para trás).
    let decrescente = false;
    let limite = 1000; // o teto de linhas do PostgREST quando ninguém pede limite
    c.order = (_coluna: string, opcoes?: { ascending?: boolean }) => {
      decrescente = opcoes?.ascending === false;
      return c;
    };
    c.limit = (n: number) => {
      limite = n;
      return c;
    };
    c.maybeSingle = async () => ({ data: linhaDe(tabela, alvo), error: null });
    c.insert = (linhas: unknown) => {
      const lista = Array.isArray(linhas) ? linhas : [linhas];
      f.inseridas[tabela] = [...(f.inseridas[tabela] ?? []), ...lista];
      return Promise.resolve({ data: null, error: null });
    };
    c.then = (ok: (v: unknown) => unknown, ruim?: (e: unknown) => unknown) =>
      Promise.resolve({
        data:
          tabela === "messages"
            ? (decrescente ? [...f.mensagens].reverse() : f.mensagens).slice(0, limite)
            : [linhaDe(tabela, alvo)].filter(Boolean),
        error: null,
      }).then(ok, ruim);
    return c;
  };
  return {
    from: (tabela: string) => {
      f.lidas.push(tabela);
      return de(tabela);
    },
  } as unknown as SupabaseClient;
}

function ctxDoAgente(banco: SupabaseClient, extra: Partial<McpContext> = {}): McpContext {
  return {
    organizationId: ORG,
    role: "ai_operator",
    actor: { type: "ai_agent", id: "agent-1", agent_id: "agent-1", role: "ai_operator", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req-1",
    supabase: banco,
    contatoDoTurno: CONTATO,
    ...extra,
  } as unknown as McpContext;
}

interface RespostasDoJev {
  respostas: Record<string, number>;
  chamadas: Array<{ state: unknown; questions: string[] }>;
  falha?: Response;
}

function jev(r: RespostasDoJev): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    if (r.falha) return r.falha;
    const corpo = JSON.parse(String(init?.body ?? "{}")) as { state?: unknown; questions?: Record<string, unknown> };
    r.chamadas.push({ state: corpo.state, questions: Object.keys(corpo.questions ?? {}) });
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(corpo.questions ?? {})) {
      answers[id] = { type: "noul", noul: r.respostas[id] ?? 0.99 };
    }
    return new Response(
      JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 12, output_tokens: 0 } }),
      { status: 200 },
    );
  }) as typeof fetch;
}

const CHAVE = { buscarChave: () => Promise.resolve("chave-teste") };

async function turno(
  mensagens: string[],
  campos: Record<string, unknown>,
  r: RespostasDoJev,
  config: unknown = DECIDINDO,
): Promise<{ resultado: Awaited<ReturnType<typeof conferirCamposPersonalizados>>; f: FalsoBanco }> {
  const f: FalsoBanco = {
    inseridas: {},
    lidas: [],
    settings: config,
    conversa: "55555555-5555-4555-8555-555555555555",
    mensagens: mensagens.map((body, i) => ({
      direction: "inbound",
      body,
      created_at: `2026-09-01T10:0${i}:00.000Z`,
    })),
    pipelineSettings: { fields: [{ key: "quartos", label: "Quartos", type: "number" }] },
  };
  const resultado = await conferirCamposPersonalizados(ctxDoAgente(bancoFalso(f)), { leadId: LEAD }, campos, {
    ...CHAVE,
    fetchImpl: jev(r),
  });
  return { resultado, f };
}

describe("catraca por origem — tela, API de terceiros e automação não conferem nada", () => {
  it("a origem do agente de IA é o papel do turno E o contato do turno", () => {
    const f: FalsoBanco = { inseridas: {}, lidas: [], settings: DECIDINDO, conversa: null, mensagens: [], pipelineSettings: null };
    bancoFalso(f);
    expect(origemEhAgenteDeIa({ role: "ai_operator", contatoDoTurno: CONTATO })).toBe(true);
    expect(origemEhAgenteDeIa({ role: "manager", contatoDoTurno: CONTATO })).toBe(false);
    expect(origemEhAgenteDeIa({ role: "ai_operator" })).toBe(false);
    expect(origemEhAgenteDeIa({ role: "admin" })).toBe(false);
    expect(f.lidas).toEqual([]);
  });

  it("sem a origem certa não há conferência, nem leitura de banco", async () => {
    const f: FalsoBanco = {
      inseridas: {},
      lidas: [],
      settings: DECIDINDO,
      conversa: "55555555-5555-4555-8555-555555555555",
      mensagens: [{ direction: "inbound", body: "procuro algo pequeno", created_at: "2026-09-01T10:00:00.000Z" }],
      pipelineSettings: null,
    };
    const r = await conferirCamposPersonalizados(
      ctxDoAgente(bancoFalso(f), { role: "manager" }),
      { leadId: LEAD },
      { quartos: 1 },
      { ...CHAVE, fetchImpl: jev({ respostas: {}, chamadas: [] }) },
    );
    expect(r.estado).toBe("nao_conferida");
    expect(r.recusados).toEqual([]);
    expect(r.custom_fields).toBeUndefined();
    expect(f.lidas).toEqual([]);
  });

  it("sem custom_fields nada muda", async () => {
    const f: FalsoBanco = { inseridas: {}, lidas: [], settings: DECIDINDO, conversa: null, mensagens: [], pipelineSettings: null };
    const r = await conferirCamposPersonalizados(ctxDoAgente(bancoFalso(f)), { leadId: LEAD }, undefined);
    expect(r.estado).toBe("nao_conferida");
    expect(f.lidas).toEqual([]);
  });
});

describe("os quatro exemplos da issue, em decidindo", () => {
  it("«procuro algo pequeno pra mim e meu cachorro» → quartos: 1 devolvido com ensino", async () => {
    const r: RespostasDoJev = { respostas: { dito_quartos: 0.2, contrario_quartos: 0.1 }, chamadas: [] };
    const { resultado } = await turno(["procuro algo pequeno pra mim e meu cachorro"], { quartos: 1 }, r);
    expect(resultado.custom_fields).toEqual({});
    expect(resultado.recusados).toHaveLength(1);
    expect(resultado.recusados[0]?.motivo).toBe("cliente_nao_disse");
    expect(resultado.recusados[0]?.mensagem).toContain("pergunt");
    expect(resultado.recusados[0]?.mensagem).toContain("Quartos");
    expect(r.chamadas).toHaveLength(1);
  });

  it("«moro na Asa Norte mas quero sair daqui» → bairro devolvido como contrário", async () => {
    const r: RespostasDoJev = { respostas: { dito_bairro: 0.95, contrario_bairro: 0.9 }, chamadas: [] };
    const { resultado } = await turno(["moro na Asa Norte mas quero sair daqui"], { bairro: "Asa Norte" }, r);
    expect(resultado.custom_fields).toEqual({});
    expect(resultado.recusados[0]?.motivo).toBe("cliente_disse_o_contrario");
  });

  it("«até uns 2 mil por mês» → orcamento_max: 2000 gravado no degrau 1, SEM chamada", async () => {
    const r: RespostasDoJev = { respostas: {}, chamadas: [] };
    const { resultado } = await turno(["até uns 2 mil por mês"], { orcamento_max: 2000 }, r);
    expect(resultado.custom_fields).toEqual({ orcamento_max: 2000 });
    expect(resultado.recusados).toEqual([]);
    expect(r.chamadas).toHaveLength(0);
  });

  it("«apartamento de 2 quartos» → tipo_imovel e quartos gravados", async () => {
    const r: RespostasDoJev = { respostas: { dito_tipo_imovel: 0.96, contrario_tipo_imovel: 0.02 }, chamadas: [] };
    const { resultado } = await turno(
      ["apartamento de 2 quartos"],
      { tipo_imovel: "apartamento", quartos: 2 },
      r,
    );
    expect(resultado.custom_fields).toEqual({ tipo_imovel: "apartamento", quartos: 2 });
    expect(resultado.recusados).toEqual([]);
    // quartos: 2 saiu pelo degrau 1 (o número está na mensagem); só o texto foi
    // perguntado ao Jev — UMA chamada, com as perguntas do que sobrou.
    expect(r.chamadas).toHaveLength(1);
    expect(r.chamadas[0]?.questions).toEqual(["dito_tipo_imovel", "contrario_tipo_imovel"]);
  });
});

describe("na CRIAÇÃO (crm_create_lead, #2302) — o funil vem do argumento, não do negócio", () => {
  it("com pipelineId lê os rótulos do funil SEM ler crm_leads, e confere igual", async () => {
    const f: FalsoBanco = {
      inseridas: {},
      lidas: [],
      settings: DECIDINDO,
      conversa: "55555555-5555-4555-8555-555555555555",
      mensagens: [{ direction: "inbound", body: "procuro algo pequeno", created_at: "2026-09-01T10:00:00.000Z" }],
      pipelineSettings: { fields: [{ key: "quartos", label: "Quartos", type: "number" }] },
    };
    const r: RespostasDoJev = { respostas: { dito_quartos: 0.2, contrario_quartos: 0.1 }, chamadas: [] };
    const resultado = await conferirCamposPersonalizados(
      ctxDoAgente(bancoFalso(f)),
      { pipelineId: "66666666-6666-4666-8666-666666666666" },
      { quartos: 1 },
      { ...CHAVE, fetchImpl: jev(r) },
    );
    expect(resultado.custom_fields).toEqual({});
    expect(resultado.recusados[0]?.mensagem).toContain("Quartos");
    expect(f.lidas).toContain("crm_pipelines");
    expect(f.lidas).not.toContain("crm_leads");
  });
});

describe("fail-open — tarefa desligada, sem credencial ou provedor fora grava como hoje", () => {
  it("tarefa desligada: grava, não lê a conversa e não chama o Jev", async () => {
    const r: RespostasDoJev = { respostas: {}, chamadas: [] };
    const { resultado, f } = await turno(
      ["procuro algo pequeno"],
      { quartos: 1 },
      r,
      { jev: { ligado: false } },
    );
    // Sem conferência não há campo removido: a escrita recebe o pedido intacto.
    expect(resultado.custom_fields).toBeUndefined();
    expect(resultado.estado).toBe("desligada");
    expect(f.lidas).toEqual(["organizations"]);
    expect(r.chamadas).toHaveLength(0);
  });

  it("sem credencial: grava e registra error_code em llm_calls", async () => {
    const f: FalsoBanco = {
      inseridas: {},
      lidas: [],
      settings: DECIDINDO,
      conversa: "55555555-5555-4555-8555-555555555555",
      mensagens: [{ direction: "inbound", body: "procuro algo pequeno", created_at: "2026-09-01T10:00:00.000Z" }],
      pipelineSettings: null,
    };
    const r = await conferirCamposPersonalizados(ctxDoAgente(bancoFalso(f)), { leadId: LEAD }, { quartos: 1 }, {
      buscarChave: () => Promise.resolve(null),
      fetchImpl: jev({ respostas: {}, chamadas: [] }),
    });
    expect(r.custom_fields).toEqual({ quartos: 1 });
    expect(r.error_code).toBe("jev_sem_credencial");
    const falhas = (f.inseridas.llm_calls ?? []) as Array<Record<string, unknown>>;
    expect(falhas[0]?.error_code).toBe("jev_sem_credencial");
    expect(falhas[0]?.status).toBe("erro");
  });

  it("provedor falhando: grava e registra error_code em llm_calls", async () => {
    const r: RespostasDoJev = {
      respostas: {},
      chamadas: [],
      falha: new Response("{}", { status: 500 }),
    };
    const { resultado, f } = await turno(["procuro algo pequeno"], { quartos: 1 }, r);
    expect(resultado.custom_fields).toEqual({ quartos: 1 });
    expect(resultado.error_code).toBe("jev_provedor_indisponivel");
    const falhas = (f.inseridas.llm_calls ?? []) as Array<Record<string, unknown>>;
    expect(falhas[0]?.error_code).toBe("jev_provedor_indisponivel");
  });
});

describe("observando — grava sempre e registra só o par de rótulos", () => {
  it("o que o Jev teria devolvido vira linha em jev_observacoes, sem valor e sem texto", async () => {
    const observando = {
      jev: {
        ligado: true,
        modo: "observacao",
        aceite: { em: "2026-09-01T12:00:00.000Z", por: "22222222-2222-4222-8222-222222222222", alcance: "conversa" },
        tarefas: { campo_do_negocio: { estado: "observando" } },
      },
    };
    const r: RespostasDoJev = { respostas: { dito_quartos: 0.2, contrario_quartos: 0.1 }, chamadas: [] };
    const { resultado, f } = await turno(["procuro algo pequeno pra mim"], { quartos: 1 }, r, observando);
    // Grava, como hoje: observar nunca muda a ficha.
    expect(resultado.custom_fields).toEqual({ quartos: 1 });
    expect(resultado.recusados).toEqual([]);
    const linhas = (f.inseridas.jev_observacoes ?? []) as Array<Record<string, unknown>>;
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.rotulo_jev).toBe("cliente_nao_disse");
    expect(linhas[0]?.rotulo_atual).toBe("gravado");
    expect(linhas[0]?.estado).toBe("observando");
    expect(linhas[0]?.conversation_id).toBe("55555555-5555-4555-8555-555555555555");
  });
});

describe("privacidade — nem o valor do campo nem o texto do cliente saem daqui", () => {
  it("jev_observacoes e os logs não carregam o valor nem a frase do cliente", async () => {
    const frase = "moro na Asa Norte mas quero sair daqui";
    const r: RespostasDoJev = { respostas: { dito_bairro: 0.95, contrario_bairro: 0.9 }, chamadas: [] };
    const { resultado, f } = await turno([frase], { bairro: "Asa Norte" }, r);
    expect(resultado.recusados).toHaveLength(1);
    // NEM nas linhas gravadas NEM nos logs. O texto que sai para o Jev é outra
    // coisa: é ele que precisa ler a frase para responder (abaixo).
    const tudo = JSON.stringify({ inseridas: f.inseridas, avisos });
    expect(tudo).not.toContain("Asa Norte");
    expect(tudo).not.toContain("quer sair daqui");
    // O estado que sai para o fornecedor passa pelo scrubMessage.
    expect(String(r.chamadas[0]?.state)).toContain("Asa Norte");
  });
});

describe("degrau 1 — normalização em código, sem rede", () => {
  it("«2 mil», «2.000» e 2000 são o mesmo número; «R$ 2.000,00» idem", () => {
    expect(extrairNumeros("até uns 2 mil por mês")).toContain(2000);
    expect(extrairNumeros("R$ 2.000,00")).toContain(2000);
    expect(extrairNumeros("2 quartos")).toContain(2);
    expect(extrairNumeros("2.000,50")).toContain(2000.5);
  });

  it("só número, data, e-mail e dinheiro entram no degrau 1", () => {
    expect(degrauUmCobre(2000)).toBe(true);
    expect(degrauUmCobre("2.000,00")).toBe(true);
    expect(degrauUmCobre("2026-10-05")).toBe(true);
    expect(degrauUmCobre("cliente@exemplo.com")).toBe(true);
    expect(degrauUmCobre("Asa Norte")).toBe(false);
    expect(degrauUmCobre("apartamento")).toBe(false);
  });

  it("data e e-mail aparecem em qualquer formato que o cliente escreveu", () => {
    expect(valorDitoLiteralmente("2026-10-05", ["nasci em 05/10/1990"])).toBe(false);
    expect(valorDitoLiteralmente("2026-10-05", ["a entrega é em 05/10/2026"])).toBe(true);
    expect(valorDitoLiteralmente("cliente@Exemplo.com", ["meu email é cliente@exemplo.com"])).toBe(true);
    expect(valorDitoLiteralmente(2000, ["até uns 2 mil por mês"])).toBe(true);
    expect(valorDitoLiteralmente(2000, ["quero apartamento de 2 quartos"])).toBe(false);
  });
});

describe("as mensagens do turno — o Conversador antes da resposta, o Operador depois dela", () => {
  const CONVERSA = "55555555-5555-4555-8555-555555555555";
  const msg = (direction: string, body: string, minuto: number) => ({
    direction,
    body,
    created_at: `2026-09-01T10:${String(minuto).padStart(2, "0")}:00.000Z`,
  });
  const pendentes = async (mensagens: FalsoBanco["mensagens"]) => {
    const f: FalsoBanco = { inseridas: {}, lidas: [], settings: DECIDINDO, conversa: CONVERSA, mensagens, pipelineSettings: null };
    return (await mensagensPendentesDoTurno(ctxDoAgente(bancoFalso(f)))).mensagens;
  };
  const historico = [
    msg("inbound", "oi, quero alugar", 0),
    msg("outbound", "claro! quantos quartos?", 1),
    msg("inbound", "procuro algo pequeno", 2),
    msg("inbound", "pra mim e meu cachorro", 3),
  ];

  it("Conversador, antes de responder: o bloco do cliente depois da resposta anterior", async () => {
    expect(await pendentes(historico)).toEqual(["procuro algo pequeno", "pra mim e meu cachorro"]);
  });

  it("Operador, com a resposta deste turno já enviada: o MESMO bloco, não lista vazia", async () => {
    const depois = [...historico, msg("outbound", "anotado!", 4), msg("outbound", "vou ver opções", 5)];
    expect(await pendentes(depois)).toEqual(["procuro algo pequeno", "pra mim e meu cachorro"]);
  });

  // A pergunta ao Jev leva o valor CRU ("CEP é 01310-100?"). Se a mensagem
  // chegasse com `[CEP]` — a máscara de telemetria do #2418 —, a conferência
  // recusaria o CEP que o cliente acabou de digitar. CPF segue mascarado.
  it("CEP e telefone com hífen chegam como o cliente digitou; CPF segue mascarado", async () => {
    expect(
      await pendentes([
        msg("outbound", "qual o seu cep?", 0),
        msg("inbound", "meu cep é 01310-100", 1),
        msg("inbound", "zap +55-11-98765-4321", 2),
        msg("inbound", "cpf 123.456.789-09", 3),
      ]),
    ).toEqual(["meu cep é 01310-100", "zap +55-11-98765-4321", "cpf [CPF]"]);
  });

  it("conversa longa (mais que as 1000 linhas do PostgREST): lê as mais recentes, nunca as do começo", async () => {
    const longa = [
      ...Array.from({ length: 1100 }, (_, i) => msg(i % 2 === 0 ? "inbound" : "outbound", `antiga ${i}`, i % 60)),
      ...historico.map((m, i) => ({ ...m, created_at: `2026-09-02T10:0${i}:00.000Z` })),
    ];
    expect(await pendentes(longa)).toEqual(["procuro algo pequeno", "pra mim e meu cachorro"]);
  });
});

describe("custo — a chamada que deu certo aparece em Uso de IA", () => {
  it("decidindo: uma linha `ok` em llm_calls com tokens, modelo e origem `jev`", async () => {
    const r: RespostasDoJev = { respostas: { dito_quartos: 0.2, contrario_quartos: 0.1 }, chamadas: [] };
    const { f } = await turno(["procuro algo pequeno"], { quartos: 1 }, r);
    expect(f.inseridas.llm_calls).toEqual([
      expect.objectContaining({
        purpose: CONFERENCIA_DE_CAMPO.purpose,
        status: "ok",
        model: "typesafe/jev-1.13.0",
        input_tokens: 12,
        output_tokens: 0,
        origem_da_escolha: "jev",
        contact_id: CONTATO,
        agent_id: "agent-1",
      }),
    ]);
  });

  it("degrau 1 resolveu tudo: nenhuma chamada, nenhuma linha de custo", async () => {
    const r: RespostasDoJev = { respostas: {}, chamadas: [] };
    const { f } = await turno(["até uns 2 mil por mês"], { orcamento_max: 2000 }, r);
    expect(f.inseridas.llm_calls).toBeUndefined();
  });
});
