import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CheckoutButton } from "@/components/billing/CheckoutButton";
import { PlanComparison } from "@/components/billing/PlanComparison";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps checkout unavailable without server authorization", () => {
  render(<PlanComparison idioma="pt-BR" />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getAllByText("Contratação em preparação")).toHaveLength(3);
});
it("offers only the plan authorized for a pending checkout", () => {
  render(<PlanComparison idioma="pt-BR" billingEnabled allowedPlanIds={["essencial"]} />);
  expect(screen.getAllByRole("button", { name: "Continuar para pagamento" })).toHaveLength(1);
});
it("shows progress and allows retry after a failure without declaring payment success", async () => {
  let rejectRequest: (reason?: unknown) => void = () => {};
  const fetchMock = vi.fn().mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectRequest = reject;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<CheckoutButton idioma="pt-BR" planId="crescer" />);
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("button", { name: "Abrindo pagamento..." })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/billing/checkout",
    expect.objectContaining({
      body: JSON.stringify({ plan_id: "crescer" }),
      method: "POST",
      credentials: "same-origin",
    }),
  );
  rejectRequest(new Error("offline"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Tente novamente");
  expect(screen.getByRole("button")).toBeEnabled();
  fireEvent.click(screen.getByRole("button"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  rejectRequest(new Error("offline"));
  await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
});
it.each([
  "https://evil.example",
  "javascript:alert(1)",
  "https://checkout.stripe.com.evil.example",
])("rejects unsafe redirect %s", async (url) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { url } }) }),
  );
  render(<CheckoutButton idioma="pt-BR" planId="essencial" />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível");
});
it("explains an existing payment conflict without displaying server internals", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
  render(<CheckoutButton idioma="pt-BR" planId="essencial" />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Atualize a página");
});
