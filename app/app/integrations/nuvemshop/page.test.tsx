import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A TELA DA NUVEMSHOP DIZ ONDE OS PRODUTOS FICAM (#4357).
 *
 * O catálogo da Nuvemshop NÃO entra em CRM › Produtos: ele é indexado na base
 * de conhecimento do agente, na fonte "Catálogo de produtos"
 * (`workers/rag-indexer.ts:672`). CRM › Produtos lê `catalog_products`, que só
 * recebe cadastro manual ou planilha (`app/api/v1/products/route.ts:12-14`).
 *
 * A tela prometia "Sincroniza pedidos, produtos e clientes" e mandava a pessoa
 * procurar num lugar onde o produto nunca chega — ela concluiu que a
 * sincronização não funcionava. Este arquivo cobra a promessa CORRETA nos dois
 * idiomas servidos, e o controle positivo: organização que nunca conectou
 * Nuvemshop continua vendo a tela normal, sem o cartão do catálogo.
 */

const {
  loadAuthUserMock,
  resolveActiveOrgMock,
  createAdminClientMock,
  isConfiguredMock,
  maybeSingleMock,
} = vi.hoisted(() => ({
  loadAuthUserMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
  createAdminClientMock: vi.fn(),
  isConfiguredMock: vi.fn(),
  maybeSingleMock: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: loadAuthUserMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: createAdminClientMock }));
vi.mock("@/lib/nuvemshop/config", () => ({ isConfigured: isConfiguredMock }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={typeof href === "string" ? href : ""}>{children as never}</a>
  ),
}));
// O toast lê `useSearchParams`; o estado do catálogo tem teste próprio. Aqui o
// recorte é a promessa escrita na página.
vi.mock("./_components/StatusToast", () => ({ StatusToast: () => null }));
vi.mock("./_components/ConnectButton", () => ({
  ConnectButton: () => <button>conectar</button>,
  DisconnectButton: () => <button>desconectar</button>,
}));
vi.mock("./_components/EstadoDoCatalogo", () => ({
  EstadoDoCatalogo: () => <div data-testid="estado-catalogo" />,
}));

import NuvemshopIntegrationPage from "./page";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

const INTEGRACAO = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "healthy",
  scopes: ["read_products", "read_orders"],
  store_metadata: { store_id: "9001" },
  webhook_subscriptions: { product: { id: 1 }, order: { id: 2 } },
  last_sync_at: "2026-11-01T12:00:00.000Z",
};

function usuario(locale: string) {
  return { id: "u1", locale, is_platform_admin: false, support: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  isConfiguredMock.mockReturnValue(true);
  resolveActiveOrgMock.mockResolvedValue({ orgId: ORG_ID, role: "admin" });
  maybeSingleMock.mockResolvedValue({ data: INTEGRACAO });
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: maybeSingleMock,
  };
  createAdminClientMock.mockReturnValue({ from: () => builder });
});

describe("a promessa da tela aponta para o lugar certo", () => {
  it("em português: o catálogo vai para Agente de IA › Conhecimento, não para CRM › Produtos", async () => {
    loadAuthUserMock.mockResolvedValue(usuario("pt-BR"));

    const html = renderToStaticMarkup(await NuvemshopIntegrationPage());

    // O destino real, com o NOME da fonte que a pessoa vai encontrar na tela do acervo.
    expect(html).toContain("Agente de IA › Conhecimento");
    expect(html).toContain("Catálogo de produtos");
    // O link para onde o texto manda.
    expect(html).toContain('href="/app/ai/knowledge/sources"');
    // A promessa antiga não aparece mais: era ela que mandava procurar errado.
    expect(html).not.toContain("Sincroniza pedidos, produtos e clientes");
  });

  it("em espanhol: a mesma promessa, traduzida", async () => {
    loadAuthUserMock.mockResolvedValue(usuario("es"));

    const html = renderToStaticMarkup(await NuvemshopIntegrationPage());

    expect(html).toContain("Conocimiento");
    expect(html).not.toContain("Sincroniza pedidos, produtos e clientes");
  });

  it("controle positivo: organização que nunca conectou não ganha cartão de catálogo e a tela não quebra", async () => {
    loadAuthUserMock.mockResolvedValue(usuario("pt-BR"));
    maybeSingleMock.mockResolvedValue({ data: null });

    const html = renderToStaticMarkup(await NuvemshopIntegrationPage());

    expect(html).toContain("Conectar Nuvemshop");
    // A promessa corrigida continua visível antes de conectar — é ela que
    // explica para onde os produtos vão quando a loja for ligada.
    expect(html).toContain("Agente de IA › Conhecimento");
    // Sem integração não há fonte para mostrar; o cartão não é renderizado.
    expect(html).not.toContain('data-testid="estado-catalogo"');
  });
});
