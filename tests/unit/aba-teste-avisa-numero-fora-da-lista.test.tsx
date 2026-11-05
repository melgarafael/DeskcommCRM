/**
 * A ABA TESTE AVISA QUANDO O NÚMERO QUE VAI TESTAR ESTÁ FORA DA LISTA (#3976).
 *
 * O teste da aba é dry-run: ele NÃO passa pelo canal. Então ele respondia
 * normalmente para um número que o WhatsApp real descartaria — e a pessoa
 * concluía "aqui funciona", mandava a mensagem do celular e continuava sem
 * resposta. É o mesmo defeito da issue, um passo adiante: a tela mostrava
 * sucesso onde o produto ia calar.
 *
 * Aqui o número é CONHECIDO (é o campo "Telefone" que a pessoa preenche), então
 * é a única superfície do editor que pode dizer "este número não está na lista"
 * sem inventar quem tentou falar com o canal. A lista de autorizados vem da
 * rota que exige administrador; abaixo disso a tela nem a pede.
 *
 * Os dois textos são diferentes de propósito — lista vazia manda cadastrar
 * alguém, número fora da lista manda cadastrar AQUELE número — e o conselho só
 * faz sentido junto do motivo.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const AGENTE = "44444444-4444-4444-8444-444444444444";
const CANAL = "22222222-2222-4222-8222-222222222222";

const DA_EQUIPE = "+5511987654321";
const DE_FORA = "+5511955554444";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { TestPanel } from "@/app/app/ai/agents/[id]/_components/TestPanel";

const AGENTE_ROW = { id: AGENTE, name: "Sofia", published_version_id: null } as never;

const VERSAO = {
  id: "v1",
  version_number: 1,
  status: "published",
  provider: "anthropic",
  model: "claude-sonnet-5",
  channel_session_id: CANAL,
} as never;

function abrirAbaTeste(opcoes: {
  modo?: "open" | "pre_go_live" | "allowlist";
  quantos?: number;
  readOnly?: boolean;
} = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const canal = {
    id: CANAL,
    display_name: "WhatsApp da clínica",
    status: "WORKING",
    phone_number: null,
    aceitaMensagemLivre: true,
    acessoDaAi: { mode: opcoes.modo ?? "pre_go_live", testNumbersCount: opcoes.quantos ?? 1 },
  };
  render(
    <QueryClientProvider client={qc}>
      <TestPanel
        agent={AGENTE_ROW}
        draft={null}
        published={VERSAO}
        readOnly={opcoes.readOnly}
        channelSessions={[canal] as never}
      />
    </QueryClientProvider>,
  );
  return () => screen.getByLabelText(/telefone \(opcional\)/i);
}

describe("aba Teste — modo de teste do canal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ data: { mode: "pre_go_live", test_phone_numbers: [DA_EQUIPE] } });
  });

  it("número fora da lista: diz que a IA não responderia a ele no WhatsApp", async () => {
    const telefone = abrirAbaTeste();
    fireEvent.change(telefone(), { target: { value: DE_FORA } });

    const aviso = await screen.findByTestId("aviso-modo-de-teste");
    expect(aviso).toHaveTextContent(/modo de teste/i);
    expect(aviso).toHaveTextContent(new RegExp(DE_FORA.replace("+", "\\+")));
    expect(aviso).toHaveTextContent(/não está na lista de teste deste canal/i);
    // O dry-run não passa pelo canal: sem esta frase, o aviso pareceria dizer
    // que o teste falhou.
    expect(aviso).toHaveTextContent(/não passa pelo canal/i);
    expect(screen.getByRole("link", { name: /configurar acesso da ia/i })).toHaveAttribute(
      "href",
      "/app/connections",
    );
  });

  it("número que ESTÁ na lista: nenhum aviso", async () => {
    const telefone = abrirAbaTeste();
    fireEvent.change(telefone(), { target: { value: DA_EQUIPE } });

    // Espera a lista chegar antes de concluir pela ausência: sem isto o caso
    // passaria só porque a consulta ainda não voltou.
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByTestId("aviso-modo-de-teste")).toBeNull();
  });

  it("canal aberto ao público: nenhum aviso, e nem busca a lista", async () => {
    const telefone = abrirAbaTeste({ modo: "open" });
    fireEvent.change(telefone(), { target: { value: DE_FORA } });

    expect(screen.queryByTestId("aviso-modo-de-teste")).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("sem permissão de editar: não pede a lista (evita 403) e não oferece o link", async () => {
    const telefone = abrirAbaTeste({ readOnly: true });
    // O campo também está desabilitado para quem não edita; o valor entra pelo
    // estado para provar que, mesmo assim, o aviso não aparece com link.
    fireEvent.change(telefone(), { target: { value: DE_FORA } });

    expect(screen.queryByTestId("aviso-modo-de-teste")).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("lista vazia no canal: o aviso é o de cadastrar quem vai testar", async () => {
    const telefone = abrirAbaTeste({ quantos: 0 });
    fireEvent.change(telefone(), { target: { value: DE_FORA } });

    const aviso = await screen.findByTestId("aviso-modo-de-teste");
    expect(aviso).toHaveTextContent(/nenhum número autorizado neste canal/i);
    expect(api.get).not.toHaveBeenCalled();
  });
});
