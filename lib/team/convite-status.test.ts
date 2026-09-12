import { describe, expect, it } from "vitest";

import { conviteEstaEmAberto, statusConvite } from "./convite-status";

const HORA = 3_600_000;
const agora = Date.parse("2026-09-09T12:00:00.000Z");

describe("statusConvite", () => {
  it("revogado ganha de tudo, mesmo com validade no futuro", () => {
    expect(
      statusConvite(
        {
          revoked_at: "2026-09-09T11:00:00.000Z",
          accepted_at: null,
          expires_at: "2026-09-10T12:00:00.000Z",
        },
        agora,
      ),
    ).toBe("revogado");
  });

  it("aceito ganha de expirado (aceitou dentro do prazo, prazo passou depois)", () => {
    expect(
      statusConvite(
        {
          revoked_at: null,
          accepted_at: "2026-09-08T12:00:00.000Z",
          expires_at: "2026-09-09T00:00:00.000Z",
        },
        agora,
      ),
    ).toBe("aceito");
  });

  it("sem aceite nem revogação, o relógio decide", () => {
    expect(
      statusConvite(
        { revoked_at: null, accepted_at: null, expires_at: new Date(agora + HORA).toISOString() },
        agora,
      ),
    ).toBe("pendente");
    expect(
      statusConvite(
        { revoked_at: null, accepted_at: null, expires_at: new Date(agora - HORA).toISOString() },
        agora,
      ),
    ).toBe("expirado");
  });

  it("no instante exato da expiração já conta como expirado", () => {
    expect(
      statusConvite(
        { revoked_at: null, accepted_at: null, expires_at: new Date(agora).toISOString() },
        agora,
      ),
    ).toBe("expirado");
  });
});

describe("conviteEstaEmAberto", () => {
  it("pendente e expirado estão em aberto; aceito e revogado não", () => {
    const base = { revoked_at: null, accepted_at: null };
    expect(
      conviteEstaEmAberto({ ...base, expires_at: new Date(agora + HORA).toISOString() }, agora),
    ).toBe(true);
    expect(
      conviteEstaEmAberto({ ...base, expires_at: new Date(agora - HORA).toISOString() }, agora),
    ).toBe(true);
    expect(
      conviteEstaEmAberto(
        { revoked_at: null, accepted_at: "2026-09-08T12:00:00.000Z", expires_at: "x" },
        agora,
      ),
    ).toBe(false);
    expect(
      conviteEstaEmAberto(
        {
          revoked_at: "2026-09-08T12:00:00.000Z",
          accepted_at: null,
          expires_at: new Date(agora + HORA).toISOString(),
        },
        agora,
      ),
    ).toBe(false);
  });
});
