import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManageSubscriptionButton } from "@/components/billing/ManageSubscriptionButton";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows progress, recovers from failure and allows retry", async () => {
  let rejectRequest: (reason?: unknown) => void = () => {};
  const fetchMock = vi.fn().mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectRequest = reject;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<ManageSubscriptionButton idioma="pt-BR" />);
  fireEvent.click(screen.getByRole("button", { name: "Gerenciar assinatura" }));
  expect(screen.getByRole("button", { name: "Abrindo gestão da assinatura..." })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/billing/portal",
    expect.objectContaining({ method: "POST", body: "{}", credentials: "same-origin" }),
  );
  rejectRequest(new Error("offline"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Tente novamente");
  expect(screen.getByRole("button", { name: "Gerenciar assinatura" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Gerenciar assinatura" }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  rejectRequest(new Error("offline"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Gerenciar assinatura" })).toBeEnabled(),
  );
});
it.each(["https://evil.example/session", "javascript:alert(1)"])(
  "refuses an unexpected redirect %s",
  async (url) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { url } }) }),
    );
    render(<ManageSubscriptionButton idioma="pt-BR" />);
    fireEvent.click(screen.getByRole("button", { name: "Gerenciar assinatura" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível");
  },
);
