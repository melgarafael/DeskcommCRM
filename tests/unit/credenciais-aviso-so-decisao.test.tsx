/**
 * O AVISO "FALTA A SUA IA PRINCIPAL" SÓ APARECE QUANDO FALTA MESMO.
 *
 * A chave do Jev sozinha não faz ninguém atender: ele decide, não conversa. A
 * tela de Credenciais avisa isso — mas olhava só as LINHAS de credencial. No
 * caso mais comum do kit a chave da IA principal está no `.env` da instalação
 * (`ANTHROPIC_API_KEY`, `AI_GATEWAY_API_KEY`…), que não é linha nenhuma: quem
 * atendia com ela e cadastrava a chave do Jev via um alerta âmbar dizendo que a
 * IA principal faltava, com ela funcionando.
 *
 * Pela PÁGINA, não só pelo componente: o defeito era a página não contar ao
 * componente o que o `.env` tem.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { CredentialRow } from "@/hooks/ai/useCredentials";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const ORG = "11111111-1111-4111-8111-111111111111";

const banco = vi.hoisted(() => ({
  linhas: [] as unknown[],
  settings: {} as Record<string, unknown>,
  /** A IA principal mede o clima? (a mesma pergunta do worker) */
  iaPrincipal: true,
}));
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/app/app/ai/credentials/_actions", () => ({ refreshCredentialsView: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({ id: "actor", idioma: "pt-BR" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, role: "admin" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const dados = tabela === "ai_provider_credentials_safe" ? banco.linhas : [];
      const chain: Record<string, unknown> = {
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
          Promise.resolve({ data: dados, error: null }).then(ok, erro),
        // O interruptor do Jev, para o "Usada em" da chave dele.
        maybeSingle: async () => ({
          data: tabela === "organizations" ? { settings: banco.settings } : null,
          error: null,
        }),
      };
      for (const m of ["select", "eq", "order", "in"]) chain[m] = () => chain;
      return chain;
    },
  }),
}));

vi.mock("@/lib/ai/gateway-binding", () => ({
  resolverModeloDoPonto: vi.fn(async () =>
    banco.iaPrincipal ? { model: {}, modelId: "anthropic/claude-haiku-4-5", origem: "padrao" } : null,
  ),
}));

import CredentialsPage from "@/app/app/ai/credentials/page";

function credencial(provider: CredentialRow["provider"], id: string): CredentialRow {
  const agora = new Date().toISOString();
  return {
    id,
    organization_id: ORG,
    provider,
    label: provider,
    api_key_last4: "c0de",
    validated_at: agora,
    validation_error: null,
    models_available: [],
    is_active: true,
    created_by: "actor",
    created_at: agora,
    updated_at: agora,
  };
}

const JEV = credencial("typesafe", "22222222-2222-4222-8222-222222222222");
const ANTHROPIC = credencial("anthropic", "33333333-3333-4333-8333-333333333333");

/** Todas as variáveis que `lerAmbiente` lê para IA — o `.env.local` não entra. */
function ambiente(preenchidas: string[]) {
  for (const nome of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY"]) {
    vi.stubEnv(nome, preenchidas.includes(nome) ? "chave-da-instalacao" : "");
  }
}

let qc: QueryClient;

async function abrir(linhas: CredentialRow[]) {
  banco.linhas = linhas;
  api.get.mockResolvedValue({ data: linhas });
  const pagina = await CredentialsPage();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <IdiomaProvider locale="pt-BR">
      <QueryClientProvider client={qc}>
        {pagina}
      </QueryClientProvider>
    </IdiomaProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  banco.settings = {};
  banco.iaPrincipal = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("tela de Credenciais — o aviso de que falta a IA principal", () => {
  it("só a chave do Jev e nenhuma IA na instalação: avisa", async () => {
    ambiente([]);
    await abrir([JEV]);
    expect(screen.getByTestId("aviso-so-decisao")).toHaveTextContent(/falta a chave da sua IA principal/);
    // Controle positivo: a chave do Jev está na lista (não sumiu no agrupamento).
    expect(screen.getByText("Jev (TypeSafe AI)")).toBeInTheDocument();
  });

  it.each([["ANTHROPIC_API_KEY"], ["OPENAI_API_KEY"], ["OPENROUTER_API_KEY"], ["AI_GATEWAY_API_KEY"]])(
    "só a chave do Jev, mas a instalação trouxe %s: não avisa",
    async (variavel) => {
      ambiente([variavel]);
      await abrir([JEV]);
      expect(screen.getByText("Jev (TypeSafe AI)")).toBeInTheDocument();
      expect(screen.queryByTestId("aviso-so-decisao")).toBeNull();
    },
  );

  it("a chave de conversa RECUSADA não conta como IA principal", async () => {
    ambiente([]);
    await abrir([JEV, { ...ANTHROPIC, validated_at: null, validation_error: "auth_failed_401" }]);
    expect(screen.getByTestId("aviso-so-decisao")).toBeInTheDocument();
  });

  it("chave do Jev e chave de IA de conversa cadastrada: não avisa", async () => {
    ambiente([]);
    await abrir([JEV, ANTHROPIC]);
    expect(screen.queryByTestId("aviso-so-decisao")).toBeNull();
  });
});

describe("tela de Credenciais — onde a chave do Jev trabalha", () => {
  const ACEITE = { em: "2026-09-01T12:00:00.000Z", por: "44444444-4444-4444-8444-444444444444" };

  it("Jev ligado: a chave que ele usa diz \"Usada em\" com a tarefa dele", async () => {
    ambiente([]);
    banco.settings = { jev: { ligado: true, modo: "observacao", aceite: ACEITE } };
    await abrir([JEV, ANTHROPIC]);
    expect(screen.getByTestId("credencial-usada-em")).toHaveTextContent("Usada em: Medir o clima da conversa");
    // Só na chave do Jev: a de conversa não ganha a linha.
    expect(screen.getAllByTestId("credencial-usada-em")).toHaveLength(1);
  });

  it("chave trocada: a linha volta sozinha quando a lista relida traz a chave validada", async () => {
    // A tela se relê logo depois de salvar a chave nova, quando ela ainda não
    // passou no teste (`validated_at` nulo). Enquanto o "Usada em" vinha dessa
    // foto, a linha sumia e só voltava recarregando a página — medido em campo.
    ambiente([]);
    banco.settings = { jev: { ligado: true, modo: "decide", aceite: ACEITE } };
    await abrir([{ ...JEV, validated_at: null }, ANTHROPIC]);
    expect(screen.queryByTestId("credencial-usada-em"), "chave em teste não sai para a rede").toBeNull();

    // A lista relida (o que o diálogo pede 3 s depois) já traz a chave validada.
    api.get.mockResolvedValue({ data: [JEV, ANTHROPIC] });
    await qc.invalidateQueries();
    expect(await screen.findByTestId("credencial-usada-em")).toHaveTextContent(
      "Usada em: Medir o clima da conversa",
    );
  });

  it("Jev desligado: a chave dele não trabalha em nada", async () => {
    ambiente([]);
    banco.settings = { jev: { ligado: false, modo: "observacao", aceite: ACEITE } };
    await abrir([JEV, ANTHROPIC]);
    expect(screen.queryByTestId("credencial-usada-em")).toBeNull();
  });
});

describe("tela de Credenciais — o que excluir a chave do Jev faz", () => {
  const ACEITE = { em: "2026-09-01T12:00:00.000Z", por: "44444444-4444-4444-8444-444444444444" };

  /** Abre o diálogo de exclusão do cartão que diz "Usada em" — o da chave em uso. */
  function excluirAChaveEmUso(): HTMLElement {
    const cartao = screen.getByTestId("credencial-usada-em").parentElement as HTMLElement;
    fireEvent.click(within(cartao).getByRole("button", { name: "Excluir credencial" }));
    return screen.getByRole("alertdialog");
  }

  beforeEach(() => {
    ambiente([]);
    banco.settings = { jev: { ligado: true, modo: "decide", aceite: ACEITE } };
  });

  it("com a IA principal medindo: ela volta a medir sozinha", async () => {
    await abrir([JEV, ANTHROPIC]);
    expect(excluirAChaveEmUso()).toHaveTextContent(/volta a ser medido só pela sua IA principal/);
  });

  it("sem IA principal: o diálogo diz que o clima para de ser medido", async () => {
    banco.iaPrincipal = false;
    await abrir([JEV]);
    const dialogo = excluirAChaveEmUso();
    expect(dialogo).toHaveTextContent(/deixa de ser medido/);
    expect(dialogo).not.toHaveTextContent(/volta a ser medido/);
  });

  it("sobrando outra chave do Jev que passou no teste: não diz que o Jev desliga", async () => {
    const maisNova = { ...JEV, id: "55555555-5555-4555-8555-555555555555", created_at: "2099-01-01T00:00:00.000Z" };
    await abrir([JEV, maisNova, ANTHROPIC]);
    const dialogo = excluirAChaveEmUso();
    expect(dialogo).toHaveTextContent(/passa a usar a outra chave/);
    expect(dialogo).not.toHaveTextContent(/é desligado/);
  });

  it("a chave do Jev não mostra 'Em uso por 0' ao lado do 'Usada em'", async () => {
    await abrir([JEV]);
    const cartao = screen.getByTestId("credencial-usada-em").parentElement as HTMLElement;
    expect(cartao).not.toHaveTextContent(/Em uso por/);
  });
});
