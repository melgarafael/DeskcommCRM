import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  admin: vi.fn(),
  autoriza: vi.fn(() => true),
  audit: vi.fn(),
  atividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.admin }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: h.autoriza }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: h.atividade }));
// O aviso nasce no idioma da organização; o dicionário fica de fora deste teste.
vi.mock("@/lib/i18n/idioma-do-aviso", () => ({ idiomaDoAviso: async () => "pt-BR" }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { encontrarPropostasVencidas, GET } from "./route";

const FUSOS = new Map<string, string>();

describe("encontrarPropostasVencidas", () => {
  it("proposta enviada com valid_until no passado: vencida", () => {
    const r = encontrarPropostasVencidas(
      [{ id: "p1", organization_id: "org-1", lead_id: "l1", contact_id: "c1", status: "enviada", valid_until: "2026-09-01" }],
      new Date("2026-09-17"),
      FUSOS,
    );
    expect(r).toHaveLength(1);
  });

  it("valid_until no futuro: não vence", () => {
    const r = encontrarPropostasVencidas(
      [{ id: "p1", organization_id: "org-1", lead_id: "l1", contact_id: "c1", status: "enviada", valid_until: "2026-12-01" }],
      new Date("2026-09-17"),
      FUSOS,
    );
    expect(r).toHaveLength(0);
  });

  it("status já decidido (aceita/recusada): não vence de novo", () => {
    const r = encontrarPropostasVencidas(
      [{ id: "p1", organization_id: "org-1", lead_id: "l1", contact_id: "c1", status: "aceita", valid_until: "2026-09-01" }],
      new Date("2026-09-17"),
      FUSOS,
    );
    expect(r).toHaveLength(0);
  });

  it("valid_until nulo: nunca vence (rascunho sem prazo definido não deveria chegar aqui, mas se chegar, não quebra)", () => {
    const r = encontrarPropostasVencidas(
      [{ id: "p1", organization_id: "org-1", lead_id: "l1", contact_id: "c1", status: "enviada", valid_until: null }],
      new Date("2026-09-17"),
      FUSOS,
    );
    expect(r).toHaveLength(0);
  });

  it("duas organizações em fusos diferentes: 'hoje' é calculado POR ORGANIZAÇÃO, não globalmente (D8)", () => {
    // 2026-06-16T02:00:00Z: já é 15/06 às 23h em America/Sao_Paulo (UTC-3),
    // mas já é 16/06 em Europe/Lisbon (verão europeu, UTC+1 => 03h).
    const agora = new Date("2026-06-16T02:00:00Z");
    const fusoPorOrganizacao = new Map([["org-sp", "America/Sao_Paulo"], ["org-lisboa", "Europe/Lisbon"]]);
    const propostas = [
      { id: "p1", organization_id: "org-sp", lead_id: "l1", contact_id: "c1", status: "enviada", valid_until: "2026-06-15" },
      { id: "p2", organization_id: "org-lisboa", lead_id: "l2", contact_id: "c2", status: "enviada", valid_until: "2026-06-15" },
    ];
    const vencidas = encontrarPropostasVencidas(propostas, agora, fusoPorOrganizacao);
    // org-sp: "hoje" ainda é 15/06 lá — a proposta NÃO venceu ainda.
    // org-lisboa: "hoje" já é 16/06 lá — a proposta VENCEU.
    expect(vencidas.map((p) => p.id)).toEqual(["p2"]);
  });
});

// ---------------------------------------------------------------------------
// A RODADA INTEIRA, com um admin de mentira (#4871).
//
// O cron é GLOBAL: uma execução lê as propostas de todas as empresas. A camada
// por empresa (`organization_modules`) só muda alguma coisa se a rodada souber
// pular UMA empresa e processar a VIZINHA no mesmo passo — por isso os cinco
// estados do piso são medidos aqui, e não na função pura.
// ---------------------------------------------------------------------------

interface PropostaDaCena {
  id: string;
  organization_id: string;
  lead_id: string;
  contact_id: string;
  status: string;
  valid_until: string | null;
}

interface Cena {
  propostas?: PropostaDaCena[];
  /** A linha `MODULO_PROPOSTAS` da instalação existe e vale `ligado`. */
  instalacaoLigada?: boolean;
  linhas?: Array<{ organization_id: string; modulo: string; estado: string }>;
  /** A leitura de `organization_modules` falhou (RLS, rede, banco fora). */
  erroLinhas?: string;
}

/** Banco falso que HONRA o filtro de empresa — é o que separa A de B. */
function adminFalso(cena: Cena) {
  const lidas: string[] = [];
  const vencidas: string[] = [];
  const avisos: Array<{ organization_id: string }> = [];

  function consulta(tabela: string) {
    lidas.push(tabela);
    const filtros: Record<string, unknown> = {};
    let escrita: Record<string, unknown> | null = null;

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
      if (tabela === "crm_proposals") {
        if (escrita !== null) {
          vencidas.push(String(filtros.id));
          return { data: null, error: null };
        }
        return { data: cena.propostas ?? [], error: null };
      }
      return { data: [], error: null };
    };

    // Encadeamento do PostgREST: todo verbo devolve a própria consulta.
    const api: Record<string, unknown> = {};
    const devolver = () => api;
    api.select = devolver;
    api.in = devolver;
    api.not = devolver;
    api.lt = devolver;
    api.eq = (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;
      return api;
    };
    api.update = (dados: Record<string, unknown>) => {
      escrita = dados;
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

  return { admin: { from: (tabela: string) => consulta(tabela) }, lidas, vencidas, avisos };
}

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const proposta = (id: string, org: string): PropostaDaCena => ({
  id,
  organization_id: org,
  lead_id: `lead-${id}`,
  contact_id: `contato-${id}`,
  status: "enviada",
  valid_until: "2020-01-01",
});

describe("GET /api/v1/cron/proposal-expiry — a rodada por empresa (#4871)", () => {
  it("instalação desligada: não roda, e nem lê as propostas", async () => {
    const cena = adminFalso({ propostas: [proposta("p-a", A)], instalacaoLigada: false });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { pulado: "modulo_desligado" } });
    expect(cena.lidas).not.toContain("crm_proposals");
    expect(cena.vencidas).toEqual([]);
  });

  it("MESMA execução: a empresa que desligou `propostas` não vence, a ligada vence", async () => {
    const cena = adminFalso({
      propostas: [proposta("p-a", A), proposta("p-b", B)],
      instalacaoLigada: true,
      linhas: [{ organization_id: A, modulo: "propostas", estado: "desligado" }],
    });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { vencidas: 1 } });
    expect(cena.vencidas).toEqual(["p-b"]);
    expect(cena.avisos.map((a) => a.organization_id)).toEqual([B]);
  });

  it("empresa SEM linha herda a instalação: as duas vencem", async () => {
    const cena = adminFalso({
      propostas: [proposta("p-a", A), proposta("p-b", B)],
      instalacaoLigada: true,
      linhas: [],
    });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(await res.json()).toMatchObject({ data: { vencidas: 2 } });
    expect(cena.vencidas.sort()).toEqual(["p-a", "p-b"]);
  });

  it("falha de leitura das linhas da empresa não processa ninguém", async () => {
    const cena = adminFalso({
      propostas: [proposta("p-a", A), proposta("p-b", B)],
      instalacaoLigada: true,
      linhas: [{ organization_id: A, modulo: "propostas", estado: "ligado" }],
      erroLinhas: "permission denied for table organization_modules",
    });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    // 200 com `vencidas: 0` é o resultado de uma rodada que não teve permissão
    // de saber; o que NÃO pode acontecer é escrever para quem não foi liberado.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { vencidas: 0 } });
    expect(cena.vencidas).toEqual([]);
    expect(cena.avisos).toEqual([]);
  });
});
