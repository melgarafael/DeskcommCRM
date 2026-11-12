/**
 * O CONSENTIMENTO POR ÁREA NA TELA (spec 33, F3, tarefa 5).
 *
 * O que fica provado: a tela lista SÓ as áreas que o pacote declarou, com a frase em português simples;
 * avisa as sensíveis; mostra o consentimento atual; deixa alterar quem administra a organização e, para
 * os demais, mostra o mesmo consentimento travado COM o motivo. A barreira de verdade é a rota e a função
 * do banco (testadas à parte): esta tela só não oferece o que seria recusado.
 *
 * E, no gestor, o corpo REAL do `PUT` à rota de consentimento: revisão do vínculo e lista de áreas, com a
 * organização no cabeçalho e nunca no corpo.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { PermissaoDeArea } from "@/lib/extensions/portas-legiveis";
import type { ExtensionListView, InstalledExtensionView } from "@/lib/extensions/view";

import { ConsentimentoPorArea } from "./ConsentimentoPorArea";
import { ExtensionsManager } from "./ExtensionsManager";

const { router, toast } = vi.hoisted(() => ({
  router: { refresh: vi.fn() },
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast }));

const ACTOR = "00000000-0000-4000-8000-000000000010";
const ORG = "00000000-0000-4000-8000-000000000001";
const INSTALACAO = "00000000-0000-4000-8000-000000000003";
const CATALOGO = "00000000-0000-4000-8000-000000000009";

function conectada(overrides: Partial<InstalledExtensionView> = {}): InstalledExtensionView {
  return {
    id: INSTALACAO,
    catalog_id: CATALOGO,
    origin: "https://extensions.example/catalog.json",
    publisher: "equipe-exemplo",
    name: "modulo-conectado",
    version: "1.0.0",
    display: {
      title: { "pt-BR": "Módulo conectado" },
      summary: { "pt-BR": "Fala com o CRM." },
      category: "sales",
      icon: "ListChecks",
    },
    permissions: [
      "area.contatos.leitura",
      "area.contatos.escrita",
      "area.configuracao.leitura",
    ],
    enabled: true,
    revision: 3,
    configuration: { density: "comfortable", show_description: true },
    theme_palette: null,
    compatible: true,
    compatibility_reason: null,
    installation_revision: 1,
    previous: null,
    active_organizations: 1,
    removed_at: null,
    deactivated_by_removal_at: null,
    profile: "connected",
    disabled_at: null,
    consented_areas: ["area.contatos.leitura"],
    ...overrides,
  };
}

function montar(
  props: Partial<React.ComponentProps<typeof ConsentimentoPorArea>> = {},
  extension: InstalledExtensionView = conectada(),
) {
  const onSave = vi.fn().mockResolvedValue(true);
  render(
    <IdiomaProvider locale="pt-BR">
      <ConsentimentoPorArea
        extension={extension}
        canEdit
        blockedReason="Só um administrador da organização pode alterar este consentimento."
        actionsDisabled={false}
        onSave={onSave}
        {...props}
      />
    </IdiomaProvider>,
  );
  return { onSave };
}

const caixa = (area: string) => screen.getByTestId(`extension-consent-${INSTALACAO}-${area}`);

beforeEach(() => {
  window.localStorage.clear();
  toast.error.mockReset();
  toast.success.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConsentimentoPorArea", () => {
  it("lista só as áreas declaradas, em frases simples, e marca o consentimento atual", () => {
    montar();
    expect(screen.getByText("Ver seus contatos: nomes, telefones, etiquetas e empresas.")).toBeTruthy();
    expect(screen.getByText("Criar e alterar contatos, etiquetas e empresas.")).toBeTruthy();
    expect(
      screen.getByText(/Ver as configurações da organização e da equipe\./),
    ).toBeTruthy();
    // Não declaradas não aparecem, mesmo existindo no vocabulário.
    expect(screen.queryByText("Ver relatórios e números de desempenho.")).toBeNull();
    expect(screen.queryByTestId(`extension-consent-${INSTALACAO}-area.analise.leitura`)).toBeNull();
    expect((caixa("area.contatos.leitura") as HTMLInputElement).checked).toBe(true);
    expect((caixa("area.contatos.escrita") as HTMLInputElement).checked).toBe(false);
    expect((caixa("area.configuracao.leitura") as HTMLInputElement).checked).toBe(false);
  });

  it("avisa que configuração, agentes de IA e financeiro são sensíveis, só quando declarados", () => {
    montar();
    expect(screen.getByTestId(`extension-consent-sensitive-${INSTALACAO}`).textContent).toContain(
      "Configuração, agentes de IA e financeiro são áreas sensíveis",
    );
    cleanup();
    montar({}, conectada({ permissions: ["area.contatos.leitura"] }));
    expect(screen.queryByTestId(`extension-consent-sensitive-${INSTALACAO}`)).toBeNull();
  });

  it("salvar fica desligado até mudar, e envia a lista marcada", async () => {
    const user = userEvent.setup();
    const { onSave } = montar();
    const salvar = screen.getByTestId(`extension-consent-save-${INSTALACAO}`) as HTMLButtonElement;
    expect(salvar.disabled).toBe(true);

    await user.click(caixa("area.contatos.escrita"));
    expect(salvar.disabled).toBe(false);
    await user.click(salvar);

    expect(onSave).toHaveBeenCalledTimes(1);
    const [alvo, areas] = onSave.mock.calls[0] as [InstalledExtensionView, PermissaoDeArea[]];
    expect(alvo.id).toBe(INSTALACAO);
    expect([...areas].sort()).toEqual(["area.contatos.escrita", "area.contatos.leitura"]);
  });

  it("retirar a última área envia lista vazia", async () => {
    const user = userEvent.setup();
    const { onSave } = montar();
    await user.click(caixa("area.contatos.leitura"));
    await user.click(screen.getByTestId(`extension-consent-save-${INSTALACAO}`));
    expect(onSave.mock.calls[0]?.[1]).toEqual([]);
  });

  it("financeiro é sensível: vem desmarcada na primeira vez, com o selo, e tarefas vem marcada", () => {
    montar(
      {},
      conectada({
        consented_areas: [],
        permissions: ["area.tarefas.leitura", "area.financeiro.leitura", "area.financeiro.escrita"],
      }),
    );
    expect((caixa("area.financeiro.leitura") as HTMLInputElement).checked).toBe(false);
    expect((caixa("area.financeiro.escrita") as HTMLInputElement).checked).toBe(false);
    expect((caixa("area.tarefas.leitura") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId(`extension-consent-sensitive-${INSTALACAO}`)).toBeTruthy();
    expect(screen.getAllByText("Sensível")).toHaveLength(2);
  });

  it("primeira vez: propõe o que o pacote pede, menos as sensíveis, e o botão é Consentir", async () => {
    const user = userEvent.setup();
    const { onSave } = montar({}, conectada({ consented_areas: [] }));
    expect((caixa("area.contatos.leitura") as HTMLInputElement).checked).toBe(true);
    expect((caixa("area.contatos.escrita") as HTMLInputElement).checked).toBe(true);
    // Sensível não vem marcada: quem administra marca de propósito.
    expect((caixa("area.configuracao.leitura") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId(`extension-consent-proposal-${INSTALACAO}`).textContent).toContain(
      "Nada é liberado antes disso",
    );
    const botao = screen.getByTestId(`extension-consent-save-${INSTALACAO}`) as HTMLButtonElement;
    expect(botao.textContent).toContain("Consentir");
    expect(botao.disabled).toBe(false);
    // Consentir menos: tira uma marca e confirma.
    await user.click(caixa("area.contatos.escrita"));
    await user.click(botao);
    expect([...(onSave.mock.calls[0]?.[1] as string[])].sort()).toEqual(["area.contatos.leitura"]);
  });

  it("depois de consentir, a proposta some e o botão volta a ser Salvar áreas", () => {
    montar();
    expect(screen.queryByTestId(`extension-consent-proposal-${INSTALACAO}`)).toBeNull();
    expect(screen.getByTestId(`extension-consent-save-${INSTALACAO}`).textContent).toContain(
      "Salvar áreas",
    );
  });

  it("quem não administra não recebe proposta: vê só o que está gravado", () => {
    montar({ canEdit: false }, conectada({ consented_areas: [] }));
    expect((caixa("area.contatos.leitura") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId(`extension-consent-proposal-${INSTALACAO}`)).toBeNull();
  });

  it("quem não administra vê o consentimento atual travado, com o motivo, sem botão de salvar", () => {
    montar({ canEdit: false });
    for (const area of [
      "area.contatos.leitura",
      "area.contatos.escrita",
      "area.configuracao.leitura",
    ]) {
      expect((caixa(area) as HTMLInputElement).disabled).toBe(true);
    }
    expect((caixa("area.contatos.leitura") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId(`extension-consent-reason-${INSTALACAO}`).textContent).toContain(
      "Só um administrador da organização pode alterar este consentimento.",
    );
    expect(screen.queryByTestId(`extension-consent-save-${INSTALACAO}`)).toBeNull();
  });

  it("módulo não ativado: nada a marcar ainda, e a tela diz para ativar", () => {
    montar({}, conectada({ enabled: false, consented_areas: [] }));
    expect((caixa("area.contatos.leitura") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId(`extension-consent-reason-${INSTALACAO}`).textContent).toContain(
      "Ative o módulo nesta organização para escolher as áreas.",
    );
    expect(screen.queryByTestId(`extension-consent-save-${INSTALACAO}`)).toBeNull();
  });

  it("pacote sem área declarada: diz isso e não oferece caixa", () => {
    montar({}, conectada({ permissions: ["theme.apply"], consented_areas: [] }));
    expect(screen.getByTestId(`extension-consent-none-${INSTALACAO}`)).toBeTruthy();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("consentimento guardado de área que o pacote já não declara não aparece nem é reenviado", async () => {
    const user = userEvent.setup();
    const { onSave } = montar(
      {},
      conectada({ consented_areas: ["area.contatos.leitura", "area.analise.escrita"] }),
    );
    await user.click(caixa("area.contatos.escrita"));
    await user.click(screen.getByTestId(`extension-consent-save-${INSTALACAO}`));
    const areas = onSave.mock.calls[0]?.[1] as string[];
    expect(areas).not.toContain("area.analise.escrita");
  });
});

describe("ConsentimentoPorArea no gestor de extensões", () => {
  function lista(item: InstalledExtensionView, canManage = true): ExtensionListView {
    return {
      organization_id: ORG,
      can_manage: canManage,
      can_install: false,
      catalogs: [],
      installations: [item],
      removed_installations: [],
      operations: [],
    };
  }
  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("salvar envia PUT /consentimento com a revisão do vínculo e as áreas, a organização só no cabeçalho", async () => {
    const pedidos: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      pedidos.push({ url, init });
      if (url.endsWith("/consentimento")) {
        return Promise.resolve(
          json({
            data: {
              installation_id: INSTALACAO,
              revision: 4,
              consented_areas: ["area.contatos.escrita", "area.contatos.leitura"],
            },
          }),
        );
      }
      return Promise.resolve(json({ data: lista(conectada()) }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(
      <IdiomaProvider locale="pt-BR">
        <ExtensionsManager organizationId={ORG} actorId={ACTOR} />
      </IdiomaProvider>,
    );
    await screen.findByTestId(`extension-installed-${INSTALACAO}`);
    await user.click(caixa("area.contatos.escrita"));
    await user.click(screen.getByTestId(`extension-consent-save-${INSTALACAO}`));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Áreas do módulo salvas."));
    const put = pedidos.find((p) => p.url.endsWith("/consentimento"));
    expect(put?.url).toBe(`/api/v1/extensions/${INSTALACAO}/consentimento`);
    expect(put?.init?.method).toBe("PUT");
    const corpo = JSON.parse(String(put?.init?.body)) as Record<string, unknown>;
    expect(Object.keys(corpo).sort()).toEqual(["areas", "expected_revision"]);
    expect(corpo.expected_revision).toBe(3);
    expect([...(corpo.areas as string[])].sort()).toEqual([
      "area.contatos.escrita",
      "area.contatos.leitura",
    ]);
    expect(new Headers(put?.init?.headers).get("X-Expected-Organization-Id")).toBe(ORG);
  });

  it("conflito de revisão: recarrega e avisa, sem dizer que salvou", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith("/consentimento")) {
        return Promise.resolve(
          json(
            { error: { code: "extension_revision_conflict", message: "A configuração mudou." } },
            409,
          ),
        );
      }
      return Promise.resolve(json({ data: lista(conectada()) }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(
      <IdiomaProvider locale="pt-BR">
        <ExtensionsManager organizationId={ORG} actorId={ACTOR} />
      </IdiomaProvider>,
    );
    await screen.findByTestId(`extension-installed-${INSTALACAO}`);
    await user.click(caixa("area.contatos.escrita"));
    await user.click(screen.getByTestId(`extension-consent-save-${INSTALACAO}`));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0]?.[0]).toContain("Outra pessoa alterou esta extensão");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("quem não administra (can_manage falso) vê as áreas travadas e nenhum PUT sai", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: lista(conectada(), false) }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <IdiomaProvider locale="pt-BR">
        <ExtensionsManager organizationId={ORG} actorId={ACTOR} />
      </IdiomaProvider>,
    );
    await screen.findByTestId(`extension-installed-${INSTALACAO}`);
    expect((caixa("area.contatos.leitura") as HTMLInputElement).disabled).toBe(true);
    expect((caixa("area.contatos.leitura") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId(`extension-consent-reason-${INSTALACAO}`).textContent).toContain(
      "Só um administrador da organização",
    );
    expect(screen.queryByTestId(`extension-consent-save-${INSTALACAO}`)).toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/consentimento"))).toBe(false);
  });
});
