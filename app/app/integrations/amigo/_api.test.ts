import { afterEach, expect, it, vi } from "vitest";
import { execute } from "./_api";
afterEach(() => vi.unstubAllGlobals());
it.each([null, [], true, { state: "confirmed" }])(
  "trata recibo malformado %j como resultado incerto sem repetir",
  async (data) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(execute("attendance_cancel", { id: 12 }, "same-key")).rejects.toMatchObject({
      uncertain: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it("preserva a identidade da conta do formulário em cada operação", async () => {
  const { pinAmigoConnection, read } = await import("./_api");
  pinAmigoConnection("old-connection");
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ data: { data: [{ id: 1, name: "Clínica" }] } })),
    );
  vi.stubGlobal("fetch", fetchMock);
  await read("places");
  expect(fetchMock.mock.calls[0]![1].headers["X-Amigo-Connection"]).toBe("old-connection");
  pinAmigoConnection(null);
});
