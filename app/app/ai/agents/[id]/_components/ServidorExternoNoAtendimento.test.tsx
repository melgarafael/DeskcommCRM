/**
 * O EDITOR DO AGENTE LISTA E MARCA AS FERRAMENTAS DO SERVIDOR MCP EXTERNO
 * (#3586 — fecha o item 6 da #2147, que tinha runtime e validação mas não
 * tinha tela).
 *
 * ─── O defeito que este arquivo existe para pegar ──────────────────────────
 *
 * O cartão do editor era SÓ um interruptor: gravava
 * `config.mcp_externo_no_atendimento` e nunca tocava em `tool_ids`. O runtime
 * monta ferramenta remota com duas condições (`lib/ai/runtime/tools.ts`:643) —
 * a flag do servidor E uma escolha `mcp_externo:*` no `tool_ids` da versão.
 * Ligado o interruptor e sem escolha nenhuma, o agente ficava sem a ferramenta
 * e o servidor não via requisição nenhuma, nem `tools/list`. Foi o que o
 * cliente relatou: "Testar conexão" gerando 4 requisições no log dele e
 * atendimento real gerando 0.
 *
 * ─── O que cada caso cobra, e o que ele pega de volta ───────────────────────
 *
 *  1. marcar três ferramentas grava os TRÊS ids, preservando o catálogo;
 *  2. desmarcar tira só aquela — as outras duas ficam;
 *  3. a marca nasce ESCRITA (falha fechado): `readOnlyHint` do servidor não
 *     escolhe nada, só decide se a opção `leitura` pode ser oferecida;
 *  4. ferramenta marcada que o servidor não anuncia mais aparece com aviso e
 *     botão que tira só ela;
 *  5. servidor fora do ar mostra erro e NÃO apaga o que está salvo — apagar a
 *     escolha do administrador por causa de um terceiro desligado seria o
 *     defeito oposto ao da issue;
 *  6. agente com o interruptor desligado não faz rede e não mexe em `tool_ids`.
 *
 * A lista vem da action `listarFerramentasMcpExternas` — a MESMA chamada do
 * "Testar conexão" da tela de cadastro. Aqui ela é a fronteira mockada; a ação
 * de verdade (permissão de platform admin, host, ids por marca) tem teste
 * próprio em `tests/unit/tool-id-remoto-entra-no-tool-ids.test.ts`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listar, patch } = vi.hoisted(() => ({
  listar: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/app/actions/settings/listarFerramentasMcpExternas", () => ({
  listarFerramentasMcpExternas: listar,
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { patch } }));
// `t` devolve a chave: o texto lido aqui é o português que a tela mostra.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { ServidorExternoNoAtendimento } from "@/app/app/ai/agents/[id]/_components/ServidorExternoNoAtendimento";
import { TETO_TOOLS_POR_AGENTE } from "@/lib/mcp/tools/selecao-por-pacote";

/** As três ferramentas do ERP do relato da #3586, todas declaradas leitura. */
const FERRAMENTAS = [
  {
    nome: "buscar_carros",
    descricao: "Consulta o estoque ao vivo.",
    ids: ["mcp_externo:leitura:buscar_carros", "mcp_externo:escrita:buscar_carros"],
    declaradaLeitura: true,
  },
  {
    nome: "detalhes_carro",
    descricao: "Ficha de um carro.",
    ids: ["mcp_externo:leitura:detalhes_carro", "mcp_externo:escrita:detalhes_carro"],
    declaradaLeitura: true,
  },
  {
    nome: "resumo_estoque",
    descricao: null,
    ids: ["mcp_externo:leitura:resumo_estoque", "mcp_externo:escrita:resumo_estoque"],
    declaradaLeitura: true,
  },
];

/**
 * A bancada é `tool_ids` + setter, como o `AgentForm` — o cartão é controlado,
 * e um teste com prop fixa não veria a segunda marcação partir da primeira.
 */
function Bancada({
  inicial = true,
  idsIniciais = ["crm_search_products"],
}: {
  inicial?: boolean;
  idsIniciais?: string[];
}) {
  const [toolIds, setToolIds] = useState<string[]>(idsIniciais);
  return (
    <>
      <ServidorExternoNoAtendimento
        agentId="66666666-6666-4666-8666-666666666666"
        inicial={inicial}
        toolIds={toolIds}
        onChangeToolIds={setToolIds}
      />
      <output data-testid="tool-ids">{JSON.stringify(toolIds)}</output>
    </>
  );
}

function idsNaTela(): string[] {
  return JSON.parse(screen.getByTestId("tool-ids").textContent ?? "[]") as string[];
}

function marcar(nome: string) {
  fireEvent.click(screen.getByTestId(`marcar-${nome}`));
}

beforeEach(() => {
  listar.mockResolvedValue({ ok: true, host: "erp.loja", ferramentas: FERRAMENTAS });
  patch.mockResolvedValue({ data: {} });
});
afterEach(() => {
  cleanup();
  listar.mockReset();
  patch.mockReset();
});

describe("editor do agente — ferramentas do servidor MCP externo (#3586)", () => {
  it("marcar três ferramentas grava os três ids em tool_ids, preservando o catálogo", async () => {
    render(<Bancada />);
    await waitFor(() => expect(screen.getByTestId("ferramentas-do-servidor")).toBeTruthy());

    marcar("buscar_carros");
    marcar("detalhes_carro");
    marcar("resumo_estoque");

    expect(idsNaTela()).toEqual([
      "crm_search_products",
      "mcp_externo:escrita:buscar_carros",
      "mcp_externo:escrita:detalhes_carro",
      "mcp_externo:escrita:resumo_estoque",
    ]);
  });

  it("a marca nasce ESCRITA: a declaração do servidor não escolhe por ninguém", async () => {
    // As três ferramentas anunciam `readOnlyHint: true`. Ainda assim o id que
    // nasce é `escrita` — quem lê o `readOnlyHint` e conclui "é leitura" é o
    // defeito que `ids.ts:19-25` existe para impedir.
    render(<Bancada />);
    await waitFor(() => expect(screen.getByTestId("ferramentas-do-servidor")).toBeTruthy());
    marcar("buscar_carros");

    expect(idsNaTela()).toContain("mcp_externo:escrita:buscar_carros");
    expect(idsNaTela()).not.toContain("mcp_externo:leitura:buscar_carros");
  });

  it("o administrador escolhe LEITURA na ferramenta declarada, e o id troca de marca", async () => {
    render(<Bancada />);
    await waitFor(() => expect(screen.getByTestId("ferramentas-do-servidor")).toBeTruthy());
    marcar("buscar_carros");
    fireEvent.change(screen.getByTestId("marca-buscar_carros"), { target: { value: "leitura" } });

    expect(idsNaTela()).toEqual(["crm_search_products", "mcp_externo:leitura:buscar_carros"]);
  });

  it("leitura NÃO é oferecida para ferramenta que o servidor não declarou", async () => {
    listar.mockResolvedValue({
      ok: true,
      host: "erp.loja",
      ferramentas: [
        {
          nome: "faturar_pedido",
          descricao: null,
          ids: ["mcp_externo:escrita:faturar_pedido"],
          declaradaLeitura: false,
        },
      ],
    });
    render(<Bancada />);
    await waitFor(() => expect(screen.getByTestId("ferramentas-do-servidor")).toBeTruthy());
    marcar("faturar_pedido");

    const select = screen.getByTestId("marca-faturar_pedido") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["escrita"]);
  });

  it("desmarcar tira SÓ aquela — as outras duas ficam", async () => {
    render(
      <Bancada
        idsIniciais={[
          "crm_search_products",
          "mcp_externo:leitura:buscar_carros",
          "mcp_externo:leitura:detalhes_carro",
          "mcp_externo:leitura:resumo_estoque",
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("ferramentas-do-servidor")).toBeTruthy());

    marcar("detalhes_carro");

    expect(idsNaTela()).toEqual([
      "crm_search_products",
      "mcp_externo:leitura:buscar_carros",
      "mcp_externo:leitura:resumo_estoque",
    ]);
  });

  it("ferramenta que o servidor não anuncia mais aparece com aviso, e o botão tira só ela", async () => {
    render(
      <Bancada
        idsIniciais={[
          "crm_search_products",
          "mcp_externo:leitura:buscar_carros",
          "mcp_externo:leitura:carro_que_saiu_do_estoque",
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("remotas-orfas")).toBeTruthy());
    expect(screen.getByTestId("remotas-orfas").textContent).toContain(
      "carro_que_saiu_do_estoque",
    );

    fireEvent.click(screen.getByTestId("remover-remotas-orfas"));

    expect(idsNaTela()).toEqual([
      "crm_search_products",
      "mcp_externo:leitura:buscar_carros",
    ]);
  });

  it("servidor fora do ar mostra erro e NÃO apaga a escolha salva", async () => {
    listar.mockResolvedValue({ ok: false, error: "sem_servidor" });
    render(
      <Bancada
        idsIniciais={["crm_search_products", "mcp_externo:leitura:buscar_carros"]}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("erro-do-servidor")).toBeTruthy());
    expect(screen.getByTestId("erro-do-servidor").textContent).toContain(
      "Nenhum servidor externo respondeu",
    );
    expect(screen.getByTestId("erro-preserva-o-salvo").textContent).toContain(
      "continuam como estão",
    );
    // O essencial: o que estava salvo continua lá. Nada de "lista vazia ⇒
    // apaga as escolhas".
    expect(idsNaTela()).toEqual([
      "crm_search_products",
      "mcp_externo:leitura:buscar_carros",
    ]);
    expect(screen.queryByTestId("remotas-orfas")).toBeNull();
  });

  it("com o teto de capacidades cheio, marcar mais uma é recusado e tool_ids não muda", async () => {
    const cheio = Array.from({ length: TETO_TOOLS_POR_AGENTE }, (_, i) => `nativa_${i}`);
    render(<Bancada idsIniciais={cheio} />);
    await waitFor(() => expect(screen.getByTestId("ferramentas-do-servidor")).toBeTruthy());

    marcar("buscar_carros");

    expect(screen.getByTestId("recusa-teto").textContent).toContain(String(TETO_TOOLS_POR_AGENTE));
    expect(idsNaTela()).toEqual(cheio);
  });

  it("avisa que a marca escrita não roda na conversa com o cliente", async () => {
    render(<Bancada />);
    await waitFor(() => expect(screen.getByTestId("ferramentas-do-servidor")).toBeTruthy());

    expect(screen.getByTestId("aviso-escrita-na-conversa").textContent).toContain("escolha Leitura");
  });

  it("agente com a opção DESLIGADA não faz rede e não mexe em tool_ids", async () => {
    render(<Bancada inicial={false} idsIniciais={["crm_search_products"]} />);

    expect(listar).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ferramentas-do-servidor")).toBeNull();
    expect(idsNaTela()).toEqual(["crm_search_products"]);
  });

  it("opção desligada com escolha salva avisa que ela não entra em conversa", async () => {
    render(
      <Bancada
        inicial={false}
        idsIniciais={[
          "crm_search_products",
          "mcp_externo:leitura:buscar_carros",
          "mcp_externo:leitura:detalhes_carro",
        ]}
      />,
    );

    expect(screen.getByTestId("remotas-salvas-com-opcao-desligada").textContent).toContain(
      "continuam marcadas nesta versão",
    );
    expect(idsNaTela()).toEqual([
      "crm_search_products",
      "mcp_externo:leitura:buscar_carros",
      "mcp_externo:leitura:detalhes_carro",
    ]);
  });
});
