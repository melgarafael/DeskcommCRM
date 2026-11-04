import { fireEvent, render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { it, expect, vi, afterEach } from "vitest";
import { AssistentePiloto } from "./AssistentePiloto";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("late initial history cannot overwrite completed turn", async () => {
  const identity = { tenantId: "fixture", userId: "fixture", assistantId: "internal-assistant" };
  const empty = { id: "fixture", identity, messages: [], receipts: [] };
  let resolveGet!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((_u: unknown, o?: RequestInit) =>
      o?.method === "POST"
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  ...empty,
                  messages: [{ id: "ai", role: "assistant", text: "verified reply" }],
                },
              }),
            ),
          )
        : new Promise<Response>((r) => (resolveGet = r)),
    ),
  );
  render(<AssistentePiloto enabled tenantId="fixture" userId="fixture" />);
  fireEvent.click(screen.getByText("Assistente"));
  await waitFor(() => expect(resolveGet).toBeDefined());
  fireEvent.change(screen.getByLabelText("Mensagem ao assistente"), { target: { value: "hello" } });
  fireEvent.click(screen.getByText("Enviar"));
  await screen.findByText("verified reply");
  await act(async () => {
    resolveGet(new Response(JSON.stringify({ data: empty })));
  });
  expect(screen.queryByText("verified reply")).not.toBeNull();
});
it("closing and reopening during a turn does not abort or freeze composer", async () => {
  const identity = {
    tenantId: "fixture-tenant",
    userId: "fixture-user",
    assistantId: "internal-assistant",
  };
  const session = {
    id: "fixture",
    identity,
    messages: [],
    receipts: [],
    version: 0,
    updatedAt: new Date().toISOString(),
  };
  let finish!: (r: Response) => void;
  const fetcher = vi.fn((_url: unknown, o?: RequestInit) =>
    o?.method === "POST"
      ? new Promise<Response>((r) => {
          finish = r;
        })
      : Promise.resolve(new Response(JSON.stringify({ data: session }))),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<AssistentePiloto enabled tenantId={identity.tenantId} userId={identity.userId} />);
  fireEvent.click(screen.getByText("Assistente"));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Mensagem ao assistente"), {
    target: { value: "Fixture question" },
  });
  fireEvent.click(screen.getByText("Enviar"));
  await waitFor(() => expect(finish).toBeDefined());
  const post = fetcher.mock.calls.find((x) => x[1]?.method === "POST")![1]!;
  fireEvent.click(screen.getByLabelText("Recolher assistente"));
  fireEvent.click(screen.getByText("Assistente"));
  expect((post.signal as AbortSignal).aborted).toBe(false);
  const body = JSON.parse(post.body as string);
  finish(
    new Response(
      JSON.stringify({
        data: {
          ...session,
          receipts: [{ turnId: body.turn_id, status: "completed" }],
          messages: [
            { id: "fixture-user", role: "user", text: "Fixture question" },
            { id: "fixture-ai", role: "assistant", text: "Fixture answer" },
          ],
        },
      }),
    ),
  );
  await waitFor(() =>
    expect((screen.getByLabelText("Mensagem ao assistente") as HTMLInputElement).disabled).toBe(
      false,
    ),
  );
  expect(screen.getByText("Fixture answer")).toBeTruthy();
  vi.unstubAllGlobals();
});
