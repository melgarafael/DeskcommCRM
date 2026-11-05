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

import { emitirCursorDeEventos, lerCursorDeEventos } from "./eventos-do-modulo";

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
