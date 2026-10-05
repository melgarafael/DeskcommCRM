import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SourceDetail } from "@/app/app/webhooks/_components/SourceDetail";
import type { WebhookSourceRow } from "@/hooks/webhooks/useWebhookSources";

/**
 * A ASSINATURA DA FONTE SE CONFIGURA PELA TELA, E O SEGREDO APARECE UMA VEZ SÓ.
 *
 * O backend aceitava `PATCH { secret }` desde a migration 0041, mas nenhuma
 * tela mandava o campo: toda fonte criada pela interface nascia sem assinatura,
 * e só o `path_token` da URL protegia a captação — um endereço que vaza em
 * log de proxy, histórico de navegador e print de tela.
 *
 * O que cada caso guarda:
 *  - o valor SAI do navegador (o PATCH leva hex de 64 caracteres) e NUNCA volta:
 *    a tela só reexibe `has_secret`;
 *  - o plaintext não encosta em toast — toast sobrevive à troca de tela;
 *  - o botão de teste, que manda POST SEM assinatura, não é oferecido quando a
 *    assinatura está ligada: dali ele levaria 401 e leria como fonte quebrada;
 *  - o gate é `webhooks.manage`, a MESMA chave que `requireRole("manager")` da
 *    rota cobra. O dublê recebe a chave, e não só devolve booleano: sem isso,
 *    trocar a chave por qualquer outra deixaria a suíte verde (o
 *    `ACTION_MIN_ROLE` é `Record<string, Role>`, então nem o typecheck acusa).
 */

const patch = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const permissao = vi.hoisted(() => vi.fn((_chave: string) => true));
const copiado = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiClient: { patch, get, post: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (chave: string) => permissao(chave),
}));
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (texto: string) => {
    copiado(texto);
    return Promise.resolve(true);
  },
}));

const FONTE: WebhookSourceRow = {
  id: "src-1",
  organization_id: "org-1",
  name: "Landing page",
  path_token: "tok-abc",
  is_active: true,
  kind: "lead_capture",
  last_received_at: null,
  default_pipeline_id: "p-1",
  default_stage_id: "s-1",
  redirect_to: null,
  field_map: {},
  has_secret: false,
  created_at: "2026-09-30T10:00:00Z",
  updated_at: "2026-09-30T10:00:00Z",
  last_change_actor_kind: null,
  last_change_at: null,
};

function renderPainel(fonte: Partial<WebhookSourceRow> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SourceDetail source={{ ...FONTE, ...fonte }} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

/**
 * O hex de 64 caracteres que a tela mandou no corpo do PATCH.
 *
 * Lê a PRIMEIRA chamada: todo caso aqui dispara um PATCH só. Um caso futuro que
 * dispare dois leria o primeiro em silêncio — se precisar, receba o índice.
 */
function segredoEnviado(): string {
  const corpo = patch.mock.calls[0]?.[1] as { secret?: string } | undefined;
  return corpo?.secret ?? "";
}

beforeEach(() => {
  patch.mockReset();
  get.mockReset();
  get.mockResolvedValue({ data: [] });
  toastSuccess.mockReset();
  toastError.mockReset();
  copiado.mockReset();
  permissao.mockReset();
  permissao.mockImplementation((chave) => chave === "webhooks.manage");
});

describe("fonte de webhook — assinatura (HMAC)", () => {
  it("sem assinatura: badge Desligada e só o botão de gerar", () => {
    renderPainel({ has_secret: false });

    expect(screen.getByText("Desligada")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gerar segredo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Trocar segredo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remover segredo" })).toBeNull();
    // A chave exata, não "algum gate".
    expect(permissao).toHaveBeenCalledWith("webhooks.manage");
  });

  it("⭐ gerar manda 64 hex no PATCH, mostra o valor uma vez e liga o badge", async () => {
    patch.mockResolvedValue({ data: { ...FONTE, has_secret: true } });
    const user = userEvent.setup();
    renderPainel({ has_secret: false });

    await user.click(screen.getByRole("button", { name: "Gerar segredo" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    expect(patch.mock.calls[0]?.[0]).toBe("/api/v1/webhook-sources/src-1");
    // 32 bytes em hex. O tamanho importa: o schema da rota recusa < 16.
    expect(segredoEnviado()).toMatch(/^[0-9a-f]{64}$/);

    // O valor aparece na tela, com o aviso de que não volta.
    expect(await screen.findByText(segredoEnviado())).toBeTruthy();
    expect(screen.getByText("Guarde agora. Ele não será mostrado de novo.")).toBeTruthy();
    // E o badge segue a RESPOSTA do servidor, não um palpite otimista.
    await waitFor(() => expect(screen.getByText("Ligada")).toBeTruthy());
  });

  it("⭐ o valor não vai para o toast — toast sobrevive à troca de tela", async () => {
    patch.mockResolvedValue({ data: { ...FONTE, has_secret: true } });
    const user = userEvent.setup();
    renderPainel({ has_secret: false });

    await user.click(screen.getByRole("button", { name: "Gerar segredo" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

    const valor = segredoEnviado();
    for (const [texto] of toastSuccess.mock.calls) {
      expect(String(texto)).not.toContain(valor);
    }
    expect(toastSuccess).toHaveBeenCalledWith("Assinatura ligada.");
  });

  it("copiar leva o valor para a área de transferência, e só ele", async () => {
    patch.mockResolvedValue({ data: { ...FONTE, has_secret: true } });
    const user = userEvent.setup();
    renderPainel({ has_secret: false });

    await user.click(screen.getByRole("button", { name: "Gerar segredo" }));
    // Pelo `screen`, e não pelo `container` do render: o Sheet do Radix vai
    // para um portal no <body>, fora da árvore que o render devolve.
    const codigo = await screen.findByText(segredoEnviado());

    // O botão de copiar da seção da assinatura: o irmão do <code> do segredo.
    await user.click(codigo.parentElement!.querySelector("button")!);

    await waitFor(() => expect(copiado).toHaveBeenCalledWith(segredoEnviado()));
  });

  it("⭐ com assinatura ligada, a tela abre sem valor nenhum", () => {
    renderPainel({ has_secret: true });

    expect(screen.getByText("Ligada")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trocar segredo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remover segredo" })).toBeTruthy();
    expect(screen.queryByText("Guarde agora. Ele não será mostrado de novo.")).toBeNull();
    // Nenhum hex de 64 caracteres em lugar nenhum da tela — a leitura da API
    // devolve `has_secret`, nunca o valor, e a tela não inventa um.
    //
    // Pelo `document.body`, e não pelo `container` do render: o Sheet do Radix
    // é portal, e o `container` volta VAZIO. Um `not.toMatch` contra o vazio
    // passa sempre — foi o que esta asserção media antes de olharem para ela.
    expect(document.body.textContent ?? "").not.toMatch(/[0-9a-f]{64}/);
    expect(document.body.textContent).toContain("Assinatura (HMAC)");
  });

  it("⭐ com assinatura ligada, o teste sem assinatura não é oferecido", () => {
    renderPainel({ has_secret: true });

    const botao = screen.getByRole("button", { name: "Enviar lead de teste" });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Com assinatura ativa, teste a partir do sistema que envia os dados."),
    ).toBeTruthy();
  });

  it("CONTROLE: sem assinatura, o teste continua clicável", () => {
    renderPainel({ has_secret: false });

    const botao = screen.getByRole("button", { name: "Enviar lead de teste" });
    expect((botao as HTMLButtonElement).disabled).toBe(false);
  });

  it("trocar avisa que as integrações param, e só então gera outro", async () => {
    patch.mockResolvedValue({ data: { ...FONTE, has_secret: true } });
    const user = userEvent.setup();
    renderPainel({ has_secret: true });

    await user.click(screen.getByRole("button", { name: "Trocar segredo" }));
    expect(
      await screen.findByText(
        "Integrações que usam o segredo atual vão parar de funcionar até serem atualizadas.",
      ),
    ).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Trocar" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(segredoEnviado()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("remover manda secret nulo e apaga o valor da tela", async () => {
    patch.mockResolvedValue({ data: { ...FONTE, has_secret: false } });
    const user = userEvent.setup();
    renderPainel({ has_secret: true });

    await user.click(screen.getByRole("button", { name: "Remover segredo" }));
    await user.click(await screen.findByRole("button", { name: "Remover" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/api/v1/webhook-sources/src-1", { secret: null });
    await waitFor(() => expect(screen.getByText("Desligada")).toBeTruthy());
  });

  it("⭐ PATCH que falha não mente: a tela continua no estado de antes", async () => {
    // O caso que a instalação self-host encontra de verdade: a rota devolve 422
    // `encryption_unavailable` quando a chave de cifra não está ativa. O
    // `onSuccess` não roda, então nada pode ter mudado na tela — e, acima de
    // tudo, nenhum valor pode aparecer: um segredo exibido como se tivesse sido
    // gravado faria o integrador configurar o outro lado com um valor que o
    // servidor não conhece.
    patch.mockRejectedValue(new Error("encryption_unavailable"));
    const user = userEvent.setup();
    renderPainel({ has_secret: false });

    await user.click(screen.getByRole("button", { name: "Gerar segredo" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    expect(screen.getByText("Desligada")).toBeTruthy();
    expect(screen.queryByText("Guarde agora. Ele não será mostrado de novo.")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/[0-9a-f]{64}/);
    expect(toastSuccess).not.toHaveBeenCalled();
    // O botão continua oferecido: a falha é do servidor, e tentar de novo é a
    // ação certa depois de ligar a chave de cifra.
    expect(screen.getByRole("button", { name: "Gerar segredo" })).toBeTruthy();
  });

  it("o snippet de curl ensina a assinatura quando ela está ligada", () => {
    // A seção "Para desenvolvedores" existe para ensinar a integrar. Um exemplo
    // sem o cabeçalho, numa fonte que exige assinatura, ensina a levar 401.
    const { unmount } = renderPainel({ has_secret: true });
    expect(document.body.textContent).toContain("x-deskcomm-signature");
    unmount();

    renderPainel({ has_secret: false });
    expect(document.body.textContent).not.toContain("x-deskcomm-signature:");
  });

  it("⭐ quem não gere webhooks não vê botão de assinatura nenhum", () => {
    permissao.mockImplementation(() => false);
    renderPainel({ has_secret: true });

    // O estado continua legível — esconder o botão não é esconder o fato.
    expect(screen.getByText("Ligada")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Trocar segredo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remover segredo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Gerar segredo" })).toBeNull();
  });
});
