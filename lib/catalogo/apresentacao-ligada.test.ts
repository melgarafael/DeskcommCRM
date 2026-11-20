import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";

import { apresentacaoOferecidaNoTurno } from "./apresentacao-ligada";

vi.mock("@/lib/organizacao/capacidades", () => ({ capacidadesDaOrganizacao: vi.fn() }));

const ORG = "11000000-0000-4000-8000-000000000001";
const admin = {} as SupabaseClient;
const log = { warn: vi.fn() };
const query = vi.fn();
const oferecida = () => apresentacaoOferecidaNoTurno(admin, { query } as never, ORG, log);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(capacidadesDaOrganizacao).mockResolvedValue(["apresentacao_do_catalogo"]);
});

describe("apresentacaoOferecidaNoTurno", () => {
  it("capacidade desligada: não oferece e não consulta a tabela", async () => {
    vi.mocked(capacidadesDaOrganizacao).mockResolvedValue([]);
    expect(await oferecida()).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("ligada sem apresentação ativa: não oferece", async () => {
    query.mockResolvedValue({ rows: [{ ativa: false }] });
    expect(await oferecida()).toBe(false);
    expect(query.mock.calls[0]![1]).toEqual([ORG]);
  });

  it("ligada com apresentação ativa: oferece", async () => {
    query.mockResolvedValue({ rows: [{ ativa: true }] });
    expect(await oferecida()).toBe(true);
  });

  it("consulta que falha não derruba o turno: não oferece e avisa", async () => {
    query.mockRejectedValue(new Error("banco fora"));
    expect(await oferecida()).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
