import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/cron/agenda-google-sync/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshCatalog, syncCalendar } from "@/lib/agenda/google/calendar-executor";
import { audit } from "@/lib/audit";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "cron" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agenda/google/calendar-executor", () => ({
  refreshCatalog: vi.fn(),
  syncCalendar: vi.fn(),
}));
vi.mock("@/lib/agenda/google/membros", () => ({
  apenasDeMembrosAtivos: vi.fn(async (_db, rows) => rows),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

/**
 * A #2314: com 5 agendas marcadas (4 só de bloqueio, 1 também destino), a tela
 * dizia "Ainda não sincronizada" nas 4 de bloqueio enquanto a de destino mostrava
 * carimbo — mesmo tendo sido lidas na mesma rodada. Estes casos pedem o marco da
 * PRÓPRIA leitura de cada agenda da rodada, sem carimbar quem não leu.
 */
type Linha = {
  id: string;
  external_calendar_id: string;
  counts_for_conflicts: boolean;
  is_destination: boolean;
  sync_next_attempt_at: string;
  last_sync_at: string | null;
  sync_error?: string | null;
};

const connection = {
  id: "conn",
  organization_id: "org",
  user_id: "owner",
  calendar_selection_revision: "1",
};

let linhas: Linha[];
let vinculada: boolean;

function agenda(
  id: string,
  extra: Partial<Linha> = {},
): Linha {
  return {
    id,
    external_calendar_id: id,
    counts_for_conflicts: true,
    is_destination: false,
    sync_next_attempt_at: "2000-01-01T00:00:00Z",
    last_sync_at: null,
    ...extra,
  };
}

/** As 5 agendas da #2314: quatro que só bloqueiam horário e uma que também é destino. */
function rodadaDe5(): Linha[] {
  return [
    agenda("bloqueio-1"),
    agenda("bloqueio-2"),
    agenda("bloqueio-3"),
    agenda("bloqueio-4"),
    agenda("destino", { is_destination: true }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  vinculada = true;
  linhas = rodadaDe5();
  vi.mocked(syncCalendar).mockResolvedValue("complete");
  const db = {
    from: (table: string) => {
      let projection = "";
      let patch: Record<string, unknown> | null = null;
      const filters: Record<string, unknown> = {};
      const execute = () => {
        if (patch && table === "calendar_connection_calendars") {
          const row = linhas.find((l) => l.id === filters.id);
          if (row) Object.assign(row, patch);
          return { data: null, error: null };
        }
        if (patch) return { data: null, error: null };
        if (table === "calendar_connections") return { data: [connection], error: null };
        if (table === "calendar_google_reconcilable_appointments")
          return { data: vinculada ? [{ id: "vinculo" }] : [], error: null };
        if (projection === "catalog_checked_at")
          return { data: [{ catalog_checked_at: new Date().toISOString() }], error: null };
        if (projection.startsWith("id,external_calendar_id"))
          return {
            data: linhas.filter((l) => Date.parse(l.sync_next_attempt_at) <= Date.now()),
            error: null,
          };
        return { data: [], error: null };
      };
      const q = {
        select: (s: string) => {
          projection = s;
          return q;
        },
        eq: (key: string, v: unknown) => {
          filters[key] = v;
          return q;
        },
        lte: () => q,
        order: () => q,
        update: (p: Record<string, unknown>) => {
          patch = p;
          return q;
        },
        limit: async () => execute(),
        then: (resolve: (value: unknown) => void) => resolve(execute()),
      };
      return q;
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(db as never);
});

const rodar = async () => {
  const req = new NextRequest("http://local/cron", {
    headers: { authorization: "Bearer cron" },
  });
  return GET(req);
};

it("toda agenda que a rodada leu ganha o próprio last_sync_at — inclusive as que só bloqueiam", async () => {
  expect((await rodar()).status).toBe(200);
  expect(refreshCatalog).not.toHaveBeenCalled();
  expect(syncCalendar).toHaveBeenCalledTimes(5);
  // A regressão da #2314: as quatro de bloqueio ficavam nulas e a tela dizia
  // "Ainda não sincronizada".
  expect(linhas.filter((l) => l.last_sync_at === null).map((l) => l.id)).toEqual([]);
  expect(linhas.filter((l) => l.is_destination).map((l) => l.id)).toEqual(["destino"]);
  expect(linhas.every((l) => typeof l.last_sync_at === "string")).toBe(true);
});

it("agenda que a rodada não leu (nem fonte, nem destino, sem vínculo) não ganha carimbo", async () => {
  linhas = [agenda("ociosa", { counts_for_conflicts: false, is_destination: false })];
  vinculada = false;
  expect((await rodar()).status).toBe(200);
  expect(syncCalendar).not.toHaveBeenCalled();
  expect(linhas[0]!.last_sync_at).toBeNull();
  // Continua remarcada para depois, como já era.
  expect(Date.parse(String(linhas[0]!.sync_next_attempt_at))).toBeGreaterThan(Date.now());
});

it("busy não carimba: a rodada não leu essa agenda", async () => {
  vi.mocked(syncCalendar).mockResolvedValue("busy");
  expect((await rodar()).status).toBe(200);
  expect(linhas.filter((l) => l.last_sync_at !== null)).toEqual([]);
});

it("failed não carimba: quem não terminou é a sync_error da própria linha que conta", async () => {
  vi.mocked(syncCalendar).mockResolvedValue("failed");
  expect((await rodar()).status).toBe(200);
  expect(linhas.filter((l) => l.last_sync_at !== null)).toEqual([]);
});

it("partial carimba: a leitura avançou um checkpoint do ciclo", async () => {
  vi.mocked(syncCalendar).mockResolvedValue("partial");
  expect((await rodar()).status).toBe(200);
  expect(linhas.filter((l) => l.last_sync_at === null).map((l) => l.id)).toEqual([]);
});
