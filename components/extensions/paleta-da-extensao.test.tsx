/**
 * A PALETA DA EXTENSÃO NA TELA, E O QUE O SALVAMENTO NÃO PODE APAGAR (issue #3792).
 *
 * ─── Os dois defeitos, medidos aqui ─────────────────────────────────────────
 *
 *   1. O tema de uma extensão só vale quando `configuration.theme` é igual à
 *      paleta que o manifesto declara (`temaAplicavel`, `lib/extensions/tema.ts`),
 *      e NENHUMA tela oferecia esse campo: só a API (`PUT /api/v1/extensions/
 *      :id/configuration` com `theme`) ligava o tema. O cartão da extensão
 *      instalada passa a oferecer a paleta do MANIFESTO — não uma lista fixa:
 *      o campo nasce de `theme_palette`, e a extensão que não declara tema não
 *      ganha campo nenhum.
 *   2. O save da tela montava o corpo a partir dos dois campos que ela edita.
 *      Como a rota substitui a configuração inteira, ajustar "Densidade dos
 *      cards" e salvar APAGAVA o tema ligado pela API — e o tema da organização
 *      sumia sem aviso.
 *
 * ─── O que este arquivo prova ──────────────────────────────────────────────
 *
 * O corpo REAL do `PUT` (a rota de configuração), capturado do `fetch`: o tema
 * sobrevive ao salvamento da densidade; escolher a paleta grava `theme`;
 * escolher "Nenhuma" tira a chave; a extensão sem tema no manifesto não recebe
 * o campo e o corpo dela não inventa `theme`.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type {
  ExtensionListView,
  ExtensionOperationView,
  InstalledExtensionView,
} from "@/lib/extensions/view";

import { ExtensionsManager } from "./ExtensionsManager";

const { router, toast } = vi.hoisted(() => ({
  router: { refresh: vi.fn() },
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast }));

const ACTOR = "00000000-0000-4000-8000-000000000010";
const ORG_A = "00000000-0000-4000-8000-000000000001";
const INSTALLATION = "00000000-0000-4000-8000-000000000003";
const CATALOG = "00000000-0000-4000-8000-000000000009";

// O Radix Select usa as Pointer Events API que o jsdom não implementa.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

function installation(overrides: Partial<InstalledExtensionView> = {}): InstalledExtensionView {
  return {
    id: INSTALLATION,
    catalog_id: CATALOG,
    origin: "https://extensions.example/catalog.json",
    publisher: "equipe-exemplo",
    name: "rotina-comercial",
    version: "1.0.0",
    display: {
      title: { "pt-BR": "Rotina comercial" },
      summary: { "pt-BR": "Organiza o trabalho." },
      category: "sales",
      icon: "ListChecks",
    },
    permissions: ["navigation.tasks"],
    enabled: false,
    revision: 1,
    configuration: { density: "comfortable", show_description: true },
    theme_palette: null,
    compatible: true,
    compatibility_reason: null,
    installation_revision: 1,
    previous: null,
    active_organizations: 1,
    removed_at: null,
    deactivated_by_removal_at: null,
    ...overrides,
  };
}

function list(item: InstalledExtensionView = installation()): ExtensionListView {
  return {
    organization_id: ORG_A,
    can_manage: true,
    can_install: false,
    catalogs: [],
    installations: [item],
    removed_installations: [],
    operations: [],
  };
}

function operation(id: string): ExtensionOperationView {
  return {
    id,
    organization_id: ORG_A,
    actor_id: ACTOR,
    kind: "configure",
    status: "completed",
    catalog_id: null,
    installation_id: INSTALLATION,
    publisher: "equipe-exemplo",
    name: "rotina-comercial",
    version: "1.0.0",
    error_code: null,
    error_message: null,
    from_revision: null,
    from_version: null,
    to_version: null,
    organizations_affected: null,
    created_at: "2026-09-15T00:00:00.000Z",
    updated_at: "2026-09-15T00:01:00.000Z",
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Monta o gestor e devolve o corpo do PRIMEIRO `PUT` de configuração. */
async function salvarCartao(
  item: InstalledExtensionView,
  mexer: (user: ReturnType<typeof userEvent.setup>) => Promise<void>,
): Promise<Record<string, unknown>> {
  let corpo: Record<string, unknown> = {};
  let entregar: (valor: Record<string, unknown>) => void = () => {};
  const enviado = new Promise<Record<string, unknown>>((resolve) => {
    entregar = resolve;
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ data: list(item) }))
    .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
      corpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
      entregar(corpo);
      // O recibo tem de ser o DESTA operação (a chave de idempotência que o gestor
      // enviou): recibo de outro id invalida o contexto e a tela sai do lugar.
      const id = new Headers(init?.headers).get("Idempotency-Key") ?? "";
      return Promise.resolve(json({ data: operation(id) }));
    })
    .mockResolvedValue(json({ data: list(item) }));
  vi.stubGlobal("fetch", fetchMock);

  const user = userEvent.setup();
  render(
    <IdiomaProvider locale="pt-BR">
      <ExtensionsManager organizationId={ORG_A} actorId={ACTOR} />
    </IdiomaProvider>,
  );
  await screen.findByTestId(`extension-installed-${INSTALLATION}`);
  await mexer(user);
  await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));
  // A prova é o CORPO ENVIADO à rota de configuração, não o recibo: o card remonta
  // com a revisão nova depois do salvamento, e o que importa é o que saiu daqui.
  return enviado;
}

beforeEach(() => {
  window.localStorage.clear();
  toast.error.mockReset();
  toast.info.mockReset();
  toast.success.mockReset();
  toast.warning.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("paleta da extensão no cartão (issue #3792)", () => {
  it("salvar a densidade PRESERVA o tema que a organização ligou pela API", async () => {
    // Quem ligou o tema pela API e depois ajusta a densidade perdia a paleta: o corpo
    // do PUT saía só com os dois campos do formulário.
    const corpo = await salvarCartao(
      installation({
        configuration: { density: "comfortable", show_description: true, theme: "sage" },
        theme_palette: "sage",
      }),
      async (user) => {
        await user.click(screen.getByTestId(`extension-density-${INSTALLATION}`));
        await user.click(await screen.findByRole("option", { name: "Compacta" }));
      },
    );

    expect(corpo).toEqual({
      expected_revision: 1,
      enabled: false,
      configuration: { density: "compact", show_description: true, theme: "sage" },
    });
  });

  it("a paleta que o MANIFESTO declara aparece no cartão e, escolhida, grava o tema", async () => {
    const corpo = await salvarCartao(installation({ theme_palette: "clay" }), async (user) => {
      await user.click(screen.getByTestId(`extension-theme-${INSTALLATION}`));
      await user.click(await screen.findByRole("option", { name: "Argila" }));
    });

    expect(corpo).toEqual({
      expected_revision: 1,
      enabled: false,
      configuration: { density: "comfortable", show_description: true, theme: "clay" },
    });
  });

  it("escolher 'Nenhuma' tira o tema, sem deixar a chave para trás", async () => {
    const corpo = await salvarCartao(
      installation({
        configuration: { density: "comfortable", show_description: true, theme: "sage" },
        theme_palette: "sage",
      }),
      async (user) => {
        await user.click(screen.getByTestId(`extension-theme-${INSTALLATION}`));
        await user.click(
          await screen.findByRole("option", { name: "Nenhuma (padrão do produto)" }),
        );
      },
    );

    expect(corpo).toEqual({
      expected_revision: 1,
      enabled: false,
      configuration: { density: "comfortable", show_description: true },
    });
  });

  it("paleta gravada que o manifesto atual não declara não é apagada ao salvar a densidade", async () => {
    // O pacote trocou de tema (ou perdeu o tema) depois que a organização escolheu
    // `plum` pela API: o gancho não aplica mais nada e o campo mostra "Nenhuma" — que
    // é o que a tela pinta hoje —, mas o valor gravado NÃO pode sumir por causa de um
    // salvamento que só mexeu na densidade.
    const corpo = await salvarCartao(
      installation({
        configuration: { density: "comfortable", show_description: true, theme: "plum" },
        theme_palette: "clay",
      }),
      async (user) => {
        await user.click(screen.getByTestId(`extension-density-${INSTALLATION}`));
        await user.click(await screen.findByRole("option", { name: "Compacta" }));
      },
    );

    expect(screen.getByTestId(`extension-theme-${INSTALLATION}`)).toHaveTextContent(
      "Nenhuma (padrão do produto)",
    );
    expect(corpo).toEqual({
      expected_revision: 1,
      enabled: false,
      configuration: { density: "compact", show_description: true, theme: "plum" },
    });
  });

  it("extensão SEM tema no manifesto não ganha campo nem chave fantasma", async () => {
    const corpo = await salvarCartao(installation({ theme_palette: null }), async (user) => {
      await user.click(screen.getByTestId(`extension-density-${INSTALLATION}`));
      await user.click(await screen.findByRole("option", { name: "Compacta" }));
    });

    expect(screen.queryByTestId(`extension-theme-${INSTALLATION}`)).toBeNull();
    expect(corpo).toEqual({
      expected_revision: 1,
      enabled: false,
      configuration: { density: "compact", show_description: true },
    });
  });
});
