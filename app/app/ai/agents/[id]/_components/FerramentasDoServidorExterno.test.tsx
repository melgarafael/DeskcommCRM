/**
 * O cartão que liga as ferramentas do servidor MCP externo no agente (#2147).
 *
 * A listagem é mockada: aqui se mede o contrato da TELA com o `tool_ids` — que
 * id entra ao ligar, o que sai ao desligar, o teto, e que quem não pode listar
 * não vê nada. A permissão da listagem tem teste próprio em
 * `tests/unit/cadastro-do-mcp-externo-e-o-platform-admin.test.ts`.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/settings/listarFerramentasMcpExternas", () => ({
  listarFerramentasMcpExternas: vi.fn(),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { listarFerramentasMcpExternas } from "@/app/actions/settings/listarFerramentasMcpExternas";

import { FerramentasDoServidorExterno } from "./FerramentasDoServidorExterno";

const listagem = () => vi.mocked(listarFerramentasMcpExternas);

const AGENDA = {
  nome: "consultar_agendamentos",
  descricao: "Consulta (somente leitura) os próximos agendamentos",
  ids: ["mcp_externo:leitura:consultar_agendamentos", "mcp_externo:escrita:consultar_agendamentos"],
  declaradaLeitura: true,
};
const CANCELAR = {
  nome: "cancelar_exame",
  descricao: null,
  ids: ["mcp_externo:escrita:cancelar_exame"],
  declaradaLeitura: false,
};

function abrir(value: string[], vagas = 10) {
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FerramentasDoServidorExterno value={value} onChange={onChange} vagas={vagas} />
    </QueryClientProvider>,
  );
  return onChange;
}

beforeEach(() => {
  listagem().mockReset();
  listagem().mockResolvedValue({
    ok: true,
    host: "agenda.exemplo.com",
    ferramentas: [AGENDA, CANCELAR],
  });
});

describe("FerramentasDoServidorExterno", () => {
  it("ligar a ferramenta declarada só leitura grava o id de LEITURA", async () => {
    const onChange = abrir([]);
    fireEvent.click(await screen.findByRole("switch", { name: "consultar_agendamentos" }));
    expect(onChange).toHaveBeenCalledWith(["mcp_externo:leitura:consultar_agendamentos"]);
  });

  it("a que não declarou só leitura só entra como escrita, e a tela avisa a recusa na conversa", async () => {
    const onChange = abrir([]);
    fireEvent.click(await screen.findByRole("switch", { name: "cancelar_exame" }));
    expect(onChange).toHaveBeenCalledWith(["mcp_externo:escrita:cancelar_exame"]);
    expect(screen.getByText(/o CRM recusa usá-la/)).toBeTruthy();
  });

  it("desligar tira o id salvo e preserva as outras remotas", async () => {
    const onChange = abrir([
      "mcp_externo:leitura:consultar_agendamentos",
      "mcp_externo:escrita:cancelar_exame",
    ]);
    const chave = await screen.findByRole("switch", { name: "consultar_agendamentos" });
    expect(chave.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(chave);
    expect(onChange).toHaveBeenCalledWith(["mcp_externo:escrita:cancelar_exame"]);
  });

  it("sem vaga no teto, a desligada não liga; a ligada continua desligável", async () => {
    abrir(["mcp_externo:leitura:consultar_agendamentos"], 0);
    expect(
      (await screen.findByRole("switch", { name: "cancelar_exame" })).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("switch", { name: "consultar_agendamentos" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("remota salva que o servidor não anuncia mais aparece com o botão de desligar", async () => {
    const onChange = abrir(["mcp_externo:leitura:ferramenta_antiga"]);
    expect(await screen.findByText("ferramenta_antiga")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Desligar" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("quem não pode listar (não é o dono da instalação) não vê o cartão", async () => {
    listagem().mockResolvedValue({ ok: false, error: "forbidden_role" });
    abrir(["mcp_externo:leitura:consultar_agendamentos"]);
    await vi.waitFor(() => expect(listagem()).toHaveBeenCalled());
    expect(screen.queryByTestId("ferramentas-do-servidor-externo")).toBeNull();
  });
});
