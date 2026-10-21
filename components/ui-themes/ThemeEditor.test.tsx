import { renderToString } from "react-dom/server";
// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const mocks = vi.hoisted(() => ({ update: vi.fn(), refresh: vi.fn(), success: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success } }));
vi.mock("@/app/actions/settings/updateUiTheme", () => ({ updateUiTheme: mocks.update }));
vi.mock("./ThemePreview", () => ({
  ThemePreview: ({ areaId }: { areaId: string }) => (
    <p data-testid="area-sample" data-area={areaId}>
      Amostra genérica
    </p>
  ),
}));
vi.mock("./PreviewFrame", () => ({
  PreviewFrame: ({ children, appearance }: { children: React.ReactNode; appearance: string }) => (
    <div data-testid="preview-frame" data-appearance={appearance}>
      {children}
    </div>
  ),
}));
import { ThemeEditor } from "./ThemeEditor";
import { padrao } from "@/ui-themes/padrao/definition";
import type { InstalledUiTheme } from "@/lib/ui-themes/contracts";
const catalog: InstalledUiTheme[] = [
  { installationId: "builtin-padrao-v1", enabled: true, package: padrao },
  {
    installationId: "demo-install-1",
    enabled: true,
    package: {
      apiVersion: 1,
      id: "demo",
      title: "Exemplo genérico",
      version: "1.0.0",
      description: "Apenas teste",
      optionsVersion: 1,
      areas: {},
      options: [
        {
          key: "global.spacing",
          label: "Espaçamento",
          type: "enum",
          default: "normal",
          choices: [
            { value: "normal", label: "Normal" },
            { value: "wide", label: "Amplo" },
          ],
        },
      ],
    },
  },
];
const props = {
  catalog,
  saved: null,
  catalogHash: "a".repeat(64),
  loadError: null,
  canWrite: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({ ok: true, revision: 1, appliedNow: true });
  document.documentElement.setAttribute("data-theme", "light");
});
afterEach(cleanup);
describe("editar, prever, aplicar e cancelar são estados distintos", () => {
  it("seleção/prévia escura não gravam nem alteram a aparência ativa; cancelar restaura", async () => {
    const user = userEvent.setup();
    render(<ThemeEditor {...props} />);
    const storage = localStorage.length;
    await user.selectOptions(screen.getByLabelText("Tema em edição"), "demo");
    await user.selectOptions(screen.getByLabelText("Espaçamento"), "wide");
    expect(screen.getByText("Padrão", { selector: "strong" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Visualizar prévia" }));
    await user.selectOptions(screen.getByLabelText("Aparência da prévia"), "dark");
    expect(screen.getByTestId("preview-frame").getAttribute("data-appearance")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.length).toBe(storage);
    expect(mocks.update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancelar edição" }));
    expect((screen.getByLabelText("Tema em edição") as HTMLSelectElement).value).toBe("padrao");
    expect(screen.queryByTestId("preview-frame")).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("aplicar envia revisão e opções da edição, e recarrega pelo loader", async () => {
    const user = userEvent.setup();
    render(<ThemeEditor {...props} />);
    await user.selectOptions(screen.getByLabelText("Tema em edição"), "demo");
    await user.selectOptions(screen.getByLabelText("Espaçamento"), "wide");
    await user.click(screen.getByRole("button", { name: "Aplicar tema" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        themeId: "demo",
        installationId: "demo-install-1",
        revision: 0,
        options: { "global.spacing": "wide" },
      }),
    );
  });
  it("erro mantém rascunho e a repetição usa o mesmo id de pedido", async () => {
    mocks.update
      .mockResolvedValueOnce({ ok: false, error: "db_error" })
      .mockResolvedValueOnce({ ok: true, revision: 1, appliedNow: false });
    const user = userEvent.setup();
    render(<ThemeEditor {...props} />);
    await user.selectOptions(screen.getByLabelText("Tema em edição"), "demo");
    await user.click(screen.getByRole("button", { name: "Aplicar tema" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Tema em edição") as HTMLSelectElement).value).toBe("demo");
    await user.click(screen.getByRole("button", { name: "Aplicar tema" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[0]![0].requestId).toBe(mocks.update.mock.calls[1]![0].requestId);
  });
  it.each([{ canWrite: false }, { loadError: "configuration_unavailable" }])(
    "sem escrita disponível o formulário não dispara action (%s)",
    async (extra) => {
      const user = userEvent.setup();
      render(<ThemeEditor {...props} {...extra} />);
      const button = screen.getByRole("button", { name: "Aplicar tema" });
      expect((button.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
      await user.click(button);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
});

describe("restauração e cobertura da prévia", () => {
  it("restaura defaults somente no rascunho; cancelar recupera os valores salvos", async () => {
    const user = userEvent.setup();
    render(
      <ThemeEditor
        {...props}
        saved={{
          organization_id: "org-a",
          theme_id: "demo",
          installation_id: "demo-install-1",
          revision: 3,
          configurations: { demo: { version: 1, values: { "global.spacing": "wide" } } },
        }}
      />,
    );
    expect((screen.getByLabelText("Espaçamento") as HTMLSelectElement).value).toBe("wide");
    await user.click(screen.getByRole("button", { name: "Restaurar opções" }));
    expect((screen.getByLabelText("Espaçamento") as HTMLSelectElement).value).toBe("normal");
    expect(mocks.update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancelar edição" }));
    expect((screen.getByLabelText("Espaçamento") as HTMLSelectElement).value).toBe("wide");
  });
  it("a escolha de área da amostra não grava nem troca o tema ativo", async () => {
    const user = userEvent.setup();
    render(<ThemeEditor {...props} />);
    await user.click(screen.getByRole("button", { name: "Visualizar prévia" }));
    await user.selectOptions(screen.getByLabelText("Área da prévia"), "calendar");
    expect(screen.getByTestId("area-sample")).toHaveAttribute("data-area", "calendar");
    expect(screen.getByText("Padrão", { selector: "strong" })).toBeTruthy();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

it("SSR não oferece edição antes de instalar os handlers", () => {
  const html = renderToString(<ThemeEditor {...props} />);
  const doc = new DOMParser().parseFromString(html, "text/html");
  expect(doc.querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
});

describe("Marca global usa o mesmo rascunho com destino explícito de novas organizações", () => {
  it("prévia não chama gravador; salvar envia ao destino global sem aplicar ao tenant", async () => {
    const applyAction = vi.fn().mockResolvedValue({ ok: true, revision: 1, appliedNow: true });
    const user = userEvent.setup();
    render(<ThemeEditor {...props} scope="installation-default" applyAction={applyAction} />);
    expect(screen.getByRole("heading", { name: "Tema inicial de novas organizações" })).toBeTruthy();
    expect(screen.getByText(/As organizações existentes mantêm suas escolhas/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Tema em edição"), "demo");
    await user.selectOptions(screen.getByLabelText("Espaçamento"), "wide");
    await user.click(screen.getByRole("button", { name: "Visualizar prévia" }));
    expect(applyAction).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Salvar tema inicial" }));
    await waitFor(() => expect(applyAction).toHaveBeenCalledOnce());
    expect(applyAction).toHaveBeenCalledWith(expect.objectContaining({ themeId: "demo", revision: 0, options: { "global.spacing": "wide" } }));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledWith("Tema inicial salvo para as próximas organizações.");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
  it("erro de autoridade global conserva rascunho e explica o nível necessário", async () => {
    const applyAction = vi.fn().mockResolvedValue({ ok: false, error: "forbidden" });
    const user = userEvent.setup();
    render(<ThemeEditor {...props} scope="installation-default" applyAction={applyAction} />);
    await user.selectOptions(screen.getByLabelText("Tema em edição"), "demo");
    await user.click(screen.getByRole("button", { name: "Salvar tema inicial" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Somente administradores plenos da plataforma");
    expect((screen.getByLabelText("Tema em edição") as HTMLSelectElement).value).toBe("demo");
    expect(mocks.refresh).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();
  });
  it("sem autoridade global a seção é legível e os controles ficam desabilitados", () => {
    render(<ThemeEditor {...props} scope="installation-default" canWrite={false} />);
    expect(screen.getByRole("button", { name: "Salvar tema inicial" }).closest("fieldset")).toBeDisabled();
    expect(screen.getByText("Somente administradores plenos da plataforma podem definir o tema inicial.")).toBeTruthy();
  });
});
