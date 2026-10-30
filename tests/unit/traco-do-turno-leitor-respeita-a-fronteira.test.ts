import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { GET } from "@/app/api/v1/ai/turn-traces/route";
import { janelaDaLeitura } from "@/lib/retencao/janela-do-traco";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { AI_TELEMETRY_RETENTION_DAYS: "100" } }));

const AGORA = new Date("2026-10-26T12:34:56.789Z");
const CORTE = new Date(AGORA.getTime() - 100 * 86_400_000);
const ORG = "b3201000-0000-4000-8000-000000000001";

function banco() {
  const chamadas: Array<[string, ...unknown[]]> = [];
  const query: Record<string, unknown> = {};
  for (const metodo of ["select", "eq", "gte", "lte", "lt", "order", "limit"]) {
    query[metodo] = (...args: unknown[]) => {
      chamadas.push([metodo, ...args]);
      return query;
    };
  }
  query.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  return {
    chamadas,
    client: {
      from: (t: string) => {
        chamadas.push(["from", t]);
        return query;
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ORG, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  } as never);
});
afterEach(() => vi.useRealTimers());

const pedir = (query: string) =>
  GET(new NextRequest(`http://localhost/api/v1/ai/turn-traces?${query}`));

describe("o leitor valida calendário e ordem antes de consultar", () => {
  it.each([
    "desde=2026-99-99",
    "desde=2026-02-30",
    "ate=2026-02-29",
    "ate=2026-04-31",
    "desde=2026-10-20&ate=2026-10-19",
    "desde=2026-10-27",
  ])("%s retorna 422 canônico", async (query) => {
    const db = banco();
    vi.mocked(createClient).mockResolvedValue(db.client as never);
    const resposta = await pedir(query);
    expect(resposta.status).toBe(422);
    expect(await resposta.json()).toMatchObject({ error: { code: "invalid_query" } });
    expect(createClient).not.toHaveBeenCalled();
    expect(db.chamadas).toEqual([]);
  });

  it("aceita 29 de fevereiro no ano bissexto sem normalizar para março", async () => {
    const resposta = await pedir("desde=2024-02-29&ate=2024-02-29");
    expect(resposta.status).toBe(200);
    expect((await resposta.json()).data.motivo_do_vazio).toBe("fora_da_retencao");
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("a fronteira temporal não é reaberta pelo filtro final", () => {
  it("o corte usa o instante da poda, inclusive no meio do dia", () => {
    const janela = janelaDaLeitura({ desde: "2026-01-01" }, 100, AGORA);
    expect(janela.de.toISOString()).toBe(CORTE.toISOString());
    expect(janela.truncada).toBe(true);
  });

  it("um pedido inteiramente vencido fica vazio, sem buscar backlog expirado", async () => {
    const resposta = await pedir("desde=2020-01-01&ate=2020-01-02");
    expect(resposta.status).toBe(200);
    expect((await resposta.json()).data).toMatchObject({
      tracos: [],
      total: 0,
      motivo_do_vazio: "fora_da_retencao",
      corte_retencao_em: CORTE.toISOString(),
      truncado_pela_retencao: true,
      janela: { dias: 0 },
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("consulta o início inclusivo e o fim exclusivo do dia UTC", async () => {
    const db = banco();
    vi.mocked(createClient).mockResolvedValue(db.client as never);
    const resposta = await pedir("desde=2026-10-25&ate=2026-10-25");
    expect(resposta.status).toBe(200);
    expect(db.chamadas).toContainEqual(["gte", "created_at", "2026-10-25T00:00:00.000Z"]);
    expect(db.chamadas).toContainEqual(["lt", "created_at", "2026-10-26T00:00:00.000Z"]);
    expect(db.chamadas).toContainEqual(["eq", "organization_id", ORG]);
    expect((await resposta.json()).data.motivo_do_vazio).toBe("nenhum_turno_na_janela");
  });
});
