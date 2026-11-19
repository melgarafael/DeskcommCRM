/**
 * ⌘K NO IDIOMA DA TELA (#4999).
 *
 * Achado na prova pela tela do #3480: com a interface em espanhol, a paleta
 * MOSTRA "Productos" e "Servicios", mas só ACHAVA digitando "Produtos" e
 * "Serviços". O casamento olhava só o texto em português (a chave do
 * dicionário), e quem lê "Productos" na tela digita "productos".
 *
 *   1. em es, o rótulo e a descrição traduzidos casam;
 *   2. o termo em português continua casando em es (quem já se acostumou);
 *   3. em pt-BR nada muda — nem casamento novo na junta de dois textos;
 *   4. o que casa só pela DESCRIÇÃO traduzida não passa à frente do nome, e o
 *      Enter abre a porta que a pessoa digitou.
 */
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CommandPalette } from "@/components/shell/CommandPalette";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: { orgId: "org-1", name: "Org", role: "admin" },
};

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => authRef }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/hooks/followup/useFollowupFlows", () => ({ useFollowupFlows: () => ({ data: [] }) }));
const agentes: { id: string; name: string; description?: string | null }[] = [];
vi.mock("@/hooks/ai/useAgents", () => ({ useAgentsList: () => ({ data: agentes }) }));
vi.mock("@/hooks/pipelines/usePipelinesDaPaleta", () => ({ usePipelinesDaPaleta: () => ({ data: [] }) }));

afterEach(() => {
  cleanup();
  push.mockClear();
  agentes.length = 0;
});

function abrir(locale: "pt-BR" | "es") {
  return render(
    createElement(IdiomaProvider, {
      locale,
      children: <CommandPalette open onOpenChange={() => {}} />,
    }),
  );
}

describe("⌘K no idioma da tela", () => {
  it.each([
    ["productos", /Productos/],
    ["conocimiento", /Conocimiento/],
  ])("em es, digitar %s acha a porta pelo nome que a tela mostra", async (termo, nome) => {
    const user = userEvent.setup();
    abrir("es");
    await user.type(screen.getByRole("combobox"), termo);
    expect(screen.getByRole("option", { name: nome })).toBeTruthy();
  });

  it("em es, o termo em português continua achando", async () => {
    const user = userEvent.setup();
    abrir("es");
    await user.type(screen.getByRole("combobox"), "produtos");
    expect(screen.getByRole("option", { name: /Productos/ })).toBeTruthy();
  });

  it("em pt-BR nada muda: acha por produtos, e productos não acha nada", async () => {
    const user = userEvent.setup();
    abrir("pt-BR");
    await user.type(screen.getByRole("combobox"), "produtos");
    expect(screen.getByRole("option", { name: /Produtos/ })).toBeTruthy();
    await user.clear(screen.getByRole("combobox"));
    await user.type(screen.getByRole("combobox"), "productos");
    expect(screen.queryByRole("option", { name: /Produtos/ })).toBeNull();
  });

  it("em pt-BR, dois termos de campos diferentes não casam pela junta (crm produtos)", async () => {
    const user = userEvent.setup();
    abrir("pt-BR");
    await user.type(screen.getByRole("combobox"), "crm produtos");
    expect(screen.queryByRole("option", { name: /Produtos/ })).toBeNull();
  });

  it.each([
    ["agent", "/app/ai/agents"],
    ["ayuda", "/app/ajuda"],
  ])("em es, %s + Enter abre a porta pelo nome, não a que só casa pela descrição traduzida", async (termo, href) => {
    const user = userEvent.setup();
    abrir("es");
    await user.type(screen.getByRole("combobox"), termo);
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith(href);
  });

  it("em es, o nome traduzido vem antes de um agente que só cita o termo na descrição", async () => {
    agentes.push({ id: "ag-1", name: "Recepção", description: "Atiende consultas sobre productos." });
    const user = userEvent.setup();
    abrir("es");
    await user.type(screen.getByRole("combobox"), "productos");
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/app/products");
  });
});
