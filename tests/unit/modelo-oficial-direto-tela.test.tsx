import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Auth from "@/hooks/auth/AuthProvider";

/**
 * A TELA DO CANAL OFICIAL DIRETO — criar, editar e apagar modelo pelo CRM
 * (#3635 fatia 1).
 *
 * ─── O que muda para quem opera ────────────────────────────────────────────
 *
 * Antes: sair do CRM, criar no Gerenciador do WhatsApp, esperar a aprovação e
 * voltar para "Sincronizar". Agora: "Criar modelo" na própria aba, e Editar /
 * Apagar em cada modelo da lista — o mesmo formulário do canal de parceiro, com a
 * credencial da SESSÃO resolvida no servidor.
 *
 * ─── O que este arquivo prende ─────────────────────────────────────────────
 *
 * Que os botões existam, que o formulário abra no modelo escolhido, e que o
 * corpo enviado seja `{acao}` + a definição — é a rota que decide a conta. E que
 * o "em uso" (409) NÃO feche a caixa: é ali que o operador vê onde o modelo está
 * antes de apagar.
 */
const h = vi.hoisted(() => ({
  post: vi.fn(),
  sync: vi.fn(),
  salvar: vi.fn(),
  toasts: [] as string[],
  localeDaOrg: null as string | null,
}));

vi.mock("@/hooks/auth/AuthProvider", async (original) => ({
  ...(await original<typeof Auth>()),
  useLocaleDaOrgAtiva: () => h.localeDaOrg,
}));

vi.mock("@/lib/api/client", () => ({ apiClient: { post: h.post } }));
vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => h.toasts.push(`ok:${m}`),
    error: (m: string) => h.toasts.push(`erro:${m}`),
  },
}));
vi.mock("@/hooks/channels/useTemplates", () => ({
  useTemplates: () => ({
    isPending: false,
    data: {
      data: {
        waba: "WABA-1",
        templates: [
          {
            name: "boas_vindas",
            language: "pt_BR",
            status: "APPROVED",
            category: "UTILITY",
            rejectedReason: null,
            qualityScore: "GREEN",
            parameterFormat: "POSITIONAL",
            contractHash: "h",
            syncedAt: "2026-10-01T00:00:00.000Z",
            slots: [],
            previews: [] as unknown[],
            savedValues: {},
            components: [{ type: "BODY", text: "Olá {{1}}, seu pedido saiu." }],
            daConexao: true,
          },
          {
            // Do espelho da organização, mas da conexão do PARCEIRO.
            name: "pedido_do_parceiro",
            language: "es",
            status: "APPROVED",
            category: "UTILITY",
            rejectedReason: null,
            qualityScore: "GREEN",
            parameterFormat: "POSITIONAL",
            contractHash: "h2",
            syncedAt: "2026-10-01T00:00:00.000Z",
            slots: [],
            previews: [] as unknown[],
            savedValues: {},
            components: [{ type: "BODY", text: "Hola." }],
            daConexao: false,
          },
        ],
      },
    },
  }),
  useSyncTemplates: () => ({ mutateAsync: h.sync, isPending: false }),
  useSaveTemplateValues: () => ({ mutate: h.salvar, isPending: false }),
}));

import { TemplatesClient } from "@/components/connections/TemplatesClient";
import { ApiError } from "@/lib/api/types";

// Cada caso mede a PRÓPRIA chamada: sem isto, o `calls[0]` de um caso é a
// chamada do anterior e a asserção passa (ou falha) pelo motivo errado.
beforeEach(() => {
  vi.clearAllMocks();
  h.localeDaOrg = null;
});

function montar() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TemplatesClient />
    </QueryClientProvider>,
  );
}

describe("tela do canal oficial direto — gestão de modelo", () => {
  it("⭐ cria pela tela: o corpo sai com `acao: criar` e a definição montada", async () => {
    h.post.mockResolvedValue({ data: {} });
    montar();

    fireEvent.click(screen.getByTestId("btn-criar-modelo"));
    const form = document.querySelector('[data-formulario-do-modelo="criar"]') as HTMLElement;
    expect(form).toBeTruthy();

    fireEvent.change(within(form).getByLabelText("Nome do modelo"), {
      target: { value: "pedido_saiu" },
    });
    fireEvent.change(within(form).getByLabelText("Conteúdo"), {
      target: { value: "Olá {{1}}, seu pedido saiu." },
    });
    fireEvent.change(within(form).getByLabelText("Exemplo do valor 1"), {
      target: { value: "Ana" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Enviar para revisão" }));

    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    const [url, corpo] = h.post.mock.calls[0]!;
    // A MESMA rota do "Sincronizar": é ela que resolve a conta pela sessão.
    expect(url).toBe("/api/v1/channels/templates");
    // O idioma nasce no da organização — sem organização ativa, o padrão do
    // produto (pt-BR), e não o "es" herdado da tela do parceiro.
    expect(corpo).toMatchObject({ acao: "criar", name: "pedido_saiu", language: "pt_BR", category: "UTILITY" });
    const body = (corpo.components as { type: string; text: string; example?: unknown }[]).find(
      (c) => c.type === "BODY",
    );
    expect(body?.text).toBe("Olá {{1}}, seu pedido saiu.");
    // O exemplo SEM o qual a revisão recusa a definição.
    expect(body?.example).toEqual({ body_text: [["Ana"]] });
  });

  it("⭐ editar abre o formulário COM o texto aprovado e manda `acao: editar`", async () => {
    h.post.mockResolvedValue({ data: {} });
    montar();

    fireEvent.click(screen.getByRole("button", { name: "Editar" }));

    const form = document.querySelector('[data-formulario-do-modelo="editar"]') as HTMLElement;
    expect(form).toBeTruthy();
    const corpo = within(form).getByLabelText("Conteúdo") as HTMLTextAreaElement;
    // Nasce do modelo escolhido, não vazio: quem edita uma vírgula não redigita.
    expect(corpo.value).toBe("Olá {{1}}, seu pedido saiu.");

    fireEvent.click(within(form).getByRole("button", { name: "Salvar e enviar para revisão" }));

    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    const corpoEnviado = h.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(corpoEnviado).toMatchObject({ acao: "editar", name: "boas_vindas", language: "pt_BR" });
    // Nome e idioma NÃO vão como campo editável: a plataforma não deixa mudá-los.
    expect(corpoEnviado.category).toBeUndefined();
  });

  it("⭐ apagar pede confirmação e manda `acao: apagar`", async () => {
    h.post.mockResolvedValue({ data: {} });
    montar();

    fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
    const caixa = await screen.findByRole("alertdialog");
    expect(within(caixa).getByText(/boas_vindas/)).toBeTruthy();

    fireEvent.click(within(caixa).getByRole("button", { name: "Apagar" }));

    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    expect(h.post.mock.calls[0]![1]).toMatchObject({
      acao: "apagar",
      name: "boas_vindas",
      language: "pt_BR",
      confirmado: false,
    });
  });

  it("⭐ modelo EM USO mantém a caixa aberta, mostrando onde ele está", async () => {
    h.post.mockRejectedValue(
      new ApiError(409, "template_in_use", { usos: ["Follow-up «Remarketing»"] }, "req-1", "em uso"),
    );
    montar();

    fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
    let caixa = await screen.findByRole("alertdialog");
    fireEvent.click(within(caixa).getByRole("button", { name: "Apagar" }));

    // A caixa NÃO fecha: a lista de usos é a informação que a rota devolveu.
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    caixa = screen.getByRole("alertdialog");
    expect(within(caixa).getByText("Follow-up «Remarketing»")).toBeTruthy();
    // E o botão passa a ser o de confirmar assim mesmo.
    expect(within(caixa).getByRole("button", { name: "Apagar assim mesmo" })).toBeTruthy();
  });

  it("⭐ o idioma do modelo novo nasce no idioma da organização", () => {
    // Nem o padrão (pt_BR) nem o "es" herdado: só passa se ler a organização.
    h.localeDaOrg = "en";
    montar();

    fireEvent.click(screen.getByTestId("btn-criar-modelo"));
    const form = document.querySelector('[data-formulario-do-modelo="criar"]') as HTMLElement;
    expect((within(form).getByLabelText("Idioma") as HTMLSelectElement).value).toBe("en");
  });

  it("⭐ modelo de OUTRA conexão aparece sem Editar nem Apagar", () => {
    montar();

    const cards = screen.getAllByTestId("template-card");
    expect(cards).toHaveLength(2);
    const [daConexao, doParceiro] = cards as [HTMLElement, HTMLElement];
    expect(within(daConexao).getByRole("button", { name: "Editar" })).toBeTruthy();
    expect(within(daConexao).getByRole("button", { name: "Apagar" })).toBeTruthy();
    expect(within(doParceiro).queryByRole("button", { name: "Editar" })).toBeNull();
    expect(within(doParceiro).queryByRole("button", { name: "Apagar" })).toBeNull();
  });

  it("a linha de ações quebra em tela estreita em vez de estourar a largura", () => {
    montar();
    // 375px: "Sincronizar com a Meta" + "Criar modelo" ao lado do texto empurrava
    // o botão até 463px. A prova de verdade é medida na tela; isto prende as classes.
    const acoes = screen.getByTestId("btn-criar-modelo").parentElement as HTMLElement;
    expect(acoes.className).toContain("flex-wrap");
    expect((acoes.parentElement as HTMLElement).className).toContain("flex-wrap");
  });
});

describe("idioma inicial do modelo", () => {
  it("segue o idioma da organização e cai no padrão do produto fora da lista", async () => {
    const { idiomaInicialDaDefinicao } = await import("@/lib/channels/template-conteudo");
    expect(idiomaInicialDaDefinicao("pt-BR")).toBe("pt_BR");
    expect(idiomaInicialDaDefinicao("es")).toBe("es");
    expect(idiomaInicialDaDefinicao("es-PY")).toBe("es");
    expect(idiomaInicialDaDefinicao("en")).toBe("en");
    expect(idiomaInicialDaDefinicao("zh-CN")).toBe("pt_BR");
    expect(idiomaInicialDaDefinicao(null)).toBe("pt_BR");
  });
});
