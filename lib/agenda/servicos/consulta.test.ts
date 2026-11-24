import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { googleRpc } from "../google/sync-store";
import { consultarServico, primeiroLugarLivre, lugaresDoServico, type DadosDoServico } from "./consulta";

const ORG = "00000000-0000-4000-8000-000000000001";
const SALA_A = "20000000-0000-4000-8000-000000000001";
const SALA_B = "20000000-0000-4000-8000-000000000002";
const SALA_C = "20000000-0000-4000-8000-000000000003";

// lugaresDoServico ordena por nome: Sala A (SALA_B), Sala B (SALA_A), Sala C (SALA_C)
const servicoComSalas: DadosDoServico = {
  event_type_id: "10000000-0000-4000-8000-000000000001" as DadosDoServico["event_type_id"],
  name: "Serviço com salas", slug: "servico-salas", is_active: true, service_enabled: true,
  booking_mode: "individual", service_capacity: null, service_timezone: "America/Sao_Paulo",
  duration_minutes: 60, slot_interval_minutes: 60, service_revision: 1, requires_confirmation: false,
  destination_calendar_id: null, service_publication_mode: "none",
  schedule: [{ weekday: 3, timing_kind: "fixed", start_minute: 540, capacity_rule: "inherit" }],
  professionals: [],
  resources: [
    { resource_id: SALA_A, units: 1, kind: "space", name: "Sala B", sector: null },
    { resource_id: SALA_B, units: 1, kind: "space", name: "Sala A", sector: null },
    { resource_id: SALA_C, units: 1, kind: "space", name: "Sala C", sector: "Térreo" },
  ],
  calendar_sources: [],
};

const servicoSemSalas: DadosDoServico = {
  ...servicoComSalas, event_type_id: "10000000-0000-4000-8000-000000000002" as DadosDoServico["event_type_id"], name: "Serviço sem salas",
  resources: [{ resource_id: "30000000-0000-4000-8000-000000000001", units: 1, kind: "resource", name: "Projetor" }],
};

const de = new Date("2026-11-25T00:00:00.000Z");
const ate = new Date("2026-11-26T00:00:00.000Z");
const agora = new Date("2026-11-24T10:00:00.000Z");
const starts_at = "2026-11-25T14:00:00.000Z";

vi.mock("../google/sync-store", () => ({ googleRpc: vi.fn() }));

beforeEach(() => {
  vi.mocked(googleRpc).mockReset();
});

describe("consulta por lugar", () => {
  it("serviço sem lugar faz uma chamada só, sem p_space", async () => {
    vi.mocked(googleRpc).mockResolvedValue([{ available: true, starts_at, reason: null }]);

    await consultarServico({} as SupabaseClient, ORG, servicoSemSalas, { de, ate, agora });

    expect(googleRpc).toHaveBeenCalledTimes(1);
    const params = vi.mocked(googleRpc).mock.calls[0]?.[2] as { p_space?: unknown } | undefined;
    expect(params?.p_space).toBeUndefined();
  });

  it("spaceId explícito faz uma chamada só com p_space", async () => {
    vi.mocked(googleRpc).mockResolvedValue([{ available: true, starts_at, space_id: SALA_A, reason: null }]);

    await consultarServico({} as SupabaseClient, ORG, servicoComSalas, { de, ate, agora, spaceId: SALA_A });

    expect(googleRpc).toHaveBeenCalledTimes(1);
    const params = vi.mocked(googleRpc).mock.calls[0]?.[2] as { p_space?: unknown } | undefined;
    expect(params?.p_space).toBe(SALA_A);
  });

  it("com três salas, uma chamada por sala com o mesmo p_owner", async () => {
    vi.mocked(googleRpc)
      .mockResolvedValueOnce([{ available: false, starts_at, reason: "space_capacity_reached" }])
      .mockResolvedValueOnce([{ available: true, starts_at, space_id: SALA_B, reason: null }])
      .mockResolvedValueOnce([{ available: false, starts_at, reason: "space_capacity_reached" }]);

    const resultado = await consultarServico({} as SupabaseClient, ORG, servicoComSalas, { de, ate, agora, ownerUserId: "owner-1" });

    expect(googleRpc).toHaveBeenCalledTimes(3);
    for (const chamada of vi.mocked(googleRpc).mock.calls) {
      expect(chamada[2].p_owner).toBe("owner-1");
    }
    const espacos = resultado.availability.find((a) => a.starts_at === starts_at)!.free_spaces!;
    expect(espacos.map((e) => e.name)).toEqual(["Sala B"]);
  });

  it("horário com a Sala B livre vem disponível e lista só a Sala B", async () => {
    vi.mocked(googleRpc)
      .mockResolvedValueOnce([{ available: false, starts_at, reason: "space_capacity_reached" }])
      .mockResolvedValueOnce([{ available: true, starts_at, space_id: SALA_B, reason: null }])
      .mockResolvedValueOnce([{ available: false, starts_at, reason: "space_capacity_reached" }]);

    const resultado = await consultarServico({} as SupabaseClient, ORG, servicoComSalas, { de, ate, agora });

    const linha = resultado.availability.find((a) => a.starts_at === starts_at)!;
    expect(linha.available).toBe(true);
    // Ordem alfabética: Sala A (id SALA_B, ocupado), Sala B (id SALA_A, livre) → lista Sala B
    expect(linha.free_spaces).toEqual([{ id: SALA_A, name: "Sala B", sector: null }]);
    expect(googleRpc).toHaveBeenCalledTimes(3);
  });

  it("linha indisponível guarda o motivo do PRIMEIRO lugar", async () => {
    vi.mocked(googleRpc)
      .mockResolvedValueOnce([{ available: false, starts_at, reason: "space_unavailable" }])
      .mockResolvedValueOnce([{ available: false, starts_at, reason: "space_capacity_reached" }])
      .mockResolvedValueOnce([{ available: false, starts_at, reason: "space_capacity_reached" }]);

    const resultado = await consultarServico({} as SupabaseClient, ORG, servicoComSalas, { de, ate, agora });

    const linha = resultado.availability.find((a) => a.starts_at === starts_at)!;
    expect(linha.available).toBe(false);
    expect(linha.reason).toBe("space_unavailable");
    expect(linha.free_spaces).toEqual([]);
  });

  it("todas as salas ocupadas: indisponível com space_capacity_reached", async () => {
    vi.mocked(googleRpc).mockResolvedValue([{ available: false, starts_at, reason: "space_capacity_reached" }]);

    const resultado = await consultarServico({} as SupabaseClient, ORG, servicoComSalas, { de, ate, agora });

    const linha = resultado.availability.find((a) => a.starts_at === starts_at)!;
    expect(linha.available).toBe(false);
    expect(linha.reason).toBe("space_capacity_reached");
    expect(linha.free_spaces).toEqual([]);
  });

  it("primeiroLugarLivre devolve a primeira sala livre em ordem de nome", async () => {
    // lugaresDoServico ordena: Sala A (SALA_B), Sala B (SALA_A), Sala C (SALA_C)
    vi.mocked(googleRpc).mockImplementation(async (_db: unknown, _nome: string, params: Record<string, unknown>) => {
      const pSpace = params.p_space as string | undefined;
      if (pSpace === SALA_B) return [{ available: false, starts_at, reason: "space_capacity_reached" }];
      if (pSpace === SALA_A) return [{ available: true, starts_at, space_id: SALA_A, reason: null }];
      if (pSpace === SALA_C) return [{ available: true, starts_at, space_id: SALA_C, reason: null }];
      return [];
    });

    const lugar = await primeiroLugarLivre({} as SupabaseClient, ORG, servicoComSalas, starts_at, "owner-1");
    // Primeira sala livre em ordem de nome é Sala A (id SALA_B, ocupado), depois Sala B (id SALA_A, livre)
    expect(lugar).toEqual({ livre: { id: SALA_A, name: "Sala B" }, motivo: null });
    expect(googleRpc).toHaveBeenCalledTimes(3);
  });

  it("primeiroLugarLivre com startsAt em -03:00 compara a linha 0 de cada lugar", async () => {
    const startsAtFuso = "2026-11-25T14:00:00-03:00";
    vi.mocked(googleRpc).mockImplementation(async (_db: unknown, _nome: string, params: Record<string, unknown>) => {
      const pSpace = params.p_space as string | undefined;
      if (pSpace === SALA_B) return [{ available: false, starts_at: startsAtFuso, reason: "space_capacity_reached" }];
      if (pSpace === SALA_A) return [{ available: true, starts_at: startsAtFuso, space_id: SALA_A, reason: null }];
      return [];
    });

    const lugar = await primeiroLugarLivre({} as SupabaseClient, ORG, servicoComSalas, startsAtFuso, "owner-1");
    expect(lugar).toEqual({ livre: { id: SALA_A, name: "Sala B" }, motivo: null });
    for (const chamada of vi.mocked(googleRpc).mock.calls) {
      expect(chamada[2].p_starts).toEqual([startsAtFuso]);
    }
  });

  it("primeiroLugarLivre sem sala livre e fora da programação devolve outside_schedule, não lugar ocupado", async () => {
    vi.mocked(googleRpc).mockResolvedValue([{ available: false, starts_at, reason: "outside_schedule" }]);

    const r = await primeiroLugarLivre({} as SupabaseClient, ORG, servicoComSalas, starts_at, "owner-1");
    expect(r).toEqual({ livre: null, motivo: "outside_schedule" });
  });

  it("primeiroLugarLivre só diz space_capacity_reached quando TODAS as salas deram esse motivo", async () => {
    vi.mocked(googleRpc).mockResolvedValue([{ available: false, starts_at, reason: "space_capacity_reached" }]);

    const r = await primeiroLugarLivre({} as SupabaseClient, ORG, servicoComSalas, starts_at, "owner-1");
    expect(r).toEqual({ livre: null, motivo: "space_capacity_reached" });
  });

  it("lugaresDoServico ordena por nome pt-BR", () => {
    expect(lugaresDoServico(servicoComSalas)).toEqual([
      { id: SALA_B, name: "Sala A", sector: null },
      { id: SALA_A, name: "Sala B", sector: null },
      { id: SALA_C, name: "Sala C", sector: "Térreo" },
    ]);
  });
});
