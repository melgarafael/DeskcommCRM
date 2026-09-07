import { describe, expect, it, vi } from "vitest";
import { ehEventoNosso, idDeEventoDoGoogle } from "@/lib/agenda/google/escrita";
import { googleTransport } from "@/lib/agenda/google/transport";
const appointment = "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
// Escrita/409/412/timeout também têm receiver real em agenda-google-transport
// e banco real em agenda-google-reconciliacao. Não existe mais PUT de substituição.
describe("identidade preservada na escrita", () => {
  it("é estável, aceita pelo Google e distinguível por UUID", () => {
    expect(idDeEventoDoGoogle(appointment)).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(idDeEventoDoGoogle(appointment)).toBe(idDeEventoDoGoogle(appointment.toUpperCase()));
    expect(idDeEventoDoGoogle(appointment)).not.toBe(
      idDeEventoDoGoogle(appointment.replace(/e$/, "f")),
    );
    expect(ehEventoNosso(idDeEventoDoGoogle(appointment))).toBe(true);
    expect(ehEventoNosso("thirdparty")).toBe(false);
  });
  it.each([404, 410])(
    "DELETE %i só conclui depois de provar calendário acessível",
    async (status) => {
      const transport = vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { status }))
        .mockResolvedValueOnce(new Response("{}"));
      expect(
        await googleTransport("token", transport).write(
          "original-calendar",
          "original-id",
          "DELETE",
          undefined,
          '"etag"',
        ),
      ).toBeNull();
      expect(transport).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls[0]![0]).toContain(
        "/original-calendar/events/original-id?sendUpdates=all",
      );
      expect(transport.mock.calls[0]![1]).toMatchObject({
        method: "DELETE",
        headers: { "If-Match": '"etag"' },
      });
    },
  );
  it.each([400, 401, 403, 404, 429, 500])(
    "insert HTTP %i mantém falha sem segunda escrita",
    async (status) => {
      const transport = vi.fn().mockResolvedValue(new Response("{}", { status }));
      await expect(
        googleTransport("token", transport).write(
          "calendar",
          idDeEventoDoGoogle(appointment),
          "POST",
          {},
          null,
        ),
      ).rejects.toMatchObject({ status });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("falha de rede preserva desfecho desconhecido para o executor", async () => {
    const transport = vi.fn().mockRejectedValue(new Error("socket closed"));
    await expect(
      googleTransport("token", transport).write("calendar", "persisted-id", "PATCH", {}, '"etag"'),
    ).rejects.toThrow("socket closed");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("resposta de outra identidade não é checkpoint", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "other", etag: '"v2"' })));
    await expect(
      googleTransport("token", transport).write("calendar", "persisted-id", "PATCH", {}, '"etag"'),
    ).rejects.toThrow("outra identidade");
  });
});
