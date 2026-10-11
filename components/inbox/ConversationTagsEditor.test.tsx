import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationTagsEditor } from "./ConversationTagsEditor";
import { apiClient } from "@/lib/api/client";

// Issue #2718 — com tom escolhido, o "+" anexa a tag NA CONVERSA e grava a
// cor NO VOCABULÁRIO (definir_cor) com o nome canônico; sem tom, o POST não
// acontece e o comportamento é o de antes.

let papel = "manager";
const mutateSpy = vi.fn();

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { role: papel } }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: mutateSpy, isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
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
      <ConversationTagsEditor conversationId="c1" orgId="o1" tags={[]} />
    </QueryClientProvider>,
  );
}

describe("ConversationTagsEditor — cor na criação (#2718)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("sem cor: o “+” só anexa a tag (nenhum POST de vocabulário)", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText("Adicionar tag à conversa"), "vip");
    await user.click(screen.getByRole("button", { name: "Adicionar tag" }));
    expect(mutateSpy).toHaveBeenCalledWith({ conversation_id: "c1", tags: ["vip"] });
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("com cor: anexa E grava definir_cor com o nome canônico", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole("button", { name: "Cor da etiqueta" }));
    await user.click(screen.getByRole("button", { name: "Roxo" }));
    await user.type(screen.getByLabelText("Adicionar tag à conversa"), "VIP");
    await user.click(screen.getByRole("button", { name: "Adicionar tag" }));
    expect(mutateSpy).toHaveBeenCalledWith({ conversation_id: "c1", tags: ["vip"] });
    expect(apiClient.post).toHaveBeenCalledWith("/api/v1/tags/vocabulario", {
      acao: "definir_cor",
      tag: "vip",
      destino: null,
      cor: "#ab4aba",
    });
  });

  it("para papel agent o gatilho de cor não existe (a rota recusaria)", async () => {
    papel = "agent";
    renderEditor();
    expect(
      screen.queryByRole("button", { name: "Cor da etiqueta" }),
    ).not.toBeInTheDocument();
  });
});
