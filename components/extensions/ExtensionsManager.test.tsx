import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { CatalogEntry } from "@/lib/extensions/manifest";
import type {
  ExtensionListView,
  ExtensionOperationView,
  InstalledExtensionView,
} from "@/lib/extensions/view";

import { ExtensionsManager } from "./ExtensionsManager";
import { persistPendingReceipt, readPendingReceipts, type PendingReceipt } from "./receipt-storage";

const { router, toast } = vi.hoisted(() => ({
  router: { refresh: vi.fn() },
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast }));

const ACTOR = "00000000-0000-4000-8000-000000000010";
const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-000000000002";
const INSTALLATION = "00000000-0000-4000-8000-000000000003";
const CATALOG = "00000000-0000-4000-8000-000000000009";
const RECEIPT: PendingReceipt = {
  id: "00000000-0000-4000-8000-000000000004",
  kind: "install",
  label: "equipe-exemplo/rotina-comercial@1.0.0",
  targetKey: "install:catalog:equipe-exemplo:rotina-comercial:1.0.0",
  createdAt: "2026-09-15T00:00:00.000Z",
};

const DISPLAY = {
  title: { "pt-BR": "Rotina comercial" },
  summary: { "pt-BR": "Organiza o trabalho." },
  category: "sales",
  icon: "ListChecks",
} as const;

function installation(overrides: Partial<InstalledExtensionView> = {}): InstalledExtensionView {
  return {
    id: INSTALLATION,
    catalog_id: CATALOG,
    origin: "https://extensions.example/catalog.json",
    publisher: "equipe-exemplo",
    name: "rotina-comercial",
    version: "1.0.0",
    display: { ...DISPLAY },
    permissions: ["navigation.tasks"],
    enabled: false,
    revision: 1,
    configuration: { density: "comfortable", show_description: true },
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

function list(
  organizationId = ORG_A,
  overrides: Partial<ExtensionListView> = {},
): ExtensionListView {
  return {
    organization_id: organizationId,
    can_manage: true,
    can_install: true,
    catalogs: [],
    installations: [installation()],
    removed_installations: [],
    operations: [],
    ...overrides,
  };
}

function operation({
  id = RECEIPT.id,
  organizationId,
  kind = "install",
  status = "completed",
  extra = {},
}: {
  id?: string;
  /** Omitido: a organização que o banco exige para o tipo (só `configure` tem uma). */
  organizationId?: string | null;
  kind?: ExtensionOperationView["kind"];
  status?: ExtensionOperationView["status"];
  extra?: Partial<ExtensionOperationView>;
} = {}): ExtensionOperationView {
  return {
    id,
    organization_id: organizationId === undefined ? (kind === "configure" ? ORG_A : null) : organizationId,
    actor_id: ACTOR,
    kind,
    status,
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
    ...extra,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderManager() {
  return render(
    <IdiomaProvider locale="pt-BR">
      <ExtensionsManager organizationId={ORG_A} actorId={ACTOR} />
    </IdiomaProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  router.refresh.mockReset();
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

describe("ExtensionsManager", () => {
  it("envia a organização apresentada como precondição da leitura e configuração", async () => {
    let configurationReceipt: ExtensionOperationView | null = null;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        const id = new Headers(init?.headers).get("Idempotency-Key")!;
        configurationReceipt = operation({ id, kind: "configure" });
        return Promise.resolve(json({ data: configurationReceipt }));
      })
      .mockImplementationOnce(() => {
        // O que o servidor devolve DEPOIS de gravar: revisão nova e o valor salvo.
        // Com a revisão parada em 1 o card nunca remontava e o gate ficava cego
        // para a mensagem que sumia na remontagem.
        const salva = list(ORG_A, { operations: [configurationReceipt!] });
        salva.installations[0]!.enabled = true;
        salva.installations[0]!.revision = 2;
        return Promise.resolve(json({ data: salva }));
      });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("switch", { name: "Ativa no CRM" }));
    await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const listHeaders = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    const configHeaders = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers);
    expect(listHeaders.get("X-Expected-Organization-Id")).toBe(ORG_A);
    expect(configHeaders.get("X-Expected-Organization-Id")).toBe(ORG_A);
    expect(await screen.findByText("Configuração salva.")).toBeVisible();
    expect(toast.success).not.toHaveBeenCalledWith("Configuração salva.");
  });

  it.each([
    [
      "sem organization_id",
      (id: string) => {
        const { organization_id: _, ...missing } = operation({ id, kind: "configure" });
        return missing;
      },
    ],
    [
      "com organização diferente",
      (id: string) => operation({ id, kind: "configure", organizationId: ORG_B }),
    ],
  ])("preserva o recibo e não anuncia configuração %s", async (_case, response) => {
    let receiptId = "";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        receiptId = new Headers(init?.headers).get("Idempotency-Key")!;
        return Promise.resolve(json({ data: response(receiptId) }));
      })
      .mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("switch", { name: "Ativa no CRM" }));
    await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.queryByText("Configuração salva.")).toBeNull();
    expect(readPendingReceipts(window.localStorage, ACTOR, ORG_A)).toEqual([
      expect.objectContaining({ id: receiptId, kind: "configure" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalida o snapshot quando outra organização aparece e remove as ações", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockResolvedValueOnce(json({ data: list(ORG_B) }));
    vi.stubGlobal("fetch", fetchMock);
    renderManager();
    await screen.findByTestId(`extension-installed-${INSTALLATION}`);

    fireEvent(window, new Event("focus"));

    expect(await screen.findByTestId("extensions-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId(`extension-installed-${INSTALLATION}`)).toBeNull();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("não apresenta falha inicial como lista vazia", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ error: { code: "upstream_unavailable", message: "Serviço indisponível." } }, 503),
        ),
    );
    renderManager();

    expect(await screen.findByTestId("extensions-unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma extensão instalada")).toBeNull();
    expect(screen.queryByText("Nenhum catálogo revisado disponível")).toBeNull();
  });

  it("marca snapshot anterior como desatualizado e bloqueia mutações", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockResolvedValueOnce(
        json({ error: { code: "upstream_unavailable", message: "Serviço indisponível." } }, 503),
      );
    vi.stubGlobal("fetch", fetchMock);
    renderManager();
    await screen.findByTestId(`extension-save-${INSTALLATION}`);

    fireEvent(window, new Event("focus"));

    expect(await screen.findByTestId("extensions-stale")).toBeInTheDocument();
    expect(screen.getByTestId(`extension-save-${INSTALLATION}`)).toBeDisabled();
    expect(screen.getByTestId(`extension-installed-${INSTALLATION}`)).toBeInTheDocument();
  });

  it("recusa catálogo acima de 512 KiB antes de ler o arquivo", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: list() })));
    renderManager();
    const input = await screen.findByTestId("extension-catalog-file");
    const file = new File([new Uint8Array(512 * 1024 + 1)], "grande.json", {
      type: "application/json",
    });
    const arrayBuffer = vi.fn();
    Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });

    await userEvent.upload(input, file);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O arquivo pode ter até 512 KiB. Escolha um arquivo menor.",
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("explica falha de leitura do catálogo sem iniciar a admissão", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    renderManager();
    const input = await screen.findByTestId("extension-catalog-file");
    const file = new File(["{}"], "catalogo.json", { type: "application/json" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockRejectedValue(new DOMException("unreadable", "NotReadableError")),
    });

    await userEvent.upload(input, file);
    await userEvent.click(screen.getByTestId("extension-catalog-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível ler este arquivo. Escolha o catálogo novamente e tente outra vez.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("não inicia mutação quando o recibo não pode ser persistido", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    renderManager();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Ativa no CRM" }));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));

    expect(await screen.findByText("Os pedidos estão bloqueados neste navegador")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("conserva recibo diante de 404 HTML", async () => {
    persistPendingReceipt(window.localStorage, ACTOR, ORG_A, RECEIPT);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockResolvedValueOnce(new Response("<html>proxy</html>", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    await userEvent.click(await screen.findByText("Verificar recibo"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const operationHeaders = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers);
    expect(operationHeaders.get("X-Expected-Organization-Id")).toBe(ORG_A);
    expect(readPendingReceipts(window.localStorage, ACTOR, ORG_A)).toEqual([RECEIPT]);
  });

  it.each([
    [
      "sem organization_id",
      () => {
        const { organization_id: _, ...missing } = operation();
        return missing;
      },
    ],
    ["com organização diferente", () => operation({ organizationId: ORG_B })],
    ["com UUID diferente", () => operation({ id: "00000000-0000-4000-8000-000000000099" })],
  ])("conserva recibo quando o GET retorna DTO %s", async (_case, response) => {
    persistPendingReceipt(window.localStorage, ACTOR, ORG_A, RECEIPT);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockResolvedValueOnce(json({ data: response() }));
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    await userEvent.click(await screen.findByText("Verificar recibo"));

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(readPendingReceipts(window.localStorage, ACTOR, ORG_A)).toEqual([RECEIPT]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("quando outra aba resolve o recibo, esta aba tira o aviso e recarrega o estado sem reenviar", async () => {
    // Só a lista recarregada traz este título: é o sinal de que a aba consultou o servidor.
    const reconciliada = list();
    reconciliada.installations[0]!.display = {
      ...reconciliada.installations[0]!.display,
      title: { "pt-BR": "Rotina comercial, estado reconciliado" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(json({ data: reconciliada }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("switch", { name: "Ativa no CRM" }));
    await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));

    const [pendente] = await waitFor(() => {
      const recibos = readPendingReceipts(window.localStorage, ACTOR, ORG_A);
      expect(recibos).toHaveLength(1);
      return recibos;
    });
    const linha = await screen.findByTestId(`extension-local-receipt-${pendente!.id}`);
    expect(linha).toHaveTextContent(/A conexão caiu sem confirmação/);

    // Outra aba reconciliou o pedido e apagou o recibo deste navegador.
    let chave = "";
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k?.endsWith(pendente!.id)) chave = k;
    }
    window.localStorage.removeItem(chave);
    fireEvent(window, new StorageEvent("storage", { key: chave }));

    await waitFor(() => expect(screen.queryByText(/A conexão caiu sem confirmação/)).toBeNull());
    // A outra aba mudou o estado do servidor: esta aba recarrega a lista em vez de
    // seguir mostrando (e permitindo mutar sobre) a de antes.
    expect(await screen.findByText("Rotina comercial, estado reconciliado")).toBeVisible();
    // E nada foi reenviado: o único pedido de escrita é o que caiu.
    const escritas = fetchMock.mock.calls.filter(
      ([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") !== "GET",
    );
    expect(escritas).toHaveLength(1);
  });

  it("409 que não é conflito de revisão mostra o motivo do servidor, não 'outra pessoa alterou'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "extension_active_limit",
              message: "O limite de extensões ativas foi atingido. Desative uma antes de ativar outra.",
            },
          },
          409,
        ),
      )
      .mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("switch", { name: "Ativa no CRM" }));
    await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));

    expect(await screen.findByText(/O limite de extensões ativas foi atingido/)).toBeVisible();
    expect(screen.queryByText(/Outra pessoa alterou esta extensão/)).toBeNull();
  });

  it("extensão que ficou incompatível e segue ativa pode ser desativada, com a configuração preservada", async () => {
    const quebrada = list();
    Object.assign(quebrada.installations[0]!, {
      enabled: true,
      revision: 4,
      configuration: { density: "compact", show_description: false },
      compatible: false,
      compatibility_reason: "O pacote gravado não pôde ser conferido por esta versão do CRM.",
    });
    let corpo: unknown = null;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: quebrada }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        corpo = JSON.parse(String(init?.body));
        const id = new Headers(init?.headers).get("Idempotency-Key")!;
        return Promise.resolve(json({ data: operation({ id, kind: "configure" }) }));
      })
      .mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByTestId(`extension-disable-incompatible-${INSTALLATION}`));

    await waitFor(() =>
      expect(corpo).toEqual({
        expected_revision: 4,
        enabled: false,
        configuration: { density: "compact", show_description: false },
      }),
    );
  });

  it("Verificar instalação retoma o MESMO recibo: nada de segundo pedido com chave nova", async () => {
    const preparando = {
      ...operation({ kind: "install", status: "preparing" }),
      // A retomada só reenvia com a identidade completa do pedido preparado.
      catalog_id: "00000000-0000-4000-8000-000000000009",
      installation_id: null,
    };
    const emPreparo = list(ORG_A, { operations: [preparando] });
    const chaves: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: emPreparo }))
      .mockResolvedValueOnce(json({ data: preparando }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        chaves.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        return Promise.resolve(json({ data: operation({ kind: "install", status: "completed" }) }));
      })
      .mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByTestId(`extension-operation-verify-${preparando.id}`));

    await waitFor(() => expect(chaves).toHaveLength(1));
    // A retomada usa a identidade do recibo, e não uma chave nova — é o que impede a
    // preparação interrompida de virar uma segunda instalação.
    expect(chaves[0]).toBe(preparando.id);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(String(url)).toContain("/api/v1/extensions/install");
    expect((init.method ?? "GET").toUpperCase()).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ expected_installation_revision: null });
  });

  it("Verificar atualização reenvia o mesmo pedido com a revisão que a preparação encontrou", async () => {
    const preparando = operation({
      kind: "update",
      status: "preparing",
      extra: { catalog_id: CATALOG, version: "1.1.0", from_revision: 3, from_version: "1.0.0" },
    });
    let corpo: unknown = null;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list(ORG_A, { operations: [preparando] }) }))
      .mockResolvedValueOnce(json({ data: preparando }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        corpo = JSON.parse(String(init?.body));
        return Promise.resolve(json({ data: { ...preparando, status: "completed" } }));
      })
      .mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    const verificar = await screen.findByTestId(`extension-operation-verify-${preparando.id}`);
    expect(verificar).toHaveTextContent("Verificar atualização");
    expect(screen.getByTestId(`extension-operation-cancel-${preparando.id}`)).toHaveTextContent(
      "Cancelar atualização",
    );
    await user.click(verificar);

    await waitFor(() =>
      expect(corpo).toEqual({
        catalog_id: CATALOG,
        publisher: "equipe-exemplo",
        name: "rotina-comercial",
        version: "1.1.0",
        expected_installation_revision: 3,
      }),
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("a gestão continua de pé com recibos de atualização, troca, desfazer e remoção na lista", async () => {
    const recibos = [
      operation({
        id: "00000000-0000-4000-8000-000000000021",
        kind: "update",
        extra: { from_version: "1.0.0", to_version: "1.1.0", from_revision: 1, organizations_affected: 2 },
      }),
      operation({
        id: "00000000-0000-4000-8000-000000000022",
        kind: "update",
        extra: { from_version: "1.1.0", to_version: "1.0.0", from_revision: 2, organizations_affected: 1 },
      }),
      operation({
        id: "00000000-0000-4000-8000-000000000023",
        kind: "revert",
        extra: { from_version: "1.0.0", to_version: "1.1.0", from_revision: 3, organizations_affected: 1 },
      }),
      operation({
        id: "00000000-0000-4000-8000-000000000024",
        kind: "removal",
        extra: { from_revision: 4, organizations_affected: 1 },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: list(ORG_A, { operations: recibos }) })));
    renderManager();

    expect(await screen.findByText("Atualização")).toBeVisible();
    expect(screen.getByText("Troca de versão")).toBeVisible();
    expect(screen.getByText("Troca desfeita")).toBeVisible();
    expect(screen.getByText("Remoção")).toBeVisible();
    expect(
      screen.getByText("equipe-exemplo/rotina-comercial 1.0.0 → 1.1.0 · 2 organizações com ela ativa"),
    ).toBeVisible();
    expect(screen.getByText("equipe-exemplo/rotina-comercial@1.0.0 · 1 organização desativada")).toBeVisible();
    expect(
      screen.getByText("equipe-exemplo/rotina-comercial 1.0.0 → 1.1.0 · 1 organização com ela ativa"),
    ).toBeVisible();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it.each(["update", "revert", "removal"] as const)(
    "recibo local de %s confirmado pelo servidor sai do navegador",
    async (kind) => {
      persistPendingReceipt(window.localStorage, ACTOR, ORG_A, {
        ...RECEIPT,
        kind,
        targetKey: `${kind}:${INSTALLATION}:1`,
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(json({ data: list() }))
        .mockResolvedValueOnce(json({ data: operation({ kind }) }))
        .mockResolvedValue(json({ data: list() }));
      vi.stubGlobal("fetch", fetchMock);
      renderManager();

      await userEvent.click(await screen.findByText("Verificar recibo"));

      await waitFor(() => expect(readPendingReceipts(window.localStorage, ACTOR, ORG_A)).toEqual([]));
      expect(router.refresh).not.toHaveBeenCalled();
    },
  );

  it("o bloco de todas as organizações aparece também na versão incompatível, e desfazer para versão incompatível fica bloqueado com o motivo", async () => {
    const dados = list(ORG_A, {
      installations: [
        installation({
          version: "1.1.0",
          compatible: false,
          compatibility_reason: "O pacote gravado não pôde ser conferido por esta versão do CRM.",
          installation_revision: 2,
          active_organizations: 3,
          previous: {
            version: "1.0.0",
            compatible: false,
            compatibility_reason: "Esta extensão não é compatível com a API disponível nesta instalação.",
            in_catalog: true,
          },
        }),
      ],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: dados })));
    renderManager();

    expect(await screen.findByTestId(`extension-platform-${INSTALLATION}`)).toHaveTextContent(
      "3 organizações estão com esta extensão ativa.",
    );
    expect(screen.getByTestId(`extension-revert-${INSTALLATION}`)).toBeDisabled();
    expect(screen.getByText("A versão 1.0.0 não é compatível com esta versão do CRM.")).toBeVisible();
    expect(screen.getByTestId(`extension-remove-${INSTALLATION}`)).toBeEnabled();
  });

  it("quem não administra a instalação não vê o bloco de todas as organizações", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          data: list(ORG_A, {
            can_install: false,
            installations: [installation({ active_organizations: null })],
          }),
        }),
      ),
    );
    renderManager();

    await screen.findByTestId(`extension-installed-${INSTALLATION}`);
    expect(screen.queryByTestId(`extension-platform-${INSTALLATION}`)).toBeNull();
    expect(screen.queryByText("Nesta organização")).toBeNull();
  });

  it("desfazer só acontece dentro do diálogo, que diz para qual versão volta e quantas organizações estão ativas", async () => {
    const dados = list(ORG_A, {
      installations: [
        installation({
          version: "1.1.0",
          installation_revision: 2,
          active_organizations: 1,
          previous: { version: "1.0.0", compatible: true, compatibility_reason: null, in_catalog: false },
        }),
      ],
    });
    let corpo: unknown = null;
    let destino = "";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: dados }))
      .mockImplementationOnce((input: RequestInfo | URL, init?: RequestInit) => {
        destino = String(input);
        corpo = JSON.parse(String(init?.body));
        const id = new Headers(init?.headers).get("Idempotency-Key")!;
        return Promise.resolve(
          json({
            data: operation({
              id,
              kind: "revert",
              extra: { from_version: "1.1.0", to_version: "1.0.0", from_revision: 2, organizations_affected: 1 },
            }),
          }),
        );
      })
      .mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByTestId(`extension-revert-${INSTALLATION}`));
    const dialogo = await screen.findByTestId(`extension-revert-dialog-${INSTALLATION}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dialogo).toHaveTextContent("Voltar Rotina comercial para a versão 1.0.0?");
    expect(dialogo).toHaveTextContent("1 organização está com esta extensão ativa.");
    expect(dialogo).toHaveTextContent("A versão 1.0.0 não está mais no catálogo admitido.");
    await user.click(screen.getByTestId(`extension-revert-confirm-${INSTALLATION}`));

    await waitFor(() => expect(corpo).toEqual({ expected_installation_revision: 2 }));
    expect(destino).toContain(`/api/v1/extensions/${INSTALLATION}/revert`);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Troca desfeita: a versão 1.0.0 voltou a valer em todas as organizações.",
      ),
    );
  });

  it("remover numa aba desatualizada avisa que a extensão mudou e recarrega, sem anunciar remoção", async () => {
    const dados = list(ORG_A, { installations: [installation({ active_organizations: 2 })] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: dados }))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "extension_version_changed",
              message: "A extensão mudou em outra sessão. Recarregue antes de continuar.",
            },
          },
          409,
        ),
      )
      .mockResolvedValue(json({ data: dados }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByTestId(`extension-remove-${INSTALLATION}`));
    expect(await screen.findByTestId(`extension-remove-dialog-${INSTALLATION}`)).toHaveTextContent(
      "2 organizações com ela ativa deixam de ver os guias agora; a configuração de cada uma fica guardada.",
    );
    await user.click(screen.getByTestId(`extension-remove-confirm-${INSTALLATION}`));

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "A extensão mudou em outra sessão. Recarregamos o estado atual; revise antes de repetir.",
      ),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(toast.success).not.toHaveBeenCalled();
    expect(readPendingReceipts(window.localStorage, ACTOR, ORG_A)).toEqual([]);
  });

  it("remover o que outra sessão já removeu recarrega a tela em vez de manter as ações", async () => {
    const removidaAgora = list(ORG_A, { installations: [] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "extension_removed",
              message: "O responsável pela instalação removeu esta extensão de todas as organizações.",
            },
          },
          410,
        ),
      )
      .mockResolvedValue(json({ data: removidaAgora }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByTestId(`extension-remove-${INSTALLATION}`));
    await user.click(await screen.findByTestId(`extension-remove-confirm-${INSTALLATION}`));

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "O responsável pela instalação removeu esta extensão de todas as organizações.",
      ),
    );
    await waitFor(() => expect(screen.queryByTestId(`extension-remove-${INSTALLATION}`)).toBeNull());
    // Recarregou: a gestão continua de pé com a lista nova, e não virou "estado indisponível".
    expect(await screen.findByText("Nenhuma extensão instalada")).toBeVisible();
    expect(screen.queryByTestId("extensions-unavailable")).toBeNull();
    expect(screen.queryByTestId("extensions-stale")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a mensagem de um salvamento não reaparece depois que a mesma instalação é removida e reinstalada", async () => {
    const ativa = list(ORG_A, { installations: [installation({ enabled: true, revision: 2, installation_revision: 1 })] });
    const reinstalada = list(ORG_A, {
      installations: [
        installation({
          enabled: false,
          revision: 3,
          installation_revision: 3,
          deactivated_by_removal_at: "2026-09-16T12:00:00.000Z",
        }),
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        const id = new Headers(init?.headers).get("Idempotency-Key")!;
        return Promise.resolve(json({ data: operation({ id, kind: "configure" }) }));
      })
      .mockResolvedValueOnce(json({ data: ativa }))
      .mockResolvedValue(json({ data: reinstalada }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("switch", { name: "Ativa no CRM" }));
    await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));
    expect(await screen.findByText("Configuração salva.")).toBeVisible();

    // Outra sessão removeu e reinstalou: mesmo id, revisão da instalação nova.
    fireEvent(window, new Event("focus"));
    expect(await screen.findByTestId(`extension-reactivate-${INSTALLATION}`)).toBeVisible();
    expect(screen.queryByText("Configuração salva.")).toBeNull();
  });

  it.each([
    [
      "salva",
      (id: string) => json({ data: operation({ id, kind: "configure" }) }),
      "Configuração salva.",
    ],
    [
      "recusada por revisão divergente",
      () =>
        json(
          {
            error: {
              code: "extension_revision_conflict",
              message: "A configuração mudou em outra sessão. Recarregue antes de salvar.",
            },
          },
          409,
        ),
      "Outra pessoa alterou esta extensão. Recarregamos o valor atual; revise antes de salvar novamente.",
    ],
  ])(
    "a mensagem da configuração %s sobrevive quando a recarga do próprio salvamento traz outra revisão da instalação",
    async (_caso, resposta, mensagem) => {
      // Entre o clique e a resposta, outra sessão desfez a última troca: a instalação volta com
      // outra `installation_revision`, e é sobre ESSE card que a pessoa espera ler o desfecho.
      const depois = list(ORG_A, {
        installations: [installation({ revision: 2, installation_revision: 2 })],
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(json({ data: list() }))
        .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
          Promise.resolve(resposta(new Headers(init?.headers).get("Idempotency-Key")!)),
        )
        .mockResolvedValue(json({ data: depois }));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      renderManager();

      await user.click(await screen.findByRole("switch", { name: "Ativa no CRM" }));
      await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));

      expect(await screen.findByText(mensagem)).toBeVisible();
    },
  );

  it("a mensagem não volta quando a instalação some da lista entre a remoção e a reinstalação", async () => {
    // A organização que tinha a extensão DESLIGADA não vê a removida: a remoção só marca vínculo
    // ativo. Entre a remoção e a reinstalação o card some da lista, e é aí que uma regra que só
    // compara revisões de quem está na lista perde o rastro e deixa a frase antiga voltar.
    const salva = list(ORG_A, {
      installations: [installation({ enabled: false, revision: 2, installation_revision: 4 })],
    });
    const semNada = list(ORG_A, { installations: [] });
    const reinstalada = list(ORG_A, {
      installations: [installation({ enabled: false, revision: 3, installation_revision: 6 })],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: salva }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        const id = new Headers(init?.headers).get("Idempotency-Key")!;
        return Promise.resolve(json({ data: operation({ id, kind: "configure" }) }));
      })
      .mockResolvedValueOnce(json({ data: salva }))
      .mockResolvedValueOnce(json({ data: semNada }))
      .mockResolvedValue(json({ data: reinstalada }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    // Mexe na descrição, e não na chave "Ativa no CRM": esta organização tem a extensão
    // DESLIGADA, que é a pré-condição do defeito — a remoção só marca vínculo ativo.
    await user.click(await screen.findByTestId(`extension-description-${INSTALLATION}`));
    await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));
    expect(await screen.findByText("Configuração salva.")).toBeVisible();

    // Removida por quem administra a instalação: esta organização nem vê o card.
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(screen.queryByTestId(`extension-installed-${INSTALLATION}`)).toBeNull());

    // Reinstalada: mesmo id, revisão nova, card novo — sem a frase da vida anterior.
    fireEvent(window, new Event("focus"));
    expect(await screen.findByTestId(`extension-installed-${INSTALLATION}`)).toBeVisible();
    expect(screen.queryByText("Configuração salva.")).toBeNull();
  });

  it("a mensagem de um salvamento não atravessa a troca de organização", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        const id = new Headers(init?.headers).get("Idempotency-Key")!;
        return Promise.resolve(json({ data: operation({ id, kind: "configure" }) }));
      })
      .mockResolvedValueOnce(json({ data: list() }))
      // A sessão passou a valer para outra organização: o snapshot morre com ela.
      .mockResolvedValueOnce(json({ data: list(ORG_B) }))
      .mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("switch", { name: "Ativa no CRM" }));
    await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));
    expect(await screen.findByText("Configuração salva.")).toBeVisible();

    fireEvent(window, new Event("focus"));
    expect(await screen.findByTestId("extensions-unavailable")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByTestId(`extension-installed-${INSTALLATION}`)).toBeVisible();
    expect(screen.queryByText("Configuração salva.")).toBeNull();
  });

  it("desfazer ou configurar o que outra sessão removeu avisa fora do card e recarrega", async () => {
    const removida = {
      error: {
        code: "extension_removed",
        message: "O responsável pela instalação removeu esta extensão de todas as organizações.",
      },
    };
    const comAnterior = list(ORG_A, {
      installations: [
        installation({
          installation_revision: 2,
          previous: { version: "0.9.0", compatible: true, compatibility_reason: null, in_catalog: true },
        }),
      ],
    });
    const vazia = list(ORG_A, { installations: [] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: comAnterior }))
      .mockResolvedValueOnce(json(removida, 410))
      .mockResolvedValueOnce(json({ data: comAnterior }))
      .mockResolvedValueOnce(json(removida, 410))
      .mockResolvedValue(json({ data: vazia }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByTestId(`extension-revert-${INSTALLATION}`));
    await user.click(await screen.findByTestId(`extension-revert-confirm-${INSTALLATION}`));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);

    await user.click(await screen.findByRole("switch", { name: "Ativa no CRM" }));
    await user.click(screen.getByTestId(`extension-save-${INSTALLATION}`));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(2));
    expect(toast.warning).toHaveBeenLastCalledWith(
      "O responsável pela instalação removeu esta extensão de todas as organizações.",
    );
    expect(await screen.findByText("Nenhuma extensão instalada")).toBeVisible();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("preparação iniciada em outra sessão: o 409 recarrega e acende o bloqueio com o motivo", async () => {
    const preparando = operation({
      kind: "update",
      status: "preparing",
      extra: { catalog_id: CATALOG, version: "1.1.0", from_revision: 1, from_version: "1.0.0" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "extension_preparation_in_progress",
              message:
                "Já existe uma preparação em andamento. Em Atividade recente, quem pediu pode retomá-la, e qualquer responsável pela instalação pode cancelá-la.",
            },
          },
          409,
        ),
      )
      .mockResolvedValue(json({ data: list(ORG_A, { operations: [preparando] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByTestId(`extension-remove-${INSTALLATION}`));
    await user.click(await screen.findByTestId(`extension-remove-confirm-${INSTALLATION}`));

    expect(await screen.findByTestId(`extension-platform-preparing-${INSTALLATION}`)).toBeVisible();
    expect(screen.getByTestId(`extension-remove-${INSTALLATION}`)).toBeDisabled();
    expect(toast.warning).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("instalação cancelada por outro responsável durante o download não vira aviso de sucesso", async () => {
    const entrada: CatalogEntry = {
      publisher: "equipe-exemplo",
      name: "guia-novo",
      version: "1.0.0",
      license: "MIT",
      host_api: { min: 1, max: 1 },
      display: { ...DISPLAY },
      permissions: ["navigation.tasks"],
      sha256: "b".repeat(64),
      byte_length: 100,
    };
    const dados = list(ORG_A, {
      catalogs: [
        {
          id: CATALOG,
          origin: "https://extensions.example/catalog.json",
          revision: 1,
          admitted_at: "2026-09-15T00:00:00.000Z",
          entries: [entrada],
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: dados }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        const id = new Headers(init?.headers).get("Idempotency-Key")!;
        return Promise.resolve(
          json({ data: operation({ id, kind: "install", status: "cancelled", extra: { name: "guia-novo" } }) }),
        );
      })
      .mockResolvedValue(json({ data: dados }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("tab", { name: "Catálogo" }));
    await user.click(await screen.findByTestId("extension-install-equipe-exemplo-guia-novo-1.0.0"));

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "O pedido foi cancelado antes de concluir. Nada foi instalado.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("instalação cancelada por catálogo readmitido mostra o motivo e o próximo passo", async () => {
    const entrada: CatalogEntry = {
      publisher: "equipe-exemplo",
      name: "guia-novo",
      version: "1.0.0",
      license: "MIT",
      host_api: { min: 1, max: 1 },
      display: { ...DISPLAY },
      permissions: ["navigation.tasks"],
      sha256: "b".repeat(64),
      byte_length: 100,
    };
    const dados = list(ORG_A, {
      catalogs: [
        {
          id: CATALOG,
          origin: "https://extensions.example/catalog.json",
          revision: 1,
          admitted_at: "2026-09-15T00:00:00.000Z",
          entries: [entrada],
        },
      ],
    });
    const motivo = "O catálogo mudou durante a preparação. Recarregue a lista antes de instalar.";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: dados }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        const id = new Headers(init?.headers).get("Idempotency-Key")!;
        return Promise.resolve(
          json({
            data: operation({
              id,
              kind: "install",
              status: "cancelled",
              extra: { name: "guia-novo", error_code: "extension_catalog_stale", error_message: motivo },
            }),
          }),
        );
      })
      .mockResolvedValue(json({ data: dados }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("tab", { name: "Catálogo" }));
    await user.click(await screen.findByTestId("extension-install-equipe-exemplo-guia-novo-1.0.0"));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(motivo));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("o catálogo bloqueia a atualização, com o motivo, enquanto há preparação da mesma identidade", async () => {
    const entrada: CatalogEntry = {
      publisher: "equipe-exemplo",
      name: "rotina-comercial",
      version: "1.1.0",
      license: "MIT",
      host_api: { min: 1, max: 1 },
      display: { ...DISPLAY },
      permissions: ["navigation.tasks"],
      sha256: "a".repeat(64),
      byte_length: 100,
    };
    const preparando = operation({
      kind: "update",
      status: "preparing",
      extra: { catalog_id: CATALOG, version: "1.1.0", from_revision: 1, from_version: "1.0.0", actor_id: "00000000-0000-4000-8000-000000000099" },
    });
    const dados = list(ORG_A, {
      catalogs: [
        {
          id: CATALOG,
          origin: "https://extensions.example/catalog.json",
          revision: 1,
          admitted_at: "2026-09-15T00:00:00.000Z",
          entries: [entrada],
        },
      ],
      operations: [preparando],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: dados })));
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("tab", { name: "Catálogo" }));
    const identidade = "equipe-exemplo-rotina-comercial-1.1.0";
    expect(await screen.findByTestId(`extension-install-${identidade}`)).toBeDisabled();
    expect(screen.getByTestId(`extension-catalog-preparing-${identidade}`)).toHaveTextContent(
      "Há uma preparação desta extensão em andamento.",
    );
  });

  it("com uma preparação da mesma extensão em curso, desfazer e remover ficam bloqueados com o motivo", async () => {
    const preparando = operation({
      kind: "update",
      status: "preparing",
      extra: { catalog_id: CATALOG, version: "1.1.0", from_revision: 2, from_version: "1.0.0" },
    });
    const dados = list(ORG_A, {
      installations: [
        installation({
          installation_revision: 2,
          previous: { version: "0.9.0", compatible: true, compatibility_reason: null, in_catalog: true },
        }),
      ],
      operations: [preparando],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: dados })));
    renderManager();

    expect(await screen.findByTestId(`extension-platform-preparing-${INSTALLATION}`)).toHaveTextContent(
      "Há uma preparação desta extensão em andamento.",
    );
    expect(screen.getByTestId(`extension-revert-${INSTALLATION}`)).toBeDisabled();
    expect(screen.getByTestId(`extension-remove-${INSTALLATION}`)).toBeDisabled();
  });

  it.each([
    [
      "desfazer",
      `extension-revert-${INSTALLATION}`,
      `extension-revert-confirm-${INSTALLATION}`,
      `extension-revert-blocked-${INSTALLATION}`,
    ],
    [
      "remover",
      `extension-remove-${INSTALLATION}`,
      `extension-remove-confirm-${INSTALLATION}`,
      `extension-remove-blocked-${INSTALLATION}`,
    ],
  ])(
    "o diálogo de %s aberto antes da preparação aparecer não confirma o que o banco recusa, e diz por quê",
    async (_caso, abrir, confirmar, motivo) => {
      const comAnterior = list(ORG_A, {
        installations: [
          installation({
            catalog_id: CATALOG,
            previous: { version: "0.9.0", compatible: true, compatibility_reason: null, in_catalog: true },
          }),
        ],
      });
      const preparando = operation({
        kind: "update",
        status: "preparing",
        extra: { catalog_id: CATALOG, version: "1.1.0", from_revision: 1, from_version: "1.0.0" },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(json({ data: comAnterior }))
        .mockResolvedValue(json({ data: { ...comAnterior, operations: [preparando] } }));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      renderManager();

      await user.click(await screen.findByTestId(abrir));
      expect(await screen.findByTestId(confirmar)).toBeEnabled();

      // Outra sessão pediu a atualização enquanto este diálogo estava aberto.
      fireEvent(window, new Event("focus"));

      // Espera a recarga TERMINAR antes de medir: enquanto ela corre, a tela não está "fresca" e
      // o botão ficaria desabilitado por OUTRO motivo — a primeira versão deste teste passava
      // assim, e ficava verde mesmo sem a guarda da preparação. O marcador só existe com a lista
      // nova no estado, e a ausência do aviso de atualizar prova que as mutações estão liberadas.
      expect(await screen.findByTestId(`extension-platform-preparing-${INSTALLATION}`)).toBeVisible();
      expect(
        screen.queryByText("Atualize o estado das extensões antes de enviar um novo pedido."),
      ).toBeNull();
      expect(screen.getByTestId(confirmar)).toBeDisabled();
      expect(screen.getByTestId(motivo)).toHaveTextContent(
        "Há uma preparação desta extensão em andamento.",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("o diálogo do catálogo aberto antes da preparação aparecer não confirma o que o banco recusa", async () => {
    const entrada: CatalogEntry = {
      publisher: "equipe-exemplo",
      name: "rotina-comercial",
      version: "1.1.0",
      license: "MIT",
      host_api: { min: 1, max: 1 },
      display: { ...DISPLAY },
      permissions: ["navigation.tasks"],
      sha256: "a".repeat(64),
      byte_length: 100,
    };
    const dados = list(ORG_A, {
      catalogs: [
        {
          id: CATALOG,
          origin: "https://extensions.example/catalog.json",
          revision: 1,
          admitted_at: "2026-09-15T00:00:00.000Z",
          entries: [entrada],
        },
      ],
    });
    const preparando = operation({
      kind: "update",
      status: "preparing",
      extra: {
        catalog_id: CATALOG,
        version: "1.1.0",
        from_revision: 1,
        from_version: "1.0.0",
        actor_id: "00000000-0000-4000-8000-000000000099",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: dados }))
      .mockResolvedValue(json({ data: { ...dados, operations: [preparando] } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("tab", { name: "Catálogo" }));
    await user.click(await screen.findByTestId("extension-install-equipe-exemplo-rotina-comercial-1.1.0"));
    const confirmar = "extension-install-confirm-equipe-exemplo-rotina-comercial-1.1.0";
    expect(await screen.findByTestId(confirmar)).toBeEnabled();

    fireEvent(window, new Event("focus"));

    const identidade = "equipe-exemplo-rotina-comercial-1.1.0";
    expect(await screen.findByTestId(`extension-catalog-preparing-${identidade}`)).toBeVisible();
    expect(
      screen.queryByText("Atualize o estado das extensões antes de enviar um novo pedido."),
    ).toBeNull();
    expect(screen.getByTestId(confirmar)).toBeDisabled();
    expect(screen.getByTestId(`extension-install-blocked-${identidade}`)).toHaveTextContent(
      "Há uma preparação desta extensão em andamento.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("um segundo pedido nesta aba não desbloqueia o catálogo, desfazer e remover do primeiro", async () => {
    const entrada = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
      publisher: "equipe-exemplo",
      name: "rotina-comercial",
      version: "1.1.0",
      license: "MIT",
      host_api: { min: 1, max: 1 },
      display: { ...DISPLAY },
      permissions: ["navigation.tasks"],
      sha256: "a".repeat(64),
      byte_length: 100,
      ...over,
    });
    const dados = list(ORG_A, {
      installations: [
        installation({
          previous: { version: "0.9.0", compatible: true, compatibility_reason: null, in_catalog: true },
        }),
      ],
      catalogs: [
        {
          id: CATALOG,
          origin: "https://extensions.example/catalog.json",
          revision: 1,
          admitted_at: "2026-09-15T00:00:00.000Z",
          entries: [
            entrada(),
            entrada({ version: "1.2.0" }),
            entrada({ publisher: "outra-equipe", name: "outra-extensao", version: "1.0.0" }),
          ],
        },
      ],
    });
    // Nenhum dos dois downloads responde: os dois pedidos ficam em voo ao mesmo tempo. O
    // despacho é por rota, e não por ordem de chamada: a leitura periódica da lista entra no
    // meio e consumiria a resposta reservada ao pedido.
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/api/v1/extensions/install")
        ? new Promise<Response>(() => {})
        : Promise.resolve(json({ data: dados })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("tab", { name: "Catálogo" }));
    await user.click(await screen.findByTestId("extension-install-equipe-exemplo-rotina-comercial-1.1.0"));
    await user.click(
      screen.getByTestId("extension-install-confirm-equipe-exemplo-rotina-comercial-1.1.0"),
    );
    await user.click(screen.getByTestId("extension-install-outra-equipe-outra-extensao-1.0.0"));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([entrada]) =>
          String(entrada).includes("/api/v1/extensions/install"),
        ),
      ).toHaveLength(2),
    );
    expect(screen.getByTestId("extension-install-equipe-exemplo-rotina-comercial-1.2.0")).toBeDisabled();
    expect(
      screen.getByTestId("extension-catalog-preparing-equipe-exemplo-rotina-comercial-1.2.0"),
    ).toHaveTextContent("Há uma preparação desta extensão em andamento.");

    await user.click(screen.getByRole("tab", { name: "Instaladas" }));
    expect(await screen.findByTestId(`extension-revert-${INSTALLATION}`)).toBeDisabled();
    expect(screen.getByTestId(`extension-remove-${INSTALLATION}`)).toBeDisabled();
    expect(screen.getByTestId(`extension-platform-preparing-${INSTALLATION}`)).toBeVisible();
  });

  it("cancelar outro pedido não apaga o indicador do pedido desta aba que segue em voo", async () => {
    const entrada: CatalogEntry = {
      publisher: "equipe-exemplo",
      name: "rotina-comercial",
      version: "1.1.0",
      license: "MIT",
      host_api: { min: 1, max: 1 },
      display: { ...DISPLAY },
      permissions: ["navigation.tasks"],
      sha256: "a".repeat(64),
      byte_length: 100,
    };
    const deOutraExtensao = operation({
      kind: "install",
      status: "preparing",
      extra: {
        catalog_id: CATALOG,
        publisher: "outra-equipe",
        name: "outra-extensao",
        installation_id: null,
      },
    });
    const dados = list(ORG_A, {
      catalogs: [
        {
          id: CATALOG,
          origin: "https://extensions.example/catalog.json",
          revision: 1,
          admitted_at: "2026-09-15T00:00:00.000Z",
          entries: [entrada],
        },
      ],
      operations: [deOutraExtensao],
    });
    // A atualização fica em voo (o download leva até 15 s e não responde nesta prova), e o
    // cancelamento do outro pedido conclui. Despacho por rota: a lista é relida a cada 3 s
    // enquanto há preparação, e por ordem de chamada essa leitura roubaria uma das respostas.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const rota = String(input);
      if (rota.includes("/api/v1/extensions/install")) return new Promise<Response>(() => {});
      if (rota.endsWith("/cancel")) {
        return Promise.resolve(json({ data: { ...deOutraExtensao, status: "cancelled" } }));
      }
      return Promise.resolve(json({ data: dados }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("tab", { name: "Catálogo" }));
    await user.click(await screen.findByTestId("extension-install-equipe-exemplo-rotina-comercial-1.1.0"));
    await user.click(
      screen.getByTestId("extension-install-confirm-equipe-exemplo-rotina-comercial-1.1.0"),
    );
    await user.click(screen.getByTestId(`extension-operation-cancel-${deOutraExtensao.id}`));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Preparação cancelada. Este pedido não instalará a extensão.",
      ),
    );
    const botao = screen.getByTestId("extension-install-equipe-exemplo-rotina-comercial-1.1.0");
    expect(botao).toBeDisabled();
    expect(botao).toHaveTextContent("Preparando…");
  });

  it("pedido de outro responsável pela instalação não oferece retomar, só cancelar", async () => {
    const deOutro = operation({
      kind: "install",
      status: "preparing",
      extra: { catalog_id: CATALOG, actor_id: "00000000-0000-4000-8000-000000000099" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: list(ORG_A, { operations: [deOutro] }) })));
    renderManager();

    expect(await screen.findByTestId(`extension-operation-other-actor-${deOutro.id}`)).toBeVisible();
    expect(screen.queryByTestId(`extension-operation-verify-${deOutro.id}`)).toBeNull();
    expect(screen.getByTestId(`extension-operation-cancel-${deOutro.id}`)).toBeEnabled();
  });

  it("o pedido pendente diz o tipo, porque o rótulo é igual para atualizar, desfazer e remover", async () => {
    persistPendingReceipt(window.localStorage, ACTOR, ORG_A, {
      ...RECEIPT,
      kind: "removal",
      label: "equipe-exemplo/rotina-comercial@1.1.0",
      targetKey: `removal:${INSTALLATION}:2`,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: list() })));
    renderManager();

    expect(await screen.findByTestId(`extension-local-receipt-${RECEIPT.id}`)).toHaveTextContent(
      "Remoção da instalação · equipe-exemplo/rotina-comercial@1.1.0",
    );
  });

  it.each([
    ["revert", "Desfazer a última troca · "],
    ["update", "Atualização ou troca de versão · "],
    ["install", "Instalação · "],
  ] as const)("o pedido pendente de %s tem título próprio", async (kind, titulo) => {
    persistPendingReceipt(window.localStorage, ACTOR, ORG_A, {
      ...RECEIPT,
      kind,
      targetKey: `${kind}:${INSTALLATION}:2`,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: list() })));
    renderManager();

    expect(await screen.findByTestId(`extension-local-receipt-${RECEIPT.id}`)).toHaveTextContent(
      `${titulo}${RECEIPT.label}`,
    );
  });

  it("cancelar uma troca para versão menor diz troca de versão, e não atualização", async () => {
    const preparando = operation({
      kind: "update",
      status: "preparing",
      extra: { catalog_id: CATALOG, version: "0.9.0", from_revision: 2, from_version: "1.0.0" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list(ORG_A, { operations: [preparando] }) }))
      .mockResolvedValueOnce(json({ data: { ...preparando, status: "cancelled" } }))
      .mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    const cancelar = await screen.findByTestId(`extension-operation-cancel-${preparando.id}`);
    expect(cancelar).toHaveTextContent("Cancelar troca de versão");
    expect(screen.getByTestId(`extension-operation-verify-${preparando.id}`)).toHaveTextContent(
      "Verificar troca de versão",
    );
    await user.click(cancelar);

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Troca de versão cancelada. A versão instalada continua a mesma.",
      ),
    );
  });

  it.each([
    ["cancelada, para versão maior", "cancelled", "1.1.0", "Atualização cancelada. A versão instalada continua a mesma."],
    ["já concluída, para versão maior", "completed", "1.1.0", "A atualização já havia sido concluída; o recibo foi atualizado."],
    ["já concluída, para versão menor", "completed", "0.9.0", "A troca de versão já havia sido concluída; o recibo foi atualizado."],
  ] as const)("cancelar um update %s diz a coisa certa", async (_caso, status, destino, texto) => {
    const preparando = operation({
      kind: "update",
      status: "preparing",
      extra: { catalog_id: CATALOG, version: destino, from_revision: 2, from_version: "1.0.0" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list(ORG_A, { operations: [preparando] }) }))
      .mockResolvedValueOnce(json({ data: { ...preparando, status } }))
      .mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByTestId(`extension-operation-cancel-${preparando.id}`));

    const chamado = status === "cancelled" ? toast.success : toast.info;
    await waitFor(() => expect(chamado).toHaveBeenCalledWith(texto));
  });

  it.each([
    ["já concluída", "completed", "A instalação já havia sido concluída; o recibo foi atualizado."],
    ["que já havia falhado", "failed", "A preparação já havia falhado; o recibo foi atualizado."],
  ] as const)("cancelar uma instalação %s diz o que aconteceu, sem anunciar cancelamento", async (_caso, status, texto) => {
    const preparando = operation({
      kind: "install",
      status: "preparing",
      extra: { catalog_id: CATALOG, version: "1.0.0" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list(ORG_A, { operations: [preparando] }) }))
      .mockResolvedValueOnce(json({ data: { ...preparando, status } }))
      .mockResolvedValue(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByTestId(`extension-operation-cancel-${preparando.id}`));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(texto));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("para quem não administra a organização, a versão reinstalada incompatível também não pede reativar", async () => {
    const dados = list(ORG_A, {
      can_manage: false,
      can_install: false,
      installations: [
        installation({
          deactivated_by_removal_at: "2026-09-15T12:00:00.000Z",
          compatible: false,
          compatibility_reason: "Esta extensão não é compatível com a API disponível nesta instalação.",
          active_organizations: null,
        }),
      ],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: dados })));
    renderManager();

    const aviso = await screen.findByTestId(`extension-reactivate-${INSTALLATION}`);
    expect(aviso).toHaveTextContent("A versão reinstalada não pode ser ativada");
    expect(aviso).not.toHaveTextContent("para ativar de novo");
  });

  it("um desfazer com nenhuma organização ativa ainda mostra a contagem", async () => {
    const recibo = operation({
      id: "00000000-0000-4000-8000-000000000055",
      kind: "revert",
      extra: { from_version: "1.1.0", to_version: "1.0.0", from_revision: 3, organizations_affected: 0 },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: list(ORG_A, { operations: [recibo] }) })));
    renderManager();

    expect(
      await screen.findByText("equipe-exemplo/rotina-comercial 1.1.0 → 1.0.0 · nenhuma organização com ela ativa"),
    ).toBeVisible();
  });

  it("reinstalada numa versão incompatível não manda ativar de novo", async () => {
    const dados = list(ORG_A, {
      can_install: false,
      installations: [
        installation({
          deactivated_by_removal_at: "2026-09-15T12:00:00.000Z",
          compatible: false,
          compatibility_reason: "Esta extensão não é compatível com a API disponível nesta instalação.",
          active_organizations: null,
        }),
      ],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: dados })));
    renderManager();

    const aviso = await screen.findByTestId(`extension-reactivate-${INSTALLATION}`);
    expect(aviso).toHaveTextContent("A versão reinstalada não pode ser ativada");
    expect(aviso).not.toHaveTextContent("Ative de novo");
  });

  it("o diálogo do catálogo fecha quando outra sessão muda a instalação, em vez de confirmar sobre o estado novo", async () => {
    const entrada: CatalogEntry = {
      publisher: "equipe-exemplo",
      name: "rotina-comercial",
      version: "1.1.0",
      license: "MIT",
      host_api: { min: 1, max: 1 },
      display: { ...DISPLAY },
      permissions: ["navigation.tasks"],
      sha256: "a".repeat(64),
      byte_length: 100,
    };
    const catalogos = [
      {
        id: CATALOG,
        origin: "https://extensions.example/catalog.json",
        revision: 1,
        admitted_at: "2026-09-15T00:00:00.000Z",
        entries: [entrada],
      },
    ];
    const antes = list(ORG_A, { catalogs: catalogos, installations: [installation({ installation_revision: 4 })] });
    const depois = list(ORG_A, { catalogs: catalogos, installations: [installation({ installation_revision: 5 })] });
    // A recarga de controle traz um recibo novo: é a marca visível de que ela foi aplicada à tela
    // antes de afirmar que o diálogo continua aberto.
    const marca = operation({ id: "00000000-0000-4000-8000-000000000077", kind: "catalog_admission" });
    const antesComMarca = { ...antes, operations: [marca] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: antes }))
      .mockResolvedValueOnce(json({ data: antesComMarca }))
      .mockResolvedValue(json({ data: depois }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("tab", { name: "Catálogo" }));
    const identidade = "equipe-exemplo-rotina-comercial-1.1.0";
    await user.click(await screen.findByTestId(`extension-install-${identidade}`));
    expect(await screen.findByTestId(`extension-install-dialog-${identidade}`)).toBeVisible();

    // Controle: uma recarga SEM mudança na instalação mantém o diálogo aberto. Sem isto, uma chave
    // que mudasse a cada recarga também "passaria", e ninguém conseguiria confirmar nada.
    fireEvent(window, new Event("focus"));
    expect(await screen.findByTestId(`extension-operation-${marca.id}`)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId(`extension-install-dialog-${identidade}`)).toBeVisible();

    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(screen.queryByTestId(`extension-install-dialog-${identidade}`)).toBeNull());
    expect(fetchMock.mock.calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === "GET")).toBe(true);
  });

  it("a organização vê a extensão removida e, depois de reinstalada, por que ela está desligada", async () => {
    const REMOVIDA = "00000000-0000-4000-8000-000000000031";
    const dados = list(ORG_A, {
      can_install: false,
      installations: [
        installation({ id: REMOVIDA, removed_at: "2026-09-16T12:00:00.000Z", active_organizations: null }),
        installation({ deactivated_by_removal_at: "2026-09-15T12:00:00.000Z", active_organizations: null }),
      ],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: dados })));
    renderManager();

    const removida = await screen.findByTestId(`extension-installed-${REMOVIDA}`);
    expect(removida).toHaveTextContent("Removida");
    expect(screen.getByTestId(`extension-removed-${REMOVIDA}`)).toHaveTextContent(
      /O responsável pela instalação removeu esta extensão em .+\. Os guias saíram de todas as organizações/,
    );
    expect(screen.queryByTestId(`extension-save-${REMOVIDA}`)).toBeNull();
    expect(screen.getByTestId(`extension-reactivate-${INSTALLATION}`)).toHaveTextContent(
      /Estava ativa até ser removida da instalação em .+\. Ative de novo para voltar a mostrar os guias\./,
    );
  });

  it("o catálogo oferece atualizar a identidade instalada, e o pedido leva a revisão exibida", async () => {
    const entrada: CatalogEntry = {
      publisher: "equipe-exemplo",
      name: "rotina-comercial",
      version: "1.1.0",
      license: "MIT",
      host_api: { min: 1, max: 1 },
      display: { ...DISPLAY },
      permissions: ["navigation.tasks"],
      sha256: "a".repeat(64),
      byte_length: 100,
    };
    const dados = list(ORG_A, {
      catalogs: [
        {
          id: CATALOG,
          origin: "https://extensions.example/catalog.json",
          revision: 1,
          admitted_at: "2026-09-15T00:00:00.000Z",
          entries: [entrada],
        },
      ],
      installations: [installation({ installation_revision: 4, active_organizations: 1 })],
    });
    let corpo: unknown = null;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: dados }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        corpo = JSON.parse(String(init?.body));
        const id = new Headers(init?.headers).get("Idempotency-Key")!;
        return Promise.resolve(
          json({
            data: operation({
              id,
              kind: "update",
              extra: { from_version: "1.0.0", to_version: "1.1.0", from_revision: 4, organizations_affected: 1 },
            }),
          }),
        );
      })
      .mockResolvedValue(json({ data: dados }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();

    await user.click(await screen.findByRole("tab", { name: "Catálogo" }));
    const identidade = "equipe-exemplo-rotina-comercial-1.1.0";
    const botao = await screen.findByTestId(`extension-install-${identidade}`);
    expect(botao).toHaveTextContent("Atualizar para 1.1.0");
    await user.click(botao);
    expect(await screen.findByTestId(`extension-install-dialog-${identidade}`)).toHaveTextContent(
      "1 organização tem esta extensão ativa e continua com ela ativa, com a configuração de hoje.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId(`extension-install-confirm-${identidade}`));

    await waitFor(() =>
      expect(corpo).toEqual({
        catalog_id: CATALOG,
        publisher: "equipe-exemplo",
        name: "rotina-comercial",
        version: "1.1.0",
        expected_installation_revision: 4,
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Extensão atualizada. As organizações que a usavam continuam com ela ativa.",
      ),
    );
  });

  it("sincroniza recibo criado por outra aba", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: list() })));
    renderManager();
    await screen.findByTestId(`extension-installed-${INSTALLATION}`);

    persistPendingReceipt(window.localStorage, ACTOR, ORG_A, RECEIPT);
    const key = window.localStorage.key(0);
    fireEvent(window, new StorageEvent("storage", { key }));

    expect(await screen.findByTestId(`extension-local-receipt-${RECEIPT.id}`)).toBeVisible();
  });

  it("remove recibo somente no 404 canônico", async () => {
    persistPendingReceipt(window.localStorage, ACTOR, ORG_A, RECEIPT);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "extension_operation_not_found",
              message: "Pedido não encontrado. Consulte o histórico da instalação.",
            },
          },
          404,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    await userEvent.click(await screen.findByText("Verificar recibo"));

    await waitFor(() => expect(readPendingReceipts(window.localStorage, ACTOR, ORG_A)).toEqual([]));
  });

  it("remove recibo confirmado mesmo fora da janela da lista", async () => {
    persistPendingReceipt(window.localStorage, ACTOR, ORG_A, RECEIPT);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: list() }))
      .mockResolvedValueOnce(json({ data: operation() }))
      .mockResolvedValueOnce(json({ data: list() }));
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    await userEvent.click(await screen.findByText("Verificar recibo"));

    await waitFor(() => expect(readPendingReceipts(window.localStorage, ACTOR, ORG_A)).toEqual([]));
  });
});
