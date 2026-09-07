import { describe, it, expect, vi } from "vitest";
import { withAgendaEffect, guardAgendaEffect } from "@/lib/agenda/efeito";
import { AgendaDeferredError } from "@/lib/agenda/protecao-followup";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { logger } from "@/lib/logger";
import { resultadoDoEnvioDoFollowup } from "@/lib/agent-engine/edge/crm/send-ledger";
describe("última borda de efeito do follow-up", () => {
  it("compromisso criado durante preparo impede o efeito final", async () => {
    let busy = false;
    const transport = vi.fn();
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("calendar_appointments")
        ? busy
          ? [
              {
                id: "a",
                contact_id: "c",
                status: "confirmed",
                revision: 1,
                starts_at: new Date(Date.now() + 3600000).toISOString(),
                ends_at: new Date(Date.now() + 7200000).toISOString(),
              },
            ]
          : []
        : [{ settings: {} }],
    }));
    await expect(
      withAgendaEffect({ query } as never, { organizationId: "org", contactId: "c" }, async () => {
        busy = true;
        await guardAgendaEffect();
        transport();
      }),
    ).rejects.toBeInstanceOf(AgendaDeferredError);
    expect(transport).not.toHaveBeenCalled();
  });
  it("recuperação obsoleta impede efeito antes de consultar proteção temporal", async () => {
    const query = vi.fn(async () => ({ rows: [{ current: false }] }));
    const transport = vi.fn();
    await expect(
      withAgendaEffect(
        { query } as never,
        { organizationId: "org", contactId: "c", enrollmentId: "e", nodeId: "n" },
        transport,
      ),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(transport).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
  });
  it("jobId persistido chega à guarda final antes de qualquer transporte", async () => {
    const query = vi.fn(async () => ({ rows: [{ current: false }] }));
    const transport = vi.fn();
    await expect(
      withAgendaEffect(
        { query } as never,
        { organizationId: "org", contactId: "c", enrollmentId: "e", nodeId: "n", jobId: "old-job", jobClaim:{worker_id:"worker",acquired_at:"2026-09-06T10:00:00.123456Z"} },
        transport,
      ),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(query).toHaveBeenCalledWith("select fn_followup_claim_current($1,$2,$3,$4) as current", [
      "org",
      "old-job",
      "worker",
      "2026-09-06T10:00:00.123456Z",
    ]);
    expect(transport).not.toHaveBeenCalled();
  });
  it("falha DB conserva adiamento com diagnóstico", async () => {
    const warning=vi.spyOn(logger,"warn").mockImplementation(()=>{});
    const query = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    await expect(
      withAgendaEffect({ query } as never, { organizationId: "org", contactId: "c" }, vi.fn()),
    ).rejects.toMatchObject({ protection: { motivo: "leitura_indisponivel", adiar: true } });
    expect(warning).toHaveBeenCalledWith("[agenda] proteção indisponível; cobrança adiada");
    warning.mockRestore();
  });
  it.each([{ rows: [] }, { rows: [{ status: "vetoed" }] }])(
    "sem envio ou veto tem desfecho terminal, sem repetir o turno",
    async ({ rows }) => {
      const result = await resultadoDoEnvioDoFollowup(
        { query: vi.fn(async () => ({ rows })) } as never,
        "org",
        "job",
      );
      expect(result.kind).toBe("skipped");
    },
  );
  it.each(["queued", "failed", "requested"])("%s não autoriza callback sent", async (status) => {
    await expect(
      resultadoDoEnvioDoFollowup(
        { query: vi.fn(async () => ({ rows: [{ status }] })) } as never,
        "org",
        "job",
      ),
    ).rejects.toThrow("followup_message_not_sent");
  });
  it("somente recibos aceitos permitem sent", async () => {
    expect(
      await resultadoDoEnvioDoFollowup(
        { query: vi.fn(async () => ({ rows: [{ status: "accepted" }] })) } as never,
        "org",
        "job",
      ),
    ).toEqual({ kind: "sent" });
  });
});
