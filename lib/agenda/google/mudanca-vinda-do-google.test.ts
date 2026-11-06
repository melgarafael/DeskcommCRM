/**
 * A mudança que chega pelo Google Agenda vira o evento certo — ou nenhum.
 *
 * Sem isto, remarcar ou cancelar pelo Google não avisava ninguém: o aviso de
 * agendamento, as automações e os webhooks não sabiam que o horário mudou.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { emitirMudancaVindaDoGoogle, transicaoVindaDoGoogle, type EstadoDoCompromisso } from "./mudanca-vinda-do-google";

const ANTES: EstadoDoCompromisso = {
  id: "a1",
  contact_id: "c1",
  starts_at: "2026-10-23T13:00:00.000Z",
  ends_at: "2026-10-23T14:00:00.000Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
};

describe("transicaoVindaDoGoogle", () => {
  it("horário mudou → remarcado", () => {
    expect(transicaoVindaDoGoogle(ANTES, { ...ANTES, starts_at: "2026-10-23T15:00:00.000Z", ends_at: "2026-10-23T16:00:00.000Z" })).toBe(
      "rescheduled",
    );
  });

  it("só o fim mudou também é remarcação", () => {
    expect(transicaoVindaDoGoogle(ANTES, { ...ANTES, ends_at: "2026-10-23T14:30:00.000Z" })).toBe("rescheduled");
  });

  it("cancelado no Google → cancelado", () => {
    expect(transicaoVindaDoGoogle(ANTES, { ...ANTES, status: "cancelled" })).toBe("cancelled");
  });

  it("o mesmo instante escrito de outro jeito não é mudança", () => {
    expect(transicaoVindaDoGoogle(ANTES, { ...ANTES, starts_at: "2026-10-23T10:00:00-03:00" })).toBeNull();
  });

  it("compromisso que já não estava vivo não gera notícia", () => {
    expect(transicaoVindaDoGoogle({ ...ANTES, status: "cancelled" }, { ...ANTES, status: "cancelled" })).toBeNull();
  });
});

/** Client falso: as leituras devolvem vazio e o `rpc` é gravado. */
function fakeDb(rpcError: { message: string } | null = null) {
  const rpc = vi.fn(async () => ({ data: null, error: rpcError }));
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) builder[m] = () => builder;
  builder.maybeSingle = async () => ({ data: null, error: null });
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return { db: { from: () => builder, rpc } as unknown as SupabaseClient, rpc };
}

describe("emitirMudancaVindaDoGoogle", () => {
  it("emite appointment.rescheduled com autor google, pela organização certa", async () => {
    const { db, rpc } = fakeDb();
    await emitirMudancaVindaDoGoogle(db, "org-1", ANTES, { ...ANTES, starts_at: "2026-10-23T15:00:00.000Z" });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [nome, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(nome).toBe("emit_event");
    expect(args.p_organization_id).toBe("org-1");
    expect(args.p_event_type).toBe("appointment.rescheduled");
    expect((args.p_payload as Record<string, unknown>).autor).toBe("google");
  });

  it("sem mudança, não emite nada", async () => {
    const { db, rpc } = fakeDb();
    await emitirMudancaVindaDoGoogle(db, "org-1", ANTES, { ...ANTES });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("falha ao emitir não lança — a sincronização já gravou a mudança", async () => {
    const { db } = fakeDb({ message: "boom" });
    await expect(
      emitirMudancaVindaDoGoogle(db, "org-1", ANTES, { ...ANTES, status: "cancelled" }),
    ).resolves.toBeUndefined();
  });
});
