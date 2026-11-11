/**
 * A PORTA DO LEAD ADS NA TELA DA FONTE (issue #3768, doc 300).
 *
 * Três campos numa tela que já existe: a página, o token e a chave da busca.
 * O que cada caso guarda:
 *  - quem não administra não vê o campo do token (o PATCH cobra `admin`, e a
 *    chave é `settings.write`, o mesmo piso);
 *  - salvar manda o token de ida, com a página em branco como `null` (o servidor
 *    preenche com a página que o token lê), e o campo do token se esvazia;
 *  - a busca não liga sem token guardado.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LeadAdsDaMeta } from "@/app/app/webhooks/_components/LeadAdsDaMeta";
import type { WebhookSourceRow } from "@/hooks/webhooks/useWebhookSources";

const patch = vi.hoisted(() => vi.fn());
const permissao = vi.hoisted(() => vi.fn((_chave: string) => true));

vi.mock("@/lib/api/client", () => ({
  apiClient: { patch, get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (chave: string) => permissao(chave),
}));

const FONTE: WebhookSourceRow = {
  id: "src-1",
  organization_id: "org-1",
  name: "Anúncios",
  path_token: "tok-abc",
  is_active: true,
  authorize_ai_on_capture: false,
  update_existing_lead_on_capture: false,
  reuse_open_lead_on_capture: false,
  kind: "lead_capture",
  last_received_at: null,
  default_pipeline_id: "p-1",
  default_stage_id: "s-1",
  redirect_to: null,
  field_map: {},
  form_fields: [],
  has_secret: false,
  meta_page_id: null,
  meta_lead_retrieval: false,
  has_meta_page_token: false,
  created_at: "2026-11-10T10:00:00Z",
  updated_at: "2026-11-10T10:00:00Z",
  last_change_actor_kind: null,
  last_change_at: null,
};

function renderPorta(fonte: Partial<WebhookSourceRow> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LeadAdsDaMeta source={{ ...FONTE, ...fonte }} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  patch.mockReset();
  permissao.mockReset();
  permissao.mockImplementation((chave) => chave === "settings.write");
});

describe("Lead Ads na tela da fonte", () => {
  it("quem não administra não vê o token nem liga a busca", () => {
    permissao.mockImplementation(() => false);
    renderPorta();
    expect(screen.queryByLabelText("Token da página")).toBeNull();
    expect(screen.getByText("Só quem administra a organização liga esta opção.")).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect(permissao).toHaveBeenCalledWith("settings.write");
  });

  it("⭐ salvar manda o token com a página em branco, e mostra a página que o servidor gravou", async () => {
    patch.mockResolvedValue({ data: { ...FONTE, meta_page_id: "1029384756", has_meta_page_token: true } });
    const user = userEvent.setup();
    renderPorta();

    await user.type(screen.getByLabelText("Token da página"), "EAAB-token-da-pagina");
    await user.click(screen.getByRole("button", { name: "Salvar página e token" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[0]).toBe("/api/v1/webhook-sources/src-1");
    expect(patch.mock.calls[0]?.[1]).toEqual({ meta_page_id: null, meta_page_token: "EAAB-token-da-pagina" });
    await waitFor(() =>
      expect((screen.getByLabelText("Página do Facebook (id)") as HTMLInputElement).value).toBe("1029384756"),
    );
    expect((screen.getByLabelText("Token da página") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Remover token" })).toBeTruthy();
  });

  it("a busca não liga sem token guardado", () => {
    renderPorta();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  });

  it("com token guardado, ligar a busca manda só a chave", async () => {
    patch.mockResolvedValue({ data: { ...FONTE, has_meta_page_token: true, meta_lead_retrieval: true } });
    const user = userEvent.setup();
    renderPorta({ has_meta_page_token: true, meta_page_id: "1029384756" });
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[1]).toEqual({ meta_lead_retrieval: true });
  });
});
