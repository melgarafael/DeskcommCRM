import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: m }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
import { AiReconciliation } from "@/components/admin/usage/AiReconciliation";
const item = {
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: "org",
  company: "Empresa teste",
  provider: "openai",
  model: "test-model",
  created_at: "2026-09-20",
  reserved_brl_cents: "100",
  usd_to_brl_rate: "6",
  period_start: "2026-09-01",
  period_end: "2026-10-01",
  usage_evidence: {
    version: 1,
    steps: [{ responseId: "resp_test", inputTokens: 1, outputTokens: null }],
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  m.get.mockResolvedValue({ data: { items: [item], next_cursor: null, can_resolve: true } });
});
afterEach(cleanup);
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AiReconciliation />
    </QueryClientProvider>,
  );
}
async function fill() {
  fireEvent.click(await screen.findByRole("button", { name: "Conferir consumo" }));
  fireEvent.change(screen.getByLabelText("Custo confirmado no provedor (US$)"), {
    target: { value: "0,0125" },
  });
  fireEvent.change(screen.getByLabelText("Referência da verificação no provedor"), {
    target: { value: "Provider report resp_test" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
}
it("waits for real success, preserves fields on failure and retries the same decision", async () => {
  let reject = (_e: unknown) => {};
  m.post.mockImplementationOnce(
    () =>
      new Promise((_resolve, r) => {
        reject = r;
      }),
  );
  mount();
  await fill();
  fireEvent.submit(screen.getByRole("form", { name: "Conferir consumo" }));
  expect(screen.getByRole("button", { name: "Confirmando…" })).toBeDisabled();
  expect(screen.queryByText(/Conciliação confirmada/)).not.toBeInTheDocument();
  reject(new Error("offline"));
  expect(await screen.findByRole("alert")).toHaveTextContent("dados foram preservados");
  expect(screen.getByLabelText("Custo confirmado no provedor (US$)")).toHaveValue("0,0125");
  m.post.mockResolvedValueOnce({ data: { charged_brl_cents: "7.5" } });
  fireEvent.submit(screen.getByRole("form", { name: "Conferir consumo" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Conciliação confirmada"),
  );
  expect(m.post).toHaveBeenLastCalledWith("/api/v1/admin/billing/reconciliation", {
    reservation_id: item.id,
    cost_usd_cents: 1.25,
    reference: "Provider report resp_test",
    verified: true,
  });
});
it("does not submit an unverified amount", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Conferir consumo" }));
  fireEvent.submit(screen.getByRole("form", { name: "Conferir consumo" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("confirme a verificação");
  expect(m.post).not.toHaveBeenCalled();
});
it("does not offer mutations to readonly administrators", async () => {
  m.get.mockResolvedValue({ data: { items: [item], next_cursor: null, can_resolve: false } });
  mount();
  await screen.findByText("Empresa teste");
  expect(screen.queryByRole("button", { name: "Conferir consumo" })).not.toBeInTheDocument();
});
