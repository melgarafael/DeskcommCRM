import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O cursor opaco da leitura de eventos do módulo (spec 33, F5): liga organização, instalação e posição, e
 * só o servidor o produz. O comportamento pela rota está em `app/api/v1/extensions/events/route.test.ts`.
 */

const mocks = vi.hoisted(() => ({ env: { INTERNAL_SECRET: "segredo-interno-do-servidor-0123456789" } }));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { createAdminClient } from "@/lib/supabase/admin";

import {
  emitirCursorDeEventos,
  estaAtrasado,
  interpretarAtraso,
  lerAtrasoDoModulo,
  lerCursorDeEventos,
} from "./eventos-do-modulo";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const INST_1 = randomUUID();
const INST_2 = randomUUID();

beforeEach(() => {
  mocks.env.INTERNAL_SECRET = "segredo-interno-do-servidor-0123456789";
});

describe("cursor de eventos do módulo", () => {
  it("ida e volta devolve a posição para o mesmo par organização × instalação", () => {
    const cursor = emitirCursorDeEventos(ORG_A, INST_1, 42);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(lerCursorDeEventos(cursor, ORG_A, INST_1)).toBe(42);
  });

  it("é opaco: a posição não aparece em claro no texto do cursor", () => {
    expect(emitirCursorDeEventos(ORG_A, INST_1, 987654321)).not.toContain("987654321");
  });

  it("outra organização ou outra instalação não lê o cursor", () => {
    const cursor = emitirCursorDeEventos(ORG_A, INST_1, 7);
    expect(lerCursorDeEventos(cursor, ORG_B, INST_1)).toBeNull();
    expect(lerCursorDeEventos(cursor, ORG_A, INST_2)).toBeNull();
  });

  it("assinatura adulterada, texto sem ponto ou lixo: null, sem lançar", () => {
    const cursor = emitirCursorDeEventos(ORG_A, INST_1, 7);
    const [carga = "", assinatura = ""] = cursor.split(".");
    const trocada = `${carga}.${(assinatura[0] === "a" ? "b" : "a") + assinatura.slice(1)}`;
    expect(lerCursorDeEventos(trocada, ORG_A, INST_1)).toBeNull();
    expect(lerCursorDeEventos(carga, ORG_A, INST_1)).toBeNull();
    expect(lerCursorDeEventos("", ORG_A, INST_1)).toBeNull();
    expect(lerCursorDeEventos("lixo.lixo", ORG_A, INST_1)).toBeNull();
    expect(lerCursorDeEventos(`${"A".repeat(300)}.${"0".repeat(64)}`, ORG_A, INST_1)).toBeNull();
  });

  it("o cursor emitido com um segredo não vale com outro", () => {
    const cursor = emitirCursorDeEventos(ORG_A, INST_1, 7);
    mocks.env.INTERNAL_SECRET = "outro-segredo-interno-do-servidor-987654";
    expect(lerCursorDeEventos(cursor, ORG_A, INST_1)).toBeNull();
  });

  it("sem segredo no servidor não se emite nem se confere cursor (lança, a rota responde 503)", () => {
    mocks.env.INTERNAL_SECRET = "";
    expect(() => emitirCursorDeEventos(ORG_A, INST_1, 1)).toThrow();
    mocks.env.INTERNAL_SECRET = "curto";
    expect(() => emitirCursorDeEventos(ORG_A, INST_1, 1)).toThrow();
  });
});

describe("atraso do módulo (F5 T3)", () => {
  const AGORA = Date.parse("2026-11-05T12:00:00.000Z");
  const h = (horas: number) => new Date(AGORA - horas * 3_600_000).toISOString();

  it("em dia nunca é atrasado, mesmo sem ler há dias", () => {
    expect(estaAtrasado({ atraso: 0, lidoEm: h(100), maisAntigoEm: null }, AGORA)).toBe(false);
  });

  it("com atraso: atrasado só se a última leitura tem mais de 24 h", () => {
    expect(estaAtrasado({ atraso: 3, lidoEm: h(23), maisAntigoEm: h(22) }, AGORA)).toBe(false);
    expect(estaAtrasado({ atraso: 3, lidoEm: h(25), maisAntigoEm: h(24) }, AGORA)).toBe(true);
  });

  it("nunca leu: atrasado só se existe evento com mais de 24 h", () => {
    expect(estaAtrasado({ atraso: 1, lidoEm: null, maisAntigoEm: h(2) }, AGORA)).toBe(false);
    expect(estaAtrasado({ atraso: 1, lidoEm: null, maisAntigoEm: h(30) }, AGORA)).toBe(true);
  });

  it("interpreta o jsonb do banco linha a linha, sem misturar vínculos, e descarta lixo", () => {
    const r = interpretarAtraso(
      [
        { last_event_id: 4, last_read_at: h(30), lag: 6, contacts_pending: 5, oldest_unread_at: h(29) },
        { last_event_id: null, last_read_at: null, lag: 0, contacts_pending: 0, oldest_unread_at: null },
        "lixo",
        null,
      ],
      AGORA,
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ ultimoCursor: 4, atraso: 6, contatosPendentes: 5, atrasado: true });
    expect(r[1]).toMatchObject({ ultimoCursor: null, lidoEm: null, atraso: 0, atrasado: false });
    expect(interpretarAtraso(null, AGORA)).toEqual([]);
  });

  it("lerAtrasoDoModulo chama a função do banco só com a instalação; erro devolve null", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "X" } });
    vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
    expect(await lerAtrasoDoModulo(INST_1, AGORA)).toEqual([]);
    expect(rpc).toHaveBeenCalledWith("fn_extensions_events_lag", { p_installation: INST_1 });
    expect(await lerAtrasoDoModulo(INST_1, AGORA)).toBeNull();
  });
});
