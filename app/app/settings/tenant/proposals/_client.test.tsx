// app/app/settings/tenant/proposals/_client.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProposalsSettingsClient } from "./_client";

const get = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { get, patch } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

// O Radix Switch exige polyfills que o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function config(enabled: boolean) {
  return { data: { enabled, default_valid_days: 30, default_conditions: null, avisar_no_whatsapp: true } };
}

describe("ProposalsSettingsClient", () => {
  beforeEach(() => {
    get.mockReset();
    patch.mockReset();
  });

  it("mostra o link Modelos de proposta quando as propostas estão ligadas", async () => {
    get.mockResolvedValue(config(true));
    render(<ProposalsSettingsClient />);
    await waitFor(() => expect(screen.getByRole("link", { name: "Modelos de proposta" })).toBeInTheDocument());
  });

  it("esconde o link Modelos de proposta enquanto as propostas estão desligadas (empresa não habilitou)", async () => {
    get.mockResolvedValue(config(false));
    render(<ProposalsSettingsClient />);
    // A tela carrega a config e renderiza o estado salvo.
    await waitFor(() => expect(screen.getByText("Salvar")).toBeInTheDocument());
    // O link só aparece com o valor SALVO como verdadeiro — com a empresa
    // desligada, ele não existe, porque levaria a uma tela que trava (issue #1889).
    expect(screen.queryByRole("link", { name: "Modelos de proposta" })).toBeNull();
    // Virar o switch SEM salvar não libera o link: o estado salvo é que manda.
    fireEvent.click(await screen.findAllByRole("switch").then((s) => s[0]!));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Modelos de proposta" })).toBeNull());
    // Salvar, sim: a partir daí o valor é o salvo e o link aparece.
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Modelos de proposta" })).toBeInTheDocument());
  });

  it("ligar o switch e salvar mantém o comportamento de salvar no estado atual", async () => {
    get.mockResolvedValue(config(false));
    patch.mockResolvedValue({ data: {} });
    render(<ProposalsSettingsClient />);
    const switchs = await screen.findAllByRole("switch");
    fireEvent.click(switchs[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/api/v1/settings/proposals",
        expect.objectContaining({ enabled: true }),
      ),
    );
  });
});