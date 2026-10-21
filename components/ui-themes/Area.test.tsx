// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { createRef } from "react";
import { UiThemeArea } from "./Area";
import { UiThemeProvider } from "./Provider";
import type { ResolvedUiTheme } from "@/lib/ui-themes/resolve";
afterEach(cleanup);

const contract = {
  id: "example",
  version: 1,
  regions: ["heading", "content"],
  required: ["heading", "content"],
};
const theme: ResolvedUiTheme = {
  values: {},
  fallback: null,
  requestedId: "example",
  package: {
    apiVersion: 1,
    id: "example",
    title: "Exemplo",
    version: "1.0.0",
    description: "Genérico",
    optionsVersion: 1,
    options: [],
    global: {
      tokens: {
        palette: "sage",
        claro: { "--color-bg": "#ffffff" },
        escuro: { "--color-bg": "#111111" },
      },
    },
    areas: {
      example: {
        contractVersion: 1,
        configuration: {},
        regions: {},
        layout: {
          type: "row",
          children: [
            { type: "slot", name: "content" },
            { type: "slot", name: "heading" },
          ],
        },
      },
    },
  },
};
describe("área real com fallback e prévia isolada", () => {
  it("retém ref, metadados e complementos do host na raiz medida", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <UiThemeProvider theme={theme}>
        <UiThemeArea
          contract={contract}
          rootProps={{
            ref,
            className: "host-root",
            style: { gridTemplateColumns: "250px 1fr" },
            "aria-label": "Área medida",
          }}
          slotProps={{ heading: { style: { display: "none" } } }}
          slots={{ heading: <h2>Título</h2>, content: <button>Conteúdo</button> }}
          after={<span data-testid="adjunct">Complemento</span>}
          fallback={<p>Retorno</p>}
        />
      </UiThemeProvider>,
    );
    const area = container.querySelector('[data-ui-area="example"]');
    expect(ref.current).toBe(area);
    expect(area?.classList.contains("host-root")).toBe(true);
    expect(area?.contains(screen.getByTestId("adjunct"))).toBe(true);
    expect(container.querySelector('[data-ui-region="heading"]')?.getAttribute("style")).toContain(
      "display: none",
    );
    expect(container.querySelectorAll('[data-testid="adjunct"]')).toHaveLength(1);
  });
  it("sem contribuição retorna a composição nativa íntegra", () => {
    const { container } = render(
      <UiThemeArea
        contract={contract}
        slots={{}}
        fallback={
          <main>
            <button>Ação nativa</button>
          </main>
        }
      />,
    );
    expect(container.innerHTML).toBe("<main><button>Ação nativa</button></main>");
  });
  it("compõe os mesmos elementos e handlers em outra ordem", () => {
    const { container } = render(
      <UiThemeProvider theme={theme}>
        <UiThemeArea
          contract={contract}
          slots={{ heading: <h2>Título</h2>, content: <button>Conteúdo</button> }}
          fallback={<p>Retorno</p>}
        />
      </UiThemeProvider>,
    );
    expect(
      Array.from(container.querySelectorAll("[data-ui-region]")).map((e) =>
        e.getAttribute("data-ui-region"),
      ),
    ).toEqual(["content", "heading"]);
    expect(screen.getByRole("button", { name: "Conteúdo" })).toBeTruthy();
  });
  it("contrato incompleto ou incompatível retorna à composição nativa", () => {
    render(
      <UiThemeProvider theme={theme}>
        <UiThemeArea
          contract={{ ...contract, version: 2 }}
          slots={{ heading: "h", content: "c" }}
          fallback={<p>Retorno completo</p>}
        />
      </UiThemeProvider>,
    );
    expect(screen.getByText("Retorno completo")).toBeTruthy();
  });
  it("prévia do mesmo pacote tem escopo próprio e não muda aparência/storage ativos", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const before = localStorage.length;
    const { container } = render(
      <>
        <UiThemeProvider theme={theme}>
          <p>Ativo</p>
        </UiThemeProvider>
        <UiThemeProvider theme={theme} previewAppearance="dark">
          <p>Prévia</p>
        </UiThemeProvider>
      </>,
    );
    const roots = Array.from(container.querySelectorAll("[data-ui-theme-instance]"));
    expect(roots).toHaveLength(2);
    const ids = roots.map((root) => root.getAttribute("data-ui-theme-instance"));
    expect(ids[0]).not.toBe(ids[1]);
    roots.forEach((root, i) => {
      const css = root.querySelector("style")!.textContent!;
      expect(css).toContain(`[data-ui-theme-instance="${ids[i]}"]`);
      expect(css).not.toContain(`[data-ui-theme-instance="${ids[1 - i]}"]`);
      if (i === 1) expect(css).not.toContain("body:has");
      else expect(css).toContain(`body:has([data-ui-theme-instance="${ids[i]}"])`);
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.length).toBe(before);
  });
});
