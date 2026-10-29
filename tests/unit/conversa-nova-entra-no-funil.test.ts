import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  abrirNegocioDaConversaNova,
  ORIGEM_DA_ENTRADA_AUTOMATICA,
} from "@/lib/leads/entrada-automatica-no-funil";
import { entradaAutomaticaNoFunilDeclarada } from "@/lib/schemas/settings";

/**
 * A CONVERSA NOVA ENTRA NO FUNIL (#3603, fatia 1 — reestruturada).
 *
 * A porta DELEGA a `garantirLeadDaConversa`: contato interno, cliente pela
 * agenda e título passam a valer por construção. O dublê abaixo sustenta as
 * consultas que a delegação faz (contato, funil padrão, etapas, lead aberto,
 * configurações), não a regra antiga.
 */
const loggerWarn = vi.fn();
const loggerError = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => loggerWarn(...(a as [])),
    error: (...a: unknown[]) => loggerError(...(a as [])),
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const FUNIL_ARQUIVADO = "55555555-5555-4555-8555-555555555555";
const ETAPA_ENTRADA = "66666666-6666-4666-8666-666666666666";
const ETAPA_ESCOLHIDA = "77777777-7777-4777-8777-777777777777";
const LEAD_NOVO = "99999999-9999-4999-8999-999999999999";

interface Etapa {
  id: string;
  pipeline_id: string;
  position: number;
  is_archived: boolean;
  is_won: boolean;
  is_lost: boolean;
}

let settingsDaOrg: unknown;
let etapas: Etapa[];
let contato: Record<string, unknown> | null;
let rpcDevolve: string | null;

let escritas: Array<{ tabela: string; op: string; dados: unknown }>;
let rpcs: Array<{ nome: string; args: Record<string, unknown> }>;
let consultadas: string[];

interface Elo {
  select(colunas?: string): Elo;
  eq(coluna: string, valor: unknown): Elo;
  is(coluna: string, valor: unknown): Elo;
  order(coluna: string, opcoes?: { ascending?: boolean }): Elo;
  limit(n: number): Elo;
  maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
  insert(dados: unknown): Promise<{ data: null; error: null }>;
}

function resolver(
  tabela: string,
  filtros: Record<string, unknown>,
  ordem: string | null,
  limite: number | null,
) {
  if (tabela === "organizations") {
    if (filtros.id !== ORG) return null;
    return { settings: settingsDaOrg };
  }
  if (tabela === "crm_pipelines") {
    // is_default: devolve o funil padrão (FUNIL) — o destino da delegação.
    if (filtros.is_default === true) {
      if (filtros.is_archived === true) return null;
      return { id: FUNIL, settings: null };
    }
    const achado = [FUNIL, FUNIL_ARQUIVADO].find((id) => id === filtros.id);
    // arquivado?
    if (filtros.id === FUNIL_ARQUIVADO && filtros.is_archived !== true) return null;
    if (filtros.id === FUNIL && filtros.is_archived === true) return null;
    if (!achado) return null;
    return { id: achado };
  }
  if (tabela === "crm_stages") {
    const candidatas = etapas
      .filter(
        (e) =>
          e.pipeline_id === filtros.pipeline_id &&
          (!( "id" in filtros) || e.id === filtros.id) &&
          e.is_archived === (filtros.is_archived ?? false) &&
          e.is_won === (filtros.is_won ?? false) &&
          e.is_lost === (filtros.is_lost ?? false),
      )
      .sort((a, b) => (ordem === "position" ? a.position - b.position : 0));
    const primeira = limite ? candidatas.slice(0, limite)[0] : candidatas[0];
    return primeira ? { id: primeira.id } : null;
  }
  if (tabela === "contacts") {
    if (!contato || contato.id !== filtros.id) return null;
    return contato;
  }
  if (tabela === "crm_leads") {
    // nenhum lead aberto por padrão
    return null;
  }
  // campaign_recipients e demais: nenhum
  return null;
}

function consulta(tabela: string): Elo {
  consultadas.push(tabela);
  const filtros: Record<string, unknown> = {};
  let ordem: string | null = null;
  let limite: number | null = null;
  const elo: Elo = {
    select: () => elo,
    eq: (coluna, valor) => {
      filtros[coluna] = valor;
      return elo;
    },
    is: (coluna, valor) => {
      filtros[coluna] = valor;
      return elo;
    },
    order: (coluna) => {
      ordem = coluna;
      return elo;
    },
    limit: (n) => {
      limite = n;
      return elo;
    },
    maybeSingle: async () => ({ data: resolver(tabela, filtros, ordem, limite), error: null }),
    insert: async (dados) => {
      escritas.push({ tabela, op: "insert", dados });
      return { data: null, error: null };
    },
  };
  return elo;
}

const admin = {
  from: (tabela: string) => consulta(tabela),
  rpc: async (nome: string, args: Record<string, unknown>) => {
    rpcs.push({ nome, args });
    if (nome === "fn_nascer_lead_da_conversa") return { data: rpcDevolve, error: null };
    return { data: null, error: null };
  },
} as never;

const configurada = {
  entrada_automatica_no_funil: { ativa: true, pipeline_id: FUNIL, stage_id: ETAPA_ESCOLHIDA },
};

beforeEach(() => {
  vi.clearAllMocks();
  settingsDaOrg = null;
  etapas = [
    {
      id: ETAPA_ENTRADA,
      pipeline_id: FUNIL,
      position: 1,
      is_archived: false,
      is_won: false,
      is_lost: false,
    },
    {
      id: ETAPA_ESCOLHIDA,
      pipeline_id: FUNIL,
      position: 3,
      is_archived: false,
      is_won: false,
      is_lost: false,
    },
  ];
  contato = {
    id: CONTATO,
    display_name: "Ana Souza",
    name: null,
    phone_number: "5511999990000",
    is_blocked: false,
    is_personal: false,
  };
  rpcDevolve = LEAD_NOVO;
  escritas = [];
  rpcs = [];
  consultadas = [];
});

const conversa = { organizationId: ORG, contactId: CONTATO, conversationId: CONVERSA };

const rpcDoNascimento = () => rpcs.find((r) => r.nome === "fn_nascer_lead_da_conversa");

describe("a conversa nova entra no funil", () => {
  it("organização com entrada ligada: o negócio nasce, vinculado ao contato", async () => {
    settingsDaOrg = configurada;

    const r = await abrirNegocioDaConversaNova(admin, conversa);

    expect(r).toEqual({
      criado: true,
      leadId: LEAD_NOVO,
      pipelineId: FUNIL,
      stageId: ETAPA_ENTRADA,
    });
    const chamada = rpcDoNascimento();
    expect(chamada?.args).toMatchObject({
      p_org: ORG,
      p_contact: CONTATO,
      p_pipeline: FUNIL,
      p_source: ORIGEM_DA_ENTRADA_AUTOMATICA.source,
    });
    expect(chamada?.args.p_source_metadata).toMatchObject({});
    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.tabela).toBe("crm_lead_activities");
    expect(escritas[0]?.dados).toMatchObject({
      lead_id: LEAD_NOVO,
      contact_id: CONTATO,
      type: "lead_created",
      source_module: "canal.ingest",
      source_id: CONVERSA,
      actor_kind: "system",
    });
    expect(rpcs.map((x) => x.nome)).toContain("emit_event");
  });

  it("organização SEM configuração: nenhum negócio e NENHUMA escrita (o controle da fatia)", async () => {
    settingsDaOrg = null;

    const r = await abrirNegocioDaConversaNova(admin, conversa);

    expect(r).toEqual({ criado: false, motivo: "nao_configurado" });
    expect(rpcs).toHaveLength(0);
    expect(escritas).toHaveLength(0);
    expect(consultadas).toEqual(["organizations"]);
  });

  it("configuração DESLIGADA com funil e etapa gravados: nenhum negócio", async () => {
    settingsDaOrg = {
      entrada_automatica_no_funil: { ativa: false, pipeline_id: FUNIL, stage_id: ETAPA_ESCOLHIDA },
    };

    const r = await abrirNegocioDaConversaNova(admin, conversa);

    expect(r).toEqual({ criado: false, motivo: "nao_configurado" });
    expect(rpcs).toHaveLength(0);
    expect(escritas).toHaveLength(0);
  });

  it("configuração INCOMPLETA (ativa sem funil): nenhum negócio", async () => {
    settingsDaOrg = { entrada_automatica_no_funil: { ativa: true, pipeline_id: null } };

    const r = await abrirNegocioDaConversaNova(admin, conversa);

    expect(r).toEqual({ criado: false, motivo: "nao_configurado" });
    expect(rpcs).toHaveLength(0);
  });

  it("contato que já tem negócio aberto: não duplica", async () => {
    settingsDaOrg = configurada;
    // simula lead aberto
    const adminComLead = {
      ...admin,
      from: (tabela: string) => {
        if (tabela === "crm_leads") {
          const elo: any = {};
          elo.select = () => elo;
          elo.eq = () => elo;
          elo.limit = () => elo;
          elo.maybeSingle = async () => ({ data: { id: "existente" }, error: null });
          return elo;
        }
        return consulta(tabela);
      },
    } as never;
    rpcDevolve = LEAD_NOVO;

    const r = await abrirNegocioDaConversaNova(adminComLead, conversa);

    expect(r).toEqual({ criado: false, motivo: "ja_existe" });
  });

  it("contato bloqueado: não vira oportunidade", async () => {
    settingsDaOrg = configurada;
    contato = { ...(contato as Record<string, unknown>), is_blocked: true };

    const r = await abrirNegocioDaConversaNova(admin, conversa);

    expect(r).toEqual({ criado: false, motivo: "contato_bloqueado" });
    expect(rpcs).toHaveLength(0);
  });

  it("contato pessoal: não vira oportunidade (spec 21)", async () => {
    settingsDaOrg = configurada;
    contato = { ...(contato as Record<string, unknown>), is_personal: true };

    const r = await abrirNegocioDaConversaNova(admin, conversa);

    expect(r).toEqual({ criado: false, motivo: "contato_pessoal" });
    expect(rpcs).toHaveLength(0);
  });

  it("contato interno (equipe): NÃO ganha card — o caso que o mantenedor mediu", async () => {
    settingsDaOrg = {
      ...configurada,
      crm: { internal_contact_tags: ["equipe"] },
    };
    contato = {
      ...(contato as Record<string, unknown>),
      tags: ["equipe"],
    };

    const r = await abrirNegocioDaConversaNova(admin, conversa);

    expect(r).toEqual({ criado: false, motivo: "contato_interno" });
    expect(rpcs).toHaveLength(0);
  });

  it("contato sem nome nem telefone: o título diz de onde veio", async () => {
    settingsDaOrg = configurada;
    contato = {
      id: CONTATO,
      display_name: null,
      name: null,
      phone_number: null,
      is_blocked: false,
      is_personal: false,
    };

    await abrirNegocioDaConversaNova(admin, conversa);

    expect(rpcDoNascimento()?.args.p_title).toBe(
      `Novo contato pelo ${ORIGEM_DA_ENTRADA_AUTOMATICA.rotulo}`,
    );
  });

  it("o cadastro vence o payload: mensagem sem nome não rebatiza quem o CRM conhece", async () => {
    settingsDaOrg = configurada;

    await abrirNegocioDaConversaNova(admin, { ...conversa, nomeDoContato: "~5511999990000" });

    expect(rpcDoNascimento()?.args.p_title).toBe("Ana Souza");
  });

  it("leitura das configurações que falha não lança: devolve erro e a conversa segue", async () => {
    const adminComFalha = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: { message: "timeout" } }),
          }),
        }),
      }),
      rpc: async () => {
        throw new Error("não deveria chamar rpc");
      },
    } as never;

    const r = await abrirNegocioDaConversaNova(adminComFalha, conversa);

    expect(r).toMatchObject({ criado: false, motivo: "erro" });
    expect(loggerWarn).toHaveBeenCalled();
  });
});

describe("a leitura do jsonb da organização", () => {
  it("ausente, vazio ou torto é DESLIGADO — nunca lança", () => {
    for (const settings of [null, undefined, {}, { entrada_automatica_no_funil: null }, "lixo", 42]) {
      expect(entradaAutomaticaNoFunilDeclarada(settings)).toEqual({
        ativa: false,
        pipeline_id: null,
        stage_id: null,
      });
    }
  });

  it("só o `true` explícito liga", () => {
    expect(
      entradaAutomaticaNoFunilDeclarada({
        entrada_automatica_no_funil: { ativa: "true", pipeline_id: FUNIL },
      }),
    ).toEqual({ ativa: false, pipeline_id: FUNIL, stage_id: null });
    expect(
      entradaAutomaticaNoFunilDeclarada({
        entrada_automatica_no_funil: { ativa: true, pipeline_id: FUNIL },
      }).ativa,
    ).toBe(true);
  });

  it("identificador sem forma de uuid vira null — e o funil escolhido continua valendo", () => {
    expect(
      entradaAutomaticaNoFunilDeclarada({
        entrada_automatica_no_funil: { ativa: true, pipeline_id: FUNIL, stage_id: "primeira" },
      }),
    ).toEqual({ ativa: true, pipeline_id: FUNIL, stage_id: null });
  });
});

describe("controles de escopo da fatia", () => {
  it("o WEBHOOK continua igual: a captação por fonte não passa por esta porta", async () => {
    const { readFile } = await import("node:fs/promises");
    const rota = await readFile("app/api/v1/webhooks/in/[token]/route.ts", "utf8");
    expect(rota).not.toContain("entrada-automatica-no-funil");
    expect(rota).toContain("pipeline_id: source.default_pipeline_id");
    expect(rota).toContain("stage_id: source.default_stage_id");
  });

  it("quem abre conversa NÃO quebra quando a entrada no funil estoura (atendente, cron e agente de IA)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/atendimento/origem", () => ({
      beginServiceAtOrigin: async () => ({ conversation_id: CONVERSA }),
    }));
    vi.doMock("@/lib/leads/entrada-automatica-no-funil", () => ({
      abrirNegocioDaConversaNova: async () => {
        throw new Error("boom");
      },
    }));
    vi.doMock("@/lib/logger", () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: (...a: unknown[]) => loggerError(...(a as [])),
      },
    }));

    const { ensureConversation } = await import("@/lib/automation/start-conversation");
    const id = await ensureConversation({} as never, ORG, CONTATO, "sessao-1");
    expect(id).toBe(CONVERSA);
    expect(loggerError).toHaveBeenCalled();
    vi.doUnmock("@/lib/atendimento/origem");
    vi.doUnmock("@/lib/leads/entrada-automatica-no-funil");
    vi.doUnmock("@/lib/logger");
    vi.resetModules();
  });
});