import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContactTagsEditor } from "./ContactTagsEditor";
import { apiClient } from "@/lib/api/client";

// Issue #2718 — o espelho do ConversationTagsEditor na aba do CONTATO: mesmo
// gatilho, mesmo definir_cor, mesma recusa para papel abaixo de manager.

let papel = "manager";
const mutateSpy = vi.fn();

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { role: papel } }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: mutateSpy, isPending: false }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderEditor() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ContactTagsEditor contactId="k1" orgId="o1" tags={[]} />
    </QueryClientProvider>,
  );
}

describe("ContactTagsEditor — cor na criação (#2718)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("sem cor: o “+” só anexa a tag no contato", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText("Adicionar tag ao contato"), "vip");
    await user.click(screen.getByRole("button", { name: "Adicionar tag" }));
    expect(mutateSpy).toHaveBeenCalledWith({ tags: ["vip"] });
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("com cor: anexa E grava definir_cor com a mesma grafia", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole("button", { name: "Cor da etiqueta" }));
    await user.click(screen.getByRole("button", { name: "Azul" }));
    await user.type(screen.getByLabelText("Adicionar tag ao contato"), "vip");
    await user.click(screen.getByRole("button", { name: "Adicionar tag" }));
    expect(mutateSpy).toHaveBeenCalledWith({ tags: ["vip"] });
    expect(apiClient.post).toHaveBeenCalledWith("/api/v1/tags/vocabulario", {
      acao: "definir_cor",
      tag: "vip",
      destino: null,
      cor: "#0091ff",
    });
  });

  it("para papel agent o gatilho de cor não existe", () => {
    papel = "agent";
    renderEditor();
    expect(
      screen.queryByRole("button", { name: "Cor da etiqueta" }),
    ).not.toBeInTheDocument();
  });
});
