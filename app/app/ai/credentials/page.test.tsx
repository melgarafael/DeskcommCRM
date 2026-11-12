/**
 * #4438 — com o recurso `login_codex` DESLIGADO, a tela de Credenciais não
 * dizia nada sobre a assinatura do ChatGPT: quem procurava concluía que o
 * produto não tem o recurso. O conserto é o aviso honesto — o que a assinatura
 * faz, que vem desligada de fábrica, onde se liga e que quem não é admin pede a
 * quem administra.
 *
 * ─── Os dois mundos, e por que a tela inteira ─────────────────────────────
 *
 * A decisão do #1672 continua valendo: desligado, o PAINEL não aparece. O que
 * este teste mede é o que a pessoa VÊ em cada mundo — aviso sem painel com o
 * recurso desligado; painel sem aviso com o recurso ligado (o controle
 * positivo: o conserto não pode vazar para quem já usa o recurso).
 *
 * ─── Os dublês ────────────────────────────────────────────────────────────
 *
 * A tela é um `page.tsx` de servidor: os dublês são os mesmos dos testes
 * vizinhos de página (`app/app/ai/routers/page.test.tsx`) — autenticação,
 * clientes do Supabase e os módulos que falam com banco ou assinam estado. Os
 * componentes de cliente (painel e lista) saem do caminho: o que se mede aqui é
 * o que o servidor renderiza.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const {
  requireAuthMock,
  resolveActiveOrgMock,
  createClientMock,
  moduloLigadoMock,
  criarSessaoPkceMock,
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
  createClientMock: vi.fn(),
  moduloLigadoMock: vi.fn(),
  criarSessaoPkceMock: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: moduloLigadoMock }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: async () => null }));
vi.mock("@/lib/ai/pontos/pkce-da-assinatura", () => ({
  criarSessaoPkce: criarSessaoPkceMock,
  gerarNonceSiwc: () => "nonce-de-teste",
  CLIENTE_DINAMICO_SIWC: "cliente-dinamico",
}));
vi.mock("@/lib/ai/credenciais/login-codex", () => ({ lerLoginCodex: async () => null }));
vi.mock("@/lib/ai/credenciais/host-siwc", () => ({ lerOuCriarHostIdSiwc: async () => "host-1" }));
vi.mock("@/lib/agenda/google/estado", () => ({ emitirEstado: () => "estado-assinado" }));
vi.mock("./_components/CredentialsList", () => ({ CredentialsList: () => null }));
vi.mock("./_components/PainelDeLoginCodex", () => ({
  PainelDeLoginCodex: () => <div data-testid="painel-login-codex" />,
}));

import CredentialsPage from "./page";

const ORG = "33333333-3333-4333-8333-333333333333";

/** O mínimo da cadeia do Supabase que esta tela percorre (select/eq/order/…). */
function clienteDeTeste(tabelas: Record<string, unknown>) {
  const cadeia = (tabela: string) => {
    const alvo = tabelas[tabela] ?? [];
    const mesmo = () => objeto;
    const objeto = {
      select: mesmo,
      eq: mesmo,
      is: mesmo,
      limit: mesmo,
      order: async () => ({ data: alvo, error: null }),
      in: async () => ({ data: alvo, error: null }),
      maybeSingle: async () => ({ data: alvo, error: null }),
    };
    return objeto;
  };
  return { from: (tabela: string) => cadeia(tabela) };
}

function preparar({ ligado }: { ligado: boolean }) {
  requireAuthMock.mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: false,
  });
  resolveActiveOrgMock.mockResolvedValue({ orgId: ORG, role: "admin" });
  moduloLigadoMock.mockResolvedValue(ligado);
  criarSessaoPkceMock.mockReturnValue({ url: "https://exemplo.invalid/auth", codeVerifier: "verifier" });
  createClientMock.mockReturnValue(
    clienteDeTeste({ organizations: { settings: {} } }),
  );
}

describe("#4438 IA › Credenciais — a tela diz que a assinatura do ChatGPT existe", () => {
  it("com o recurso DESLIGADO, mostra o aviso: o que é, que vem desligado, onde liga e a quem pedir", async () => {
    preparar({ ligado: false });

    render(await CredentialsPage());

    const aviso = screen.getByTestId("aviso-login-codex-desligado");
    // (a) o que a assinatura faz.
    expect(aviso, "o aviso não diz o que a assinatura do ChatGPT faz").toHaveTextContent(
      /assinatura do ChatGPT/i,
    );
    expect(aviso).toHaveTextContent(/conta do ChatGPT/i);
    // (b) que vem desligada de fábrica.
    expect(aviso, "o aviso não diz que o recurso vem desligado de fábrica").toHaveTextContent(
      /desligad/i,
    );
    expect(aviso).toHaveTextContent(/fábrica/i);
    // (c) onde se liga.
    expect(aviso, "o aviso não diz onde o recurso se liga").toHaveTextContent(/Recursos opcionais/i);
    expect(aviso).toHaveTextContent("/admin/sistema");
    // (d) quem não é admin pede a quem administra.
    expect(aviso, "o aviso não diz a quem pedir").toHaveTextContent(/peça/i);
    // E o painel continua fora: desligado, ninguém conecta nada (#1672).
    expect(screen.queryByTestId("painel-login-codex")).toBeNull();
  });

  it("com o recurso LIGADO, a tela fica como está: painel presente e nenhum aviso", async () => {
    preparar({ ligado: true });

    render(await CredentialsPage());

    expect(screen.getByTestId("painel-login-codex")).toBeInTheDocument();
    expect(
      screen.queryByTestId("aviso-login-codex-desligado"),
      "o aviso apareceu com o recurso LIGADO — quem já usa o recurso veria um aviso de recurso desligado",
    ).toBeNull();
  });
});
