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
vi.mock("@/lib/i18n/idioma-do-aviso", () => ({ idiomaDoAviso: async () => "pt-BR" }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { encontrarPromessasSemProposta, GET } from "./route";

describe("encontrarPromessasSemProposta", () => {
  it("tarefa promised_proposal vencida, sem proposta criada depois dela: sinaliza", () => {
    const r = encontrarPromessasSemProposta(
      {
        tarefas: [{ id: "t1", organization_id: "org-1", lead_id: "l1", source_kind: "promised_proposal", due_date: "2026-09-01T00:00:00Z", status: "pending", created_at: "2026-08-25T00:00:00Z" }],
        propostas: [],
        orgsLigadas: new Set(["org-1"]),
      },
      new Date("2026-09-17"),
    );
    expect(r).toHaveLength(1);
  });

  it("tarefa vencida, MAS já existe proposta criada depois dela para o mesmo lead: não sinaliza", () => {
    const r = encontrarPromessasSemProposta(
      {
        tarefas: [{ id: "t1", organization_id: "org-1", lead_id: "l1", source_kind: "promised_proposal", due_date: "2026-09-01T00:00:00Z", status: "pending", created_at: "2026-08-25T00:00:00Z" }],
        propostas: [{ id: "p1", organization_id: "org-1", lead_id: "l1", created_at: "2026-08-26T00:00:00Z" }],
        orgsLigadas: new Set(["org-1"]),
      },
      new Date("2026-09-17"),
    );
    expect(r).toHaveLength(0);
  });

  it("tarefa ainda não vencida: não sinaliza", () => {
    const r = encontrarPromessasSemProposta(
      { tarefas: [{ id: "t1", organization_id: "org-1", lead_id: "l1", source_kind: "promised_proposal", due_date: "2026-12-01T00:00:00Z", status: "pending", created_at: "2026-08-25T00:00:00Z" }], propostas: [], orgsLigadas: new Set(["org-1"]) },
      new Date("2026-09-17"),
    );
    expect(r).toHaveLength(0);
  });

  it("source_kind diferente (promised_followup): não sinaliza — não é sobre proposta", () => {
    const r = encontrarPromessasSemProposta(
      { tarefas: [{ id: "t1", organization_id: "org-1", lead_id: "l1", source_kind: "promised_followup", due_date: "2026-09-01T00:00:00Z", status: "pending", created_at: "2026-08-25T00:00:00Z" }], propostas: [], orgsLigadas: new Set(["org-1"]) },
      new Date("2026-09-17"),
    );
    expect(r).toHaveLength(0);
  });

  it("tarefa sem lead_id (negócio ambíguo na hora de criar): não sinaliza — não há onde apontar o aviso", () => {
    const r = encontrarPromessasSemProposta(
      { tarefas: [{ id: "t1", organization_id: "org-1", lead_id: null, source_kind: "promised_proposal", due_date: "2026-09-01T00:00:00Z", status: "pending", created_at: "2026-08-25T00:00:00Z" }], propostas: [], orgsLigadas: new Set(["org-1"]) },
      new Date("2026-09-17"),
    );
    expect(r).toHaveLength(0);
  });

  it("organização com propostas desligadas: não sinaliza, mesmo vencida", () => {
    const r = encontrarPromessasSemProposta(
      {
        tarefas: [{ id: "t1", organization_id: "org-off", lead_id: "l1", source_kind: "promised_proposal", due_date: "2026-09-01T00:00:00Z", status: "pending", created_at: "2026-08-25T00:00:00Z" }],
        propostas: [],
        orgsLigadas: new Set(["org-on"]),
      },
      new Date("2026-09-17"),
    );
    expect(r).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A RODADA INTEIRA, com um admin de mentira (#4871).
//
// Este cron já decidia por empresa pela chave de `settings` — o que faltava era
// a linha da empresa em `organization_modules`. Como `settings` continua sendo
// exigido, as duas réguas têm de caber no mesmo caso: a empresa com a chave
// ligada MAS com o módulo desligado na tela não recebe aviso.
// ---------------------------------------------------------------------------

interface TarefaNaCena {
  id: string;
  organization_id: string;
  lead_id: string | null;
  source_kind: string;
  due_date: string | null;
  status: string;
  created_at: string;
}

interface Cena {
  tarefas?: TarefaNaCena[];
  orgs?: Array<{ id: string; settings: unknown }>;
  instalacaoLigada?: boolean;
  linhas?: Array<{ organization_id: string; modulo: string; estado: string }>;
  erroLinhas?: string;
}

const PROPOSTAS_LIGADAS = { proposals: { enabled: true } };

function adminDaRodada(cena: Cena) {
  const lidas: string[] = [];
  const avisos: Array<{ organization_id: string }> = [];

  function consulta(tabela: string) {
    lidas.push(tabela);
    const filtros: Record<string, unknown> = {};
    const resolver = (): { data: unknown; error: unknown } => {
      if (tabela === "platform_config") {
        return {
          data: cena.instalacaoLigada ? [{ chave: "MODULO_PROPOSTAS", valor: "ligado" }] : [],
          error: null,
        };
      }
      if (tabela === "organization_modules") {
        return cena.erroLinhas
          ? { data: null, error: { message: cena.erroLinhas, code: "XX000" } }
          : {
              data: (cena.linhas ?? []).filter((l) => l.organization_id === filtros.organization_id),
              error: null,
            };
      }
      if (tabela === "crm_tasks") return { data: cena.tarefas ?? [], error: null };
      if (tabela === "crm_proposals") return { data: [], error: null };
      if (tabela === "organizations") return { data: cena.orgs ?? [], error: null };
      return { data: [], error: null };
    };

    const api: Record<string, unknown> = {};
    const devolver = () => api;
    api.select = devolver;
    api.in = devolver;
    api.not = devolver;
    api.eq = (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;
      return api;
    };
    api.insert = async (linha: { organization_id: string }) => {
      avisos.push(linha);
      return { error: null };
    };
    api.maybeSingle = async () => ({ data: null, error: null });
    api.then = (ok: (v: unknown) => unknown, falhou?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(ok, falhou);
    return api;
  }

  return { admin: { from: (tabela: string) => consulta(tabela) }, lidas, avisos };
}

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const promessa = (id: string, org: string): TarefaNaCena => ({
  id,
  organization_id: org,
  lead_id: `lead-${id}`,
  source_kind: "promised_proposal",
  due_date: "2020-01-01T00:00:00Z",
  status: "pending",
  created_at: "2019-12-01T00:00:00Z",
});

describe("GET /api/v1/cron/proposal-promised-not-created — a rodada por empresa (#4871)", () => {
  it("instalação desligada: não roda e nem lê as tarefas", async () => {
    const cena = adminDaRodada({ tarefas: [promessa("t-a", A)], orgs: [{ id: A, settings: PROPOSTAS_LIGADAS }] });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { pulado: "modulo_desligado" } });
    expect(cena.lidas).not.toContain("crm_tasks");
    expect(cena.avisos).toEqual([]);
  });

  it("MESMA execução: a empresa com o módulo desligado não recebe aviso, a ligada recebe", async () => {
    const cena = adminDaRodada({
      tarefas: [promessa("t-a", A), promessa("t-b", B)],
      orgs: [
        { id: A, settings: PROPOSTAS_LIGADAS },
        { id: B, settings: PROPOSTAS_LIGADAS },
      ],
      instalacaoLigada: true,
      linhas: [{ organization_id: A, modulo: "propostas", estado: "desligado" }],
    });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { sinalizadas: 1 } });
    expect(cena.avisos.map((a) => a.organization_id)).toEqual([B]);
  });

  it("empresa SEM linha herda a instalação, e a chave de `settings` continua valendo", async () => {
    const cena = adminDaRodada({
      tarefas: [promessa("t-a", A), promessa("t-b", B)],
      orgs: [
        { id: A, settings: PROPOSTAS_LIGADAS },
        { id: B, settings: { proposals: { enabled: false } } },
      ],
      instalacaoLigada: true,
      linhas: [],
    });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(await res.json()).toMatchObject({ data: { sinalizadas: 1 } });
    expect(cena.avisos.map((a) => a.organization_id)).toEqual([A]);
  });

  it("falha de leitura das linhas da empresa não avisa ninguém", async () => {
    const cena = adminDaRodada({
      tarefas: [promessa("t-a", A)],
      orgs: [{ id: A, settings: PROPOSTAS_LIGADAS }],
      instalacaoLigada: true,
      linhas: [{ organization_id: A, modulo: "propostas", estado: "ligado" }],
      erroLinhas: "permission denied for table organization_modules",
    });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { sinalizadas: 0 } });
    expect(cena.avisos).toEqual([]);
  });
});
