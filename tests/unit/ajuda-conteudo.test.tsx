// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { AjudaConteudo } from "@/app/app/ajuda/_client";
import { IdiomaProvider, useAplicarIdioma } from "@/lib/i18n/IdiomaProvider";
import * as navegacao from "@/lib/navigation/interface";

const authRef: {
  user: Pick<AuthUser, "is_platform_admin" | "support" | "idioma">;
  activeOrg: ActiveOrg | null;
} = { user: { is_platform_admin: false, idioma: "pt-BR" }, activeOrg: null };

// Só o contexto de entrada é sintético. Componente, dicionário, montador dos
// blocos e filtro canônico são reais; isto não prova Auth ou UI de navegador.
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => authRef }));

beforeEach(() => {
  authRef.user = { is_platform_admin: false, idioma: "pt-BR" };
  authRef.activeOrg = { orgId: "org-a", name: "Organização sintética", role: "manager" };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function urls() {
  return screen.queryAllByRole("link").map((a) => a.getAttribute("href")).sort();
}

describe("conteúdo da Ajuda acompanha o contexto do menu", () => {
  it("delega ao filtro real com os mesmos cinco parâmetros do Sidebar", () => {
    const settings = navegacao.combinarInterfaces(
      { preset: "completa", destinos: ["/app/ajuda", "/app/contacts", "/app/kanban"] },
      { preset: "completa", destinos: ["/app/ajuda", "/app/contacts"] },
    );
    const modulos = ["crm_b2b", "propostas"] as const;
    const capacidades: NonNullable<ActiveOrg["capacidades_ligadas"]> = ["propostas"];
    authRef.activeOrg = { ...authRef.activeOrg!, interface_settings: settings,
      modulos_ligados: modulos, capacidades_ligadas: capacidades };
    const filtro = vi.spyOn(navegacao, "destinosDaInterface"); // delega ao original
    render(<AjudaConteudo />);
    expect(filtro).toHaveBeenLastCalledWith(settings, false, "manager", modulos, capacidades);
    expect(urls()).toEqual(["/app/contacts"]);
  });

  it("a troca A → B não conserva atalhos da organização anterior", () => {
    authRef.activeOrg!.interface_settings = { preset: "completa", destinos: ["/app/ajuda", "/app/contacts"] };
    const view = render(<AjudaConteudo />);
    expect(urls()).toEqual(["/app/contacts"]);
    authRef.activeOrg = { orgId: "org-b", name: "Outra organização sintética", role: "agent",
      interface_settings: { preset: "completa", destinos: ["/app/ajuda", "/app/inbox"] } };
    view.rerender(<AjudaConteudo />);
    expect(urls()).toEqual(["/app/inbox"]);
  });

  it("sem atalhos visíveis mantém a página e omite as seções vazias", () => {
    authRef.activeOrg!.interface_settings = { preset: "completa", destinos: ["/app/ajuda"] };
    render(<AjudaConteudo />);
    expect(screen.getByRole("heading", { level: 1, name: "Ajuda" })).toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
    expect(urls()).toEqual([]);
  });

  it("não usa o bypass de plataforma em suporte; preserva a leitura do instalador", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    authRef.user = { is_platform_admin: true, idioma: "pt-BR", support: {
      id, organization_id: id, actor_user_id: id, auth_session_id: id,
      previous_organization_id: null, expires_at: "2099-01-01T00:00:00Z",
      name: "Acompanhamento sintético", locale: "pt-BR", access_mode: "support_readonly", status: "active",
    } };
    authRef.activeOrg!.role = "viewer";
    const filtro = vi.spyOn(navegacao, "destinosDaInterface");
    render(<AjudaConteudo />);
    expect(filtro).toHaveBeenLastCalledWith(undefined, false, "viewer", [], []);
    expect(urls()).toEqual(["/app/contacts", "/app/inbox", "/app/kanban", "/app/settings/atualizacao", "/app/team"]);
  });

  it("o idioma do provider muda o conteúdo antes de mudar user.idioma", () => {
    function SeletorSintetico() {
      const aplicar = useAplicarIdioma();
      return <button onClick={() => aplicar("es")}>Trocar idioma no teste</button>;
    }
    render(<IdiomaProvider locale="pt-BR"><SeletorSintetico /><AjudaConteudo /></IdiomaProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Trocar idioma no teste" }));
    expect(authRef.user.idioma).toBe("pt-BR");
    expect(screen.getByRole("heading", { level: 1, name: "Ayuda" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Enseñarle lo que debe saber/ })).toHaveAttribute("href", "/app/ai/knowledge/sources");
    expect(screen.queryByText("Ensinar o que ele deve saber")).not.toBeInTheDocument();
  });
});
