/**
 * O painel lê duas rotas: a dos pontos (`/api/v1/ai/providers`) e a do Jev
 * (`/api/v1/ai/jev`). O cartão do ponto que o Jev atende precisa das duas —
 * sem a segunda, ele mostraria o modelo como se decidisse sozinho, com o Jev
 * ligado na frente dele.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PainelDeProvedores } from "./PainelDeProvedores";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/app/ai/credentials/_actions", () => ({ refreshCredentialsView: vi.fn() }));

const PROVEDORES = {
  papeis: { entender: { rotulo: "Entender a conversa", explicacao: "" } },
  pontos: [
    {
      id: "sentiment_classify",
      rotulo: "Medir o clima da conversa",
      oQueFaz: "Avalia se o cliente está satisfeito ou irritado.",
      papel: "entender",
      exige: {},
      sintomaDeFalha: "Cliente irritado não é escalado.",
      fixo: null,
      mandadoPeloAgente: false,
      efetivo: {
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        credentialId: null,
        baseUrl: null,
        origem: "padrao_da_organizacao",
        porQue: "padrão da empresa",
      },
      avisos: [],
    },
  ],
  provedores: [],
  credenciais: [],
  modelos: [],
  padrao: { provider: "anthropic", defaultModel: "claude-haiku-4-5" },
  podeEditar: false,
};

function jev(ligado: boolean) {
  return {
    provedor: {
      rotulo: "Jev (TypeSafe AI)",
      quandoUsar: "Não conversa com o cliente.",
      ondePegarAChave: "https://console.typesafe.ai/keys",
      prefixoDaChave: "apikey_…",
    },
    chave: { existe: true, validada: true, credencial_id: "c1", rotulo: "Jev", erro_de_validacao: null },
    config: { ligado, modo: "observacao", aceite: ligado ? { em: "2026-09-20T00:00:00Z", por: "u1" } : null },
    tarefas: [{ id: "sentiment_classify", rotulo: "Medir o clima da conversa", oQueOJevFaz: "Percebe." }],
    tem_ia_de_sempre: true,
    numeros: {
      dias: 7,
      decisoes: 0,
      custo_cents: 0,
      latencia_media_ms: null,
      reservas: 0,
      observacao: { dias: 30, comparadas: 0, concordaram: 0 },
    },
    ultima_falha: null,
    pode_editar: false,
  };
}

let jevLigado = true;

beforeEach(() => {
  jevLigado = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const data = url === "/api/v1/ai/jev" ? jev(jevLigado) : PROVEDORES;
      return new Response(JSON.stringify({ data }), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function montar() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PainelDeProvedores />
    </QueryClientProvider>,
  );
}

describe("PainelDeProvedores — o Jev no painel", () => {
  it("o cartão do Jev vem logo abaixo do Modelo padrão", async () => {
    montar();
    const jevCartao = await screen.findByTestId("cartao-do-jev");
    const padrao = screen.getByTestId("cartao-do-padrao");
    expect(padrao.compareDocumentPosition(jevCartao) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("com o Jev ligado, o cartão do ponto diz quem decide", async () => {
    montar();
    await screen.findByTestId("cartao-do-jev");
    fireEvent.click(screen.getByTestId("avancado-entender"));
    expect(screen.getByTestId("jev-no-ponto-sentiment_classify")).toHaveTextContent(
      "O Jev observa; o modelo abaixo ainda decide.",
    );
  });

  it("com o Jev desligado, o cartão do ponto não fala dele", async () => {
    jevLigado = false;
    montar();
    await screen.findByTestId("cartao-do-jev");
    fireEvent.click(screen.getByTestId("avancado-entender"));
    expect(screen.getByTestId("ponto-sentiment_classify")).toBeInTheDocument();
    expect(screen.queryByTestId("jev-no-ponto-sentiment_classify")).toBeNull();
  });
});
