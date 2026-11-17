import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AmigoCatalogs } from "./_catalogs";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("consulta planos pelo grupo e produtos pelo convênio com seletores nomeados", async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const { operation } = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        data: {
          data:
            operation === "insurances"
              ? [{ id: 42, name: "Grupo Unimed" }]
              : operation === "insurance_plans"
                ? [{ id: 7, name: "Plano regional" }]
                : operation === "insurance_products"
                  ? [{ id: 9, name: "Ouro" }]
                  : [],
        },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<AmigoCatalogs />);
  fireEvent.change(screen.getByLabelText("Catálogo"), { target: { value: "insurance_plans" } });
  await screen.findAllByRole("option", { name: "Grupo Unimed" });
  fireEvent.change(screen.getByLabelText("Grupo de convênio"), { target: { value: "42" } });
  fireEvent.click(screen.getByRole("button", { name: "Consultar catálogo" }));
  expect(await screen.findByText("Plano regional")).toBeVisible();
  expect(
    fetchMock.mock.calls.some(([, init]) => {
      const b = JSON.parse(String(init.body));
      return b.operation === "insurance_plans" && b.input.insurance_group_id === 42;
    }),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Catálogo"), { target: { value: "insurance_products" } });
  fireEvent.change(screen.getByLabelText("Convênio do catálogo"), { target: { value: "42" } });
  fireEvent.click(screen.getByRole("button", { name: "Consultar catálogo" }));
  expect(await screen.findByText("Ouro")).toBeVisible();
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([, init]) => {
        const b = JSON.parse(String(init.body));
        return b.operation === "insurance_products" && b.input.insurance_id === 42;
      }),
    ).toBe(true),
  );
});
