import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Hub from "@/lib/cobranca/hub";

const cena = vi.hoisted(() => ({
  B: "00000000-0000-4000-8000-00000000000b",
  C: "00000000-0000-4000-8000-00000000000c",
  D: "00000000-0000-4000-8000-00000000000d",
  papel: "admin" as "admin" | "agent",
  status: {} as Record<string, string>,
  statusNaSessao: undefined as string | undefined,
  falhaNaLeitura: false,
  suporte: "suporte@revenda.test",
  platformAdmin: false,
  modoSuporte: null as { reason: string } | null,
  semOrgAtiva: false,
  cobranca: false,
  inicial: true,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    email: "admin@empresa.test",
    is_platform_admin: cena.platformAdmin,
    support: cena.modoSuporte,
    idioma: "pt-BR",
    organizations: [
      { organization_id: cena.B, organization_name: "Empresa B", role: cena.papel },
      { organization_id: cena.C, organization_name: "Empresa C", role: "admin" },
      { organization_id: cena.D, organization_name: "Empresa D", role: "admin" },
    ],
  }),
  // A régua da SESSÃO (o embed de `loadAuthUser`), que é a do `resolveActiveOrg`
  // do layout; `statusNaSessao` só difere do banco no caso da divergência.
  orgAtivaSemPortao: async () => cena.semOrgAtiva ? null : ({
    orgId: cena.B, name: "Empresa B", role: cena.papel,
    org_status: cena.statusNaSessao ?? cena.status[cena.B],
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => tabela === "cobranca_assinaturas" ? ({
      select: () => ({ eq: (_coluna: string, id: string) => ({ maybeSingle: async () => {
        expect(id).toBe(cena.B);
        return { data: { estado: "inadimplente", pagamento_inicial_pendente: cena.inicial, periodo_pago_desde: cena.inicial ? null : "2026-01-01T00:00:00Z" }, error: null };
      } }) }),
    }) : ({
      select: () => ({
        in: async (_coluna: string, ids: string[]) =>
          cena.falhaNaLeitura
            ? { data: null, error: { message: "rede" } }
            : { data: ids.map((id) => ({ id, status: cena.status[id] ?? "active", suspended_kind: cena.cobranca ? "cobranca" : null })), error: null },
      }),
    }),
  }),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => cena.cobranca }));
vi.mock("@/lib/cobranca/hub", async (original) => ({
  ...await original<typeof Hub>(),
  lerPainelDoHub: async () => null,
}));
vi.mock("@/lib/branding/saida", () => ({ emailDeSuporte: async () => cena.suporte }));
vi.mock("@/app/actions/auth/signOut", () => ({ signOut: vi.fn() }));
vi.mock("@/app/app/lgpd/requests/RequestsTable", () => ({
  RequestsTable: ({ baseDoPedido }: { baseDoPedido?: string }) => <p data-testid="lgpd-lista">{baseDoPedido}</p>,
}));
vi.mock("@/app/app/lgpd/requests/[id]/_client", () => ({
  LgpdRequestDetail: ({ id, hrefDaLista }: { id: string; hrefDaLista?: string }) => (
    <p data-testid="lgpd-pedido">{`${id} ${hrefDaLista}`}</p>
  ),
}));
vi.mock("@/app/onboarding/_components/OutrasOrganizacoes", () => ({
  OutrasOrganizacoes: ({ outras }: { outras: Array<{ id: string; nome: string }> }) => (
    <p data-testid="outras">{outras.map((o) => o.nome).join(",")}</p>
  ),
}));

import AccountSuspendedPage from "./page";

async function montar(pedido?: string) {
  return render(await AccountSuspendedPage({ searchParams: Promise.resolve(pedido ? { pedido } : {}) }));
}

beforeEach(() => {
  cena.papel = "admin";
  cena.status = { [cena.B]: "suspended", [cena.C]: "active", [cena.D]: "suspended" };
  cena.statusNaSessao = undefined;
  cena.falhaNaLeitura = false;
  cena.suporte = "suporte@revenda.test";
  cena.platformAdmin = false;
  cena.modoSuporte = null;
  cena.semOrgAtiva = false;
  cena.cobranca = false;
  cena.inicial = true;
});

describe("/account-suspended: o hub de quem está numa empresa suspensa", () => {
  it("primeiro pagamento leva o administrador à continuação sem terceiro Assinar", async () => {
    cena.cobranca = true;
    await expect(montar()).rejects.toThrow("NEXT_REDIRECT:/cobranca/contratar");
  });

  it("o retorno do provedor segue para conferir, sem reiniciar checkout automaticamente", async () => {
    cena.cobranca = true;
    await expect(AccountSuspendedPage({ searchParams: Promise.resolve({ voltou: "1" }) }))
      .rejects.toThrow("NEXT_REDIRECT:/cobranca/contratar?voltou=1&retomar=1");
  });

  it("primeiro pagamento mantém o pedido LGPD solicitado no próprio hub", async () => {
    cena.cobranca = true;
    await montar("22222222-2222-4222-8222-222222222222");
    expect(screen.getByRole("heading", { name: "Aguardando primeiro pagamento" })).toBeVisible();
    expect(screen.getByTestId("lgpd-pedido")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Assinar" })).toBeNull();
  });

  it("ajuda fica acessível sem laço para pagamento", async () => {
    cena.cobranca = true;
    render(await AccountSuspendedPage({ searchParams: Promise.resolve({ ajuda: "1" }) }));
    expect(screen.getByTestId("lgpd-lista")).toBeVisible();
    expect(screen.getByRole("link", { name: "Continuar para pagamento" })).toHaveAttribute("href", "/cobranca/contratar");
  });

  it.each(["agent", "suporte"])("%s não é enviado a uma ação financeira automática", async (papel) => {
    cena.cobranca = true;
    if (papel === "agent") cena.papel = "agent";
    else cena.modoSuporte = { reason: "acompanhamento" };
    await montar();
    expect(screen.getByRole("heading", { name: "Aguardando primeiro pagamento" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Continuar para pagamento" })).toBeNull();
  });

  it("dívida depois de um período pago conserva o hub de suspensão", async () => {
    cena.cobranca = true;
    cena.inicial = false;
    await montar();
    expect(screen.getByRole("heading", { name: "Conta suspensa" })).toBeVisible();
  });

  it("diz QUAL empresa está suspensa — quem participa de várias não fica na dúvida", async () => {
    await montar();
    const titulo = screen.getByRole("heading", { level: 1, name: "Conta suspensa" });
    expect(titulo.nextElementSibling).toHaveTextContent("Empresa B");
    expect(screen.getByTestId("outras")).not.toHaveTextContent("Empresa B");
  });

  it("empresa que opera não fica presa aqui: volta para /app", async () => {
    cena.status[cena.B] = "active";
    await expect(montar()).rejects.toThrow("NEXT_REDIRECT:/app");
  });

  // Acabamento 7: o e-mail de prazo mandado com a empresa parada aponta para
  // cá; se ela voltou a operar antes do clique, o pedido não pode se perder.
  it("empresa que opera com ?pedido= volta direto ao pedido, não à home", async () => {
    cena.status[cena.B] = "active";
    const id = "22222222-2222-4222-8222-222222222222";
    await expect(montar(id)).rejects.toThrow(`NEXT_REDIRECT:/app/lgpd/requests/${id}`);
  });

  it("empresa que opera com ?pedido= que não é uuid volta para /app", async () => {
    cena.status[cena.B] = "active";
    await expect(montar("../admin")).rejects.toThrow(/^NEXT_REDIRECT:\/app$/);
  });

  // Review Focus 2: o layout de /app manda para cá se QUALQUER das duas réguas
  // (sessão ou leitura do banco) diz parada; o hub só devolve para /app quando
  // AS DUAS dizem que opera. Sem isso, a divergência vira laço de 307.
  it.each([
    ["sessão diz parada, banco diz ativa", "suspended", "active"],
    ["sessão diz ativa, banco diz parada", "active", "suspended"],
  ])("%s → renderiza o hub, sem redirect", async (_nome, naSessao, noBanco) => {
    cena.statusNaSessao = naSessao;
    cena.status[cena.B] = noBanco;
    await montar();
    expect(screen.getByRole("heading", { name: "Conta suspensa" })).toBeVisible();
  });

  it("admin vê o suporte, a LGPD abrindo no próprio hub e só as empresas que operam", async () => {
    await montar();
    expect(screen.getByRole("heading", { name: "Conta suspensa" })).toBeVisible();
    expect(screen.getByRole("link", { name: "suporte@revenda.test" })).toHaveAttribute("href", "mailto:suporte@revenda.test");
    expect(screen.getByTestId("lgpd-lista")).toHaveTextContent("/account-suspended?pedido=");
    expect(screen.getByTestId("outras")).toHaveTextContent(/^Empresa C$/);
  });

  it("sem SUPPORT_EMAIL, quem administra é mandado a quem administra o sistema, sem link, e a LGPD segue", async () => {
    cena.suporte = "";
    await montar();
    expect(
      screen.getByText("Sua conta está suspensa. Fale com quem administra este sistema para saber o motivo e como reativá-la."),
    ).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("lgpd-lista")).toBeVisible();
  });

  it("dono da plataforma com papel de atendente vê o painel de admin", async () => {
    cena.papel = "agent";
    cena.platformAdmin = true;
    await montar();
    expect(screen.getByTestId("lgpd-lista")).toBeVisible();
    expect(screen.getByRole("link", { name: "suporte@revenda.test" })).toBeVisible();
  });

  it("dono da plataforma em modo suporte, com papel de atendente, não administra", async () => {
    cena.papel = "agent";
    cena.platformAdmin = true;
    cena.modoSuporte = { reason: "acompanhamento" };
    await montar();
    expect(screen.getByText("Sua conta está suspensa. Avise o administrador da sua empresa.")).toBeVisible();
    expect(screen.queryByTestId("lgpd-lista")).toBeNull();
  });

  it("sem empresa ativa não há o que mostrar: vai para /app", async () => {
    cena.semOrgAtiva = true;
    await expect(montar()).rejects.toThrow(/^NEXT_REDIRECT:\/app$/);
  });

  it("quem não administra é mandado ao administrador, sem LGPD e sem o endereço do suporte", async () => {
    cena.papel = "agent";
    await montar();
    expect(screen.getByText("Sua conta está suspensa. Avise o administrador da sua empresa.")).toBeVisible();
    expect(screen.queryByTestId("lgpd-lista")).toBeNull();
    expect(screen.queryByRole("link", { name: "suporte@revenda.test" })).toBeNull();
  });

  it("?pedido= com uuid abre o detalhe no hub", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await montar(id);
    expect(screen.getByTestId("lgpd-pedido")).toHaveTextContent(`${id} /account-suspended`);
  });

  it("?pedido= que não é uuid cai na lista", async () => {
    await montar("../app/inbox");
    expect(screen.getByTestId("lgpd-lista")).toBeVisible();
    expect(screen.queryByTestId("lgpd-pedido")).toBeNull();
  });

  it("'Sair' encerra a sessão: é um botão de envio dentro de um form, não um link para /login", async () => {
    await montar();
    const sair = screen.getByRole("button", { name: "Sair" });
    expect(sair).toHaveAttribute("type", "submit");
    expect(sair.closest("form")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Sair" })).toBeNull();
  });

  it("leitura do estado que falha LANÇA: nem hub nem redirect por palpite", async () => {
    cena.falhaNaLeitura = true;
    await expect(montar()).rejects.toThrow(/account_suspended_status_indisponivel/);
  });
});
