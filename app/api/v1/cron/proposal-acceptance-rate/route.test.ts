import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  admin: vi.fn(),
  autoriza: vi.fn(() => true),
  audit: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.admin }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: h.autoriza }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
// O aviso nasce no idioma da organização; o dicionário fica de fora deste teste.
vi.mock("@/lib/i18n/idioma-do-aviso", () => ({
  idiomaDoAviso: async () => "pt-BR",
  preencher: (texto: string) => texto,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { calcularTaxaDeAceite, GET, organizacoesComPropostas } from "./route";

describe("calcularTaxaDeAceite", () => {
  it("3 aceitas de 10 decididas (aceita+recusada): 30%", () => {
    const propostas = [
      ...Array(3).fill({ status: "aceita" }),
      ...Array(7).fill({ status: "recusada" }),
      ...Array(2).fill({ status: "enviada" }), // ainda não decidida — fora do denominador
    ];
    expect(calcularTaxaDeAceite(propostas as never)).toBe(0.3);
  });

  it("zero decididas: null (sem dado suficiente, não é zero)", () => {
    expect(calcularTaxaDeAceite([{ status: "enviada" }] as never)).toBeNull();
  });

  it("taxa abaixo do piso (30%) dispara; acima, não", () => {
    expect(calcularTaxaDeAceite(Array(2).fill({ status: "aceita" }).concat(Array(8).fill({ status: "recusada" })) as never)).toBeLessThan(0.3);
    expect(calcularTaxaDeAceite(Array(8).fill({ status: "aceita" }).concat(Array(2).fill({ status: "recusada" })) as never)).toBeGreaterThan(0.3);
  });
});

describe("organizacoesComPropostas", () => {
  const orgs = [
    { id: "a", settings: { proposals: { enabled: true } } },
    { id: "b", settings: { proposals: { enabled: false } } },
    { id: "c", settings: null },
  ];
  it("só as organizações com a capacidade ligada entram na rodada", () => {
    expect(organizacoesComPropostas(orgs, ["propostas"])).toEqual(["a"]);
  });
  it("com o módulo desligado na instalação, nenhuma entra (doc 79)", () => {
    expect(organizacoesComPropostas(orgs, [])).toEqual([]);
  });
});

/**
 * O JOB É GLOBAL (#4871): uma execução lê todas as empresas e responde por cada
 * uma. As três combinações do piso são medidas aqui, e a empresa ligada tem de
 * ser processada na MESMA execução em que a desligada é pulada.
 */
describe("organizacoesComPropostas × a camada por empresa (#4871)", () => {
  const orgs = [
    { id: "a", settings: { proposals: { enabled: true } } },
    { id: "b", settings: { proposals: { enabled: true } } },
    { id: "c", settings: { proposals: { enabled: true } } },
  ];

  it("a empresa que DESLIGOU o módulo sai; as ligadas entram na mesma rodada", () => {
    expect(organizacoesComPropostas(orgs, ["propostas"], new Set(["b"]))).toEqual(["a", "c"]);
  });

  it("sem linha da empresa, ela HERDA a instalação e continua na rodada", () => {
    expect(organizacoesComPropostas(orgs, ["propostas"], new Set())).toEqual(["a", "b", "c"]);
  });

  it("instalação desligada vence a linha da empresa: ninguém entra", () => {
    expect(organizacoesComPropostas(orgs, [], new Set())).toEqual([]);
  });

  it("leitura das linhas da empresa que falhou (null) não processa ninguém", () => {
    expect(organizacoesComPropostas(orgs, ["propostas"], null)).toEqual([]);
  });

  it("o caminho antigo (job sem a lista de empresas) responde como antes", () => {
    expect(organizacoesComPropostas(orgs, ["propostas"])).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// A rodada inteira, com um admin de mentira: a rota faz `select` encadeado do
// PostgREST, e o teste precisa ver o INSERT do aviso de cada empresa.
// ---------------------------------------------------------------------------

type Cena = {
  orgs?: Array<{ id: string; settings: unknown }>;
  linhas?: Array<{ organization_id: string; estado: string }>;
  propostas?: Record<string, Array<{ status: string }>>;
  moduloNaInstalacao?: boolean;
  erroLinhas?: string;
  jaAvisadas?: Set<string>;
};

function adminFalso(cena: Cena) {
  const inseridas: Array<Record<string, unknown>> = [];
  function consulta(tabela: string) {
    const filtros: Record<string, unknown> = {};
    const resolver = () => {
      switch (tabela) {
        case "organizations":
          return { data: cena.orgs ?? [], error: null };
        case "organization_modules":
          return cena.erroLinhas
            ? { data: null, error: { message: cena.erroLinhas, code: "XX000" } }
            : { data: cena.linhas ?? [], error: null };
        case "platform_config":
          return {
            data: cena.moduloNaInstalacao ? [{ chave: "MODULO_PROPOSTAS", valor: "ligado" }] : [],
            error: null,
          };
        case "crm_proposals":
          return { data: cena.propostas?.[String(filtros.organization_id)] ?? [], error: null };
        default:
          return { data: [], error: null };
      }
    };
    const api = {
      select: () => api,
      eq: (coluna: string, valor: unknown) => {
        filtros[coluna] = valor;
        return api;
      },
      in: () => api,
      gte: () => api,
      not: () => api,
      insert: async (linha: Record<string, unknown>) => {
        inseridas.push(linha);
        return { error: null };
      },
      maybeSingle: async () =>
        tabela === "agent_inbox_items" && cena.jaAvisadas?.has(String(filtros.organization_id))
          ? { data: { id: "aviso-existente" }, error: null }
          : { data: null, error: null },
      then: (ok: (v: unknown) => unknown, falhou: (e: unknown) => unknown) =>
        Promise.resolve(resolver()).then(ok, falhou),
    };
    return api;
  }
  return { admin: { from: (tabela: string) => consulta(tabela) }, inseridas };
}

/** 10 decididas, todas recusadas: taxa 0%, abaixo do piso de 30%. */
const TODAS_RECUSADAS = Array.from({ length: 10 }, () => ({ status: "recusada" }));
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

describe("GET /api/v1/cron/proposal-acceptance-rate — a rodada por empresa (#4871)", () => {
  it("MESMA execução: a empresa ligada recebe o aviso e a desligada não", async () => {
    const { admin, inseridas } = adminFalso({
      orgs: [
        { id: A, settings: { proposals: { enabled: true } } },
        { id: B, settings: { proposals: { enabled: true } } },
      ],
      linhas: [{ organization_id: B, estado: "desligado" }],
      propostas: { [A]: TODAS_RECUSADAS, [B]: TODAS_RECUSADAS },
      moduloNaInstalacao: true,
    });
    h.admin.mockReturnValue(admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { organizacoes_avisadas: 1 } });
    expect(inseridas.map((l) => l.organization_id)).toEqual([A]);
  });

  it("empresa SEM linha na tabela herda a instalação e recebe o aviso", async () => {
    const { admin, inseridas } = adminFalso({
      orgs: [
        { id: A, settings: { proposals: { enabled: true } } },
        { id: B, settings: { proposals: { enabled: true } } },
      ],
      linhas: [],
      propostas: { [A]: TODAS_RECUSADAS, [B]: TODAS_RECUSADAS },
      moduloNaInstalacao: true,
    });
    h.admin.mockReturnValue(admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { organizacoes_avisadas: 2 } });
    expect(inseridas).toHaveLength(2);
  });

  it("instalação desligada: a rodada não avisa ninguém, nem a empresa com linha `ligado`", async () => {
    const { admin, inseridas } = adminFalso({
      orgs: [{ id: A, settings: { proposals: { enabled: true } } }],
      linhas: [{ organization_id: A, estado: "ligado" }],
      propostas: { [A]: TODAS_RECUSADAS },
      moduloNaInstalacao: false,
    });
    h.admin.mockReturnValue(admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { organizacoes_avisadas: 0 } });
    expect(inseridas).toHaveLength(0);
  });

  it("falha de leitura das empresas fecha a rodada: 500 e nenhum aviso", async () => {
    const { admin, inseridas } = adminFalso({
      orgs: [{ id: A, settings: { proposals: { enabled: true } } }],
      propostas: { [A]: TODAS_RECUSADAS },
      moduloNaInstalacao: true,
      erroLinhas: "permission denied for table organization_modules",
    });
    h.admin.mockReturnValue(admin);

    const res = await GET({} as never);

    expect(res.status).toBe(500);
    expect(inseridas).toHaveLength(0);
  });
});
