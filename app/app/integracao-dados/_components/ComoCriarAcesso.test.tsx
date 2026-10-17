import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

import { SQL_MYSQL_CRIAR_E_LIBERAR_VIEW, SQL_MYSQL_CRIAR_USUARIO } from "@/lib/external-db/guia-de-acesso";

import { ComoCriarAcesso } from "./ComoCriarAcesso";

describe("ComoCriarAcesso", () => {
  it("no MySQL mostra o guia com os dois blocos de comando", () => {
    const { container } = render(<ComoCriarAcesso motor="mysql" />);
    expect(screen.getByTestId("como-criar-acesso")).toBeTruthy();
    expect(screen.getByText("Como criar um acesso só de leitura (guia rápido)")).toBeTruthy();
    expect(container.textContent).toContain(SQL_MYSQL_CRIAR_USUARIO);
    expect(container.textContent).toContain(SQL_MYSQL_CRIAR_E_LIBERAR_VIEW);
  });

  it("no PostgreSQL não aparece (não há comando medido para ele)", () => {
    const { container } = render(<ComoCriarAcesso motor="postgres" />);
    expect(container.firstChild).toBeNull();
  });
});
