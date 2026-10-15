import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";

// As duas escritas possíveis são o EFEITO observável, mockadas: transferir
// (encerra a origem) e abrir card adicional (não encerra nada). O que estes
// testes prendem é QUAL das duas o roteador escolhe.
vi.mock("@/lib/leads/transfere-para-o-funil", () => ({
  COLUNAS_DA_ORIGEM: "id, pipeline_id, status, contact_id",
  transfereParaOFunil: vi.fn(async () => ({ ok: true, clone: { id: "clone-1" } })),
}));
vi.mock("@/lib/leads/abre-card-adicional", () => ({
  abreCardAdicionalNoFunil: vi.fn(async () => ({ ok: true, card: { id: "card-novo" } })),
}));

import { abreCardAdicionalNoFunil } from "@/lib/leads/abre-card-adicional";
import { transfereParaOFunil } from "@/lib/leads/transfere-para-o-funil";

import { aplicaDestinoDaIntencao, funisDeProdutoDoRoteador } from "./destino-da-intencao";

const transferir = vi.mocked(transfereParaOFunil);
const abrirAdicional = vi.mocked(abreCardAdicionalNoFunil);

const RECEPCAO = "pipe-recepcao";
const INVESTIMENTOS = "pipe-investimentos";
const CONSORCIO = "pipe-consorcio";
const PRODUTOS = [INVESTIMENTOS, CONSORCIO];

const handlerCtx: HandlerCtx = {
  organization_id: "org-1",
  actor: { type: "ai_agent", id: "job-1", role: "ai_operator", agent_id: "agent-x" },
  requestId: "job-1",
};

function negocio(id: string, pipeline: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: "org-1",
    pipeline_id: pipeline,
    status: "open",
    contact_id: "c1",
    last_activity_at: "2026-10-04T12:00:00+00:00",
    created_at: "2026-10-01T12:00:00+00:00",
    title: "Maria",
    description: null,
    value_cents: null,
    currency: "BRL",
    owner_user_id: null,
    owner_agent_id: null,
    expected_close_date: null,
    tags: [],
    source: null,
    custom_fields: {},
    source_metadata: {},
    ...extra,
  };
}

type Contato = { is_blocked: boolean; is_anonymized: boolean } | null;

/**
 * Supabase fake com as leituras do módulo: os negócios ABERTOS do contato
 * (`status = open`), o histórico nos funis de produto (a única que usa `.in`),
 * o histórico no funil de destino (`pipeline_id = destino`), as marcas do
 * contato e a escrita do aviso na Central.
 */
function admin({
  abertos = [],
  historico = [],
  contato = { is_blocked: false, is_anonymized: false },
}: {
  abertos?: unknown[];
  historico?: Array<{ pipeline_id: string }>;
  contato?: Contato;
}) {
  const avisos: Record<string, unknown>[] = [];
  const filtrosDoContato: Array<[string, unknown]> = [];
  const from = (tabela: string) => {
    if (tabela === "contacts") {
      const cadeia: Record<string, unknown> = {};
      cadeia.select = () => cadeia;
      cadeia.eq = (coluna: string, valor: unknown) => {
        filtrosDoContato.push([coluna, valor]);
        return cadeia;
      };
      cadeia.maybeSingle = async () => ({ data: contato, error: null });
      return cadeia;
    }
    if (tabela === "organizations") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { locale: null }, error: null }) }) }),
      };
    }
    if (tabela === "agent_inbox_items") {
      const cadeia: Record<string, unknown> = {};
      for (const nome of ["select", "eq", "limit"]) cadeia[nome] = () => cadeia;
      cadeia.maybeSingle = async () => ({ data: null, error: null });
      cadeia.insert = (linha: Record<string, unknown>) => {
        avisos.push(linha);
        return { error: null };
      };
      return cadeia;
    }
    let usouIn = false;
    const filtros: Record<string, unknown> = {};
    const cadeia: Record<string, unknown> = {};
    cadeia.select = () => cadeia;
    cadeia.eq = (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;
      return cadeia;
    };
    cadeia.limit = () => cadeia;
    cadeia.in = () => {
      usouIn = true;
      return cadeia;
    };
    cadeia.then = (resolve: (v: unknown) => unknown) => {
      if (filtros.status === "open") return resolve({ data: abertos, error: null });
      if (usouIn) return resolve({ data: historico, error: null });
      const noFunil = historico.filter((linha) => linha.pipeline_id === filtros.pipeline_id);
      return resolve({ data: noFunil, error: null });
    };
    return cadeia;
  };
  return { cliente: { from } as never, avisos, filtrosDoContato };
}

function deps(cliente: never, destino: string, extra: Record<string, unknown> = {}) {
  return {
    admin: cliente,
    organizationId: "org-1",
    contactId: "c1",
    destinoPipelineId: destino,
    destinoStageId: "stage-conversando",
    handlerCtx,
    funisDeProduto: PRODUTOS,
    ...extra,
  };
}

beforeEach(() => {
  transferir.mockClear();
  abrirAdicional.mockClear();
});

describe("o cliente de um produto que fala de outro ganha um card a mais", () => {
  it("Investimentos → Consórcio: abre o card do consórcio e NÃO encerra o de investimentos", async () => {
    const { cliente } = admin({ abertos: [negocio("lead-inv", INVESTIMENTOS)] });

    const r = await aplicaDestinoDaIntencao(deps(cliente, CONSORCIO));

    expect(r.status).toBe("card_adicional");
    expect(r.origemId).toBe("lead-inv");
    expect(r.cloneId).toBe("card-novo");
    expect(abrirAdicional).toHaveBeenCalledTimes(1);
    expect(abrirAdicional.mock.calls[0]![3]).toMatchObject({ id: "lead-inv", pipeline_id: INVESTIMENTOS });
    expect(abrirAdicional.mock.calls[0]![4]).toBe(CONSORCIO);
    expect(abrirAdicional.mock.calls[0]![5]).toBe("stage-conversando");
    // O que separa os dois desenhos: transferir ENCERRARIA o card de investimentos.
    expect(transferir).not.toHaveBeenCalled();
  });

  it("Consórcio → Investimentos: o espelho — abre o de investimentos e NÃO encerra o de consórcio", async () => {
    const { cliente } = admin({ abertos: [negocio("lead-con", CONSORCIO)] });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("card_adicional");
    expect(r.origemId).toBe("lead-con");
    expect(abrirAdicional).toHaveBeenCalledTimes(1);
    expect(abrirAdicional.mock.calls[0]![3]).toMatchObject({ id: "lead-con", pipeline_id: CONSORCIO });
    expect(abrirAdicional.mock.calls[0]![4]).toBe(INVESTIMENTOS);
    expect(transferir).not.toHaveBeenCalled();
  });

  it("os dois produtos já têm card aberto → nada a fazer, nas duas direções (idempotente)", async () => {
    const dois = [negocio("lead-inv", INVESTIMENTOS), negocio("lead-con", CONSORCIO)];

    const paraConsorcio = await aplicaDestinoDaIntencao(deps(admin({ abertos: dois }).cliente, CONSORCIO));
    const paraInvestimentos = await aplicaDestinoDaIntencao(deps(admin({ abertos: dois }).cliente, INVESTIMENTOS));

    expect(paraConsorcio.status).toBe("destino_ocupado");
    expect(paraInvestimentos.status).toBe("destino_ocupado");
    expect(abrirAdicional).not.toHaveBeenCalled();
    expect(transferir).not.toHaveBeenCalled();
  });

  it("a segunda mensagem do mesmo assunto não abre outro card (já está no destino)", async () => {
    const { cliente } = admin({ abertos: [negocio("lead-con", CONSORCIO)] });

    const r = await aplicaDestinoDaIntencao(deps(cliente, CONSORCIO));

    expect(r.status).toBe("ja_no_destino");
    expect(abrirAdicional).not.toHaveBeenCalled();
  });
});

describe("o card do funil de ENTRADA continua sendo transferido", () => {
  it("Recepção → Investimentos e Recepção → Consórcio transferem, não abrem card a mais", async () => {
    await aplicaDestinoDaIntencao(deps(admin({ abertos: [negocio("lead-r", RECEPCAO)] }).cliente, INVESTIMENTOS));
    await aplicaDestinoDaIntencao(deps(admin({ abertos: [negocio("lead-r", RECEPCAO)] }).cliente, CONSORCIO));

    expect(transferir).toHaveBeenCalledTimes(2);
    expect(transferir.mock.calls[0]![4]).toBe(INVESTIMENTOS);
    expect(transferir.mock.calls[1]![4]).toBe(CONSORCIO);
    expect(abrirAdicional).not.toHaveBeenCalled();
  });

  it("card de entrada E de outro produto abertos → transfere o de ENTRADA, o do produto fica", async () => {
    const { cliente } = admin({
      abertos: [negocio("lead-con", CONSORCIO), negocio("lead-r", RECEPCAO)],
    });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("transferido");
    expect(r.origemId).toBe("lead-r");
    expect(transferir.mock.calls[0]![3]).toMatchObject({ id: "lead-r", pipeline_id: RECEPCAO });
    expect(abrirAdicional).not.toHaveBeenCalled();
  });

  it("sem a lista de funis de produto → o roteamento de antes: toda troca é transferência", async () => {
    const { cliente } = admin({ abertos: [negocio("lead-inv", INVESTIMENTOS)] });

    const r = await aplicaDestinoDaIntencao(deps(cliente, CONSORCIO, { funisDeProduto: undefined }));

    expect(r.status).toBe("transferido");
    expect(abrirAdicional).not.toHaveBeenCalled();
  });
});

describe("cliente que JÁ FECHOU um produto (card ganho, nenhum aberto)", () => {
  it("Consórcio ganho → fala de Investimentos: nasce o card de investimentos", async () => {
    const ganho = negocio("lead-con-ganho", CONSORCIO, { status: "won" });
    const { cliente } = admin({ abertos: [], historico: [ganho] });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("card_adicional");
    expect(abrirAdicional.mock.calls[0]![3]).toMatchObject({ id: "lead-con-ganho" });
    expect(abrirAdicional.mock.calls[0]![4]).toBe(INVESTIMENTOS);
  });

  it("Investimentos ganho → fala de Consórcio: o espelho", async () => {
    const ganho = negocio("lead-inv-ganho", INVESTIMENTOS, { status: "won" });
    const { cliente } = admin({ abertos: [], historico: [ganho] });

    const r = await aplicaDestinoDaIntencao(deps(cliente, CONSORCIO));

    expect(r.status).toBe("card_adicional");
    expect(abrirAdicional.mock.calls[0]![4]).toBe(CONSORCIO);
  });

  it("já tem card (de qualquer status) NO destino → não abre outro a cada mensagem", async () => {
    const { cliente } = admin({
      abertos: [],
      historico: [
        negocio("lead-con-ganho", CONSORCIO, { status: "won" }),
        negocio("lead-inv-perdido", INVESTIMENTOS, { status: "lost" }),
      ],
    });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("sem_negocio");
    expect(abrirAdicional).not.toHaveBeenCalled();
  });

  it("só card PERDIDO em outro produto → não conta como cliente, nada se abre", async () => {
    const { cliente } = admin({
      abertos: [],
      historico: [negocio("lead-con-perdido", CONSORCIO, { status: "lost" })],
    });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("sem_negocio");
    expect(abrirAdicional).not.toHaveBeenCalled();
  });

  it("sem nenhum card nos funis de produto → sem_negocio, como antes", async () => {
    const { cliente } = admin({ abertos: [], historico: [] });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("sem_negocio");
  });

  it("sem a lista de funis de produto → nem consulta o histórico (o comportamento de antes)", async () => {
    const { cliente } = admin({ abertos: [], historico: [negocio("x", CONSORCIO, { status: "won" })] });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS, { funisDeProduto: [] }));

    expect(r.status).toBe("sem_negocio");
    expect(abrirAdicional).not.toHaveBeenCalled();
  });
});

describe("a recusa do card adicional é a mesma da transferência", () => {
  it("a régua de campos obrigatórios LANÇA → recusado, aviso na Central, o card de origem intacto", async () => {
    abrirAdicional.mockRejectedValueOnce(
      new ApiError(422, "required_fields_missing", { faltando: [] }, "job-1", "Preencha os campos"),
    );
    const { cliente, avisos } = admin({ abertos: [negocio("lead-con", CONSORCIO)] });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("recusado");
    expect(r.error).toBe("required_fields_missing");
    expect(r.origemId).toBe("lead-con");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ ref_kind: "lead", ref_id: "lead-con" });
  });

  it("recusa que NÃO lança ({ok:false}) também abre o aviso", async () => {
    abrirAdicional.mockResolvedValueOnce({ ok: false, error: "stage_pipeline_mismatch" });
    const { cliente, avisos } = admin({ abertos: [negocio("lead-con", CONSORCIO)] });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("recusado");
    expect(avisos).toHaveLength(1);
  });

  it("falha que não é a régua sobe ao chamador, sem aviso", async () => {
    abrirAdicional.mockRejectedValueOnce(new Error("banco fora"));
    const { cliente, avisos } = admin({ abertos: [negocio("lead-con", CONSORCIO)] });

    await expect(aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS))).rejects.toThrow("banco fora");
    expect(avisos).toHaveLength(0);
  });
});

describe("funisDeProdutoDoRoteador", () => {
  function leitura(resposta: { data: unknown; error: unknown }) {
    const filtros: Array<[string, unknown]> = [];
    const cadeia: Record<string, unknown> = {};
    cadeia.select = () => cadeia;
    cadeia.eq = (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return cadeia;
    };
    cadeia.not = () => cadeia;
    cadeia.then = (resolve: (v: unknown) => unknown) => resolve(resposta);
    return { cliente: { from: () => cadeia } as never, filtros };
  }

  it("devolve o destino de cada intenção, sem repetir, e filtra por organização e roteador", async () => {
    const { cliente, filtros } = leitura({
      data: [{ pipeline_id: INVESTIMENTOS }, { pipeline_id: CONSORCIO }, { pipeline_id: INVESTIMENTOS }],
      error: null,
    });

    const funis = await funisDeProdutoDoRoteador(cliente, "org-1", "router-1");

    expect(funis).toEqual([INVESTIMENTOS, CONSORCIO]);
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect(filtros).toContainEqual(["router_id", "router-1"]);
  });

  it("leitura que falha → lista vazia: cai no comportamento de antes, nunca abre card por engano", async () => {
    const { cliente } = leitura({ data: null, error: { message: "falhou" } });

    expect(await funisDeProdutoDoRoteador(cliente, "org-1", "router-1")).toEqual([]);
  });
});

describe("as duas guardas do card adicional (#2799, decisão de 14/10)", () => {
  it("card aberto em Consórcio e Investimentos JÁ GANHO → falar de Investimentos não abre outro card de venda", async () => {
    const { cliente } = admin({
      abertos: [negocio("lead-con", CONSORCIO)],
      historico: [negocio("lead-inv-ganho", INVESTIMENTOS, { status: "won" })],
    });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("ja_passou_pelo_destino");
    expect(r.origemId).toBe("lead-inv-ganho");
    expect(abrirAdicional).not.toHaveBeenCalled();
    expect(transferir).not.toHaveBeenCalled();
  });

  it("card aberto em Consórcio e Investimentos PERDIDO → também não abre (a regra do ramo sem card aberto)", async () => {
    const { cliente } = admin({
      abertos: [negocio("lead-con", CONSORCIO)],
      historico: [negocio("lead-inv-perdido", INVESTIMENTOS, { status: "lost" })],
    });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("ja_passou_pelo_destino");
    expect(abrirAdicional).not.toHaveBeenCalled();
  });

  it("contato BLOQUEADO que já comprou outro produto → não ganha card novo", async () => {
    const { cliente, filtrosDoContato } = admin({
      abertos: [],
      historico: [negocio("lead-inv-ganho", INVESTIMENTOS, { status: "won" })],
      contato: { is_blocked: true, is_anonymized: false },
    });

    const r = await aplicaDestinoDaIntencao(deps(cliente, CONSORCIO));

    expect(r.status).toBe("contato_bloqueado");
    expect(abrirAdicional).not.toHaveBeenCalled();
    // A marca é lida na organização do turno, não só pelo id do contato.
    expect(filtrosDoContato).toContainEqual(["organization_id", "org-1"]);
    expect(filtrosDoContato).toContainEqual(["id", "c1"]);
  });

  it("contato ANONIMIZADO com card aberto em outro produto → não ganha card novo", async () => {
    const { cliente } = admin({
      abertos: [negocio("lead-con", CONSORCIO)],
      contato: { is_blocked: false, is_anonymized: true },
    });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("contato_bloqueado");
    expect(abrirAdicional).not.toHaveBeenCalled();
  });

  it("contato que não aparece na organização → não abre (falha fechada)", async () => {
    const { cliente } = admin({ abertos: [negocio("lead-con", CONSORCIO)], contato: null });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("contato_bloqueado");
    expect(abrirAdicional).not.toHaveBeenCalled();
  });

  it("a guarda de contato não toca a transferência do funil de entrada (comportamento de antes)", async () => {
    const { cliente } = admin({
      abertos: [negocio("lead-r", RECEPCAO)],
      contato: { is_blocked: true, is_anonymized: false },
    });

    const r = await aplicaDestinoDaIntencao(deps(cliente, INVESTIMENTOS));

    expect(r.status).toBe("transferido");
  });
});
