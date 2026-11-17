/**
 * A CLASSE DE SEÇÃO NO CONTEÚDO DAS TELAS (#4705).
 *
 * O defeito medido: `app/app/_components/AppShell.tsx` renderizava o conteúdo num
 * `<main className="flex-1 overflow-auto p-4 …">` sem identidade — o `#4463` deu
 * classes ao MENU (`nav-grupo-<id>`, `nav-item-<destino>`) e a cor parava ali.
 * Nenhum elemento fora do `<aside>` dizia em que seção a pessoa estava, e o
 * validador de `/admin/marca` recusa atributo e `:has()`, então a folha do
 * cliente não tinha como deduzir a seção.
 *
 * Estes quatro casos são a régua: a casca publica `tela-secao` e a seção da rota,
 * a classe acompanha a navegação, o validador conhece a família (e recusa o
 * nome que não existe), e o menu continua exatamente com as classes de antes.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { AppShell } from "@/app/app/_components/AppShell";
import { Sidebar } from "@/components/shell/Sidebar";
import { validarCssPersonalizado } from "@/lib/branding/css-personalizado";
import { GRUPO_NO_RODAPE, NAV_GROUPS } from "@/lib/navigation/catalogo";
import { classeDaSecao, classeDoGrupo, classeDoItem } from "@/lib/navigation/classes-estaveis";
import { CLASSES_DE_SECAO, CLASSES_DE_SECAO_CONHECIDAS } from "@/lib/navigation/secoes-da-tela";
import { ProvedorDaOcupacaoDoRodape } from "@/lib/ui/rodape-ocupado";

/** A rota que a casca "vê" agora — trocada no caso (b), sem remontar a árvore. */
const rota = vi.hoisted(() => ({ caminho: "/app/inbox" }));

vi.mock("next/navigation", () => ({
  usePathname: () => rota.caminho,
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/components/shell/BarraDeProgressoNavegacao", () => ({
  BarraDeProgressoNavegacao: () => null,
}));
vi.mock("@/components/shell/BarraInferior", () => ({ BarraInferior: () => null }));
vi.mock("@/hooks/atendimento/useSinalDePresenca", () => ({ useSinalDePresenca: () => {} }));
vi.mock("@/hooks/notifications/useInboundMessageAlerts", () => ({
  useInboundMessageAlerts: () => {},
}));
vi.mock("@/hooks/notifications/useCrmAlerts", () => ({ useCrmAlerts: () => {} }));
vi.mock("@/hooks/calls/useInboundCallAlerts", () => ({ useInboundCallAlerts: () => {} }));
vi.mock("@/lib/notifications/notify_open", () => ({ useNotifyOpenFromServiceWorker: () => {} }));
vi.mock("@/lib/notifications/service_worker", () => ({
  ensureNotifyServiceWorker: () => Promise.resolve(null),
}));

// O menu é renderizado de verdade no caso (d): o controle só vale no DOM dele.
const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: null,
};
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => authRef,
  usePermission: () => false,
}));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/components/shell/ContadorDeCasos", () => ({ ContadorDeCasos: () => null }));
vi.mock("@/components/shell/ContadorDaFila", () => ({ ContadorDaFila: () => null }));
vi.mock("@/components/shell/ContadorDeTarefas", () => ({ ContadorDeTarefas: () => null }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));

function renderCasca() {
  return render(
    <ProvedorDaOcupacaoDoRodape>
      <AppShell sidebarCollapsed={false} podeAtender={false}>
        <p>conteúdo</p>
      </AppShell>
    </ProvedorDaOcupacaoDoRodape>,
  );
}

function main(container: HTMLElement): HTMLElement {
  const elemento = container.querySelector("main");
  if (!elemento) throw new Error("esperava o <main> da casca");
  return elemento;
}

function comoAdmin() {
  authRef.user = { is_platform_admin: false };
  authRef.activeOrg = { orgId: "org-1", name: "Org", role: "admin" };
}

afterEach(() => {
  rota.caminho = "/app/inbox";
  cleanup();
});

beforeEach(() => {
  comoAdmin();
});

describe("o conteúdo diz em que seção a pessoa está", () => {
  it("(a) o <main> recebe a classe da seção em duas rotas diferentes", () => {
    rota.caminho = "/app/inbox";
    const primeira = renderCasca();
    expect(main(primeira.container).className).toContain("tela-secao");
    expect(main(primeira.container).className).toContain(CLASSES_DE_SECAO.atendimento);
    cleanup();

    rota.caminho = "/app/kanban";
    const segunda = renderCasca();
    expect(main(segunda.container).className).toContain(CLASSES_DE_SECAO.crm);
    // Uma sub-rota do MESMO destino também é da seção dele.
    expect(classeDaSecao("/app/ai/cases")).toBe(CLASSES_DE_SECAO.ia);
    expect(classeDaSecao("/app/settings/tenant/agenda")).toBe(CLASSES_DE_SECAO.organizacao);
    // Os hubs dos grupos e as subtelas fora do catálogo: o menu os pinta como do grupo.
    expect(classeDaSecao("/app/settings/profile")).toBe(CLASSES_DE_SECAO.organizacao);
    expect(classeDaSecao("/app/crm")).toBe(CLASSES_DE_SECAO.crm);
    expect(classeDaSecao("/app/ai")).toBe(CLASSES_DE_SECAO.ia);
    expect(classeDaSecao("/app/analise")).toBe(CLASSES_DE_SECAO.analise);
    expect(classeDaSecao("/app/settings")).toBe(CLASSES_DE_SECAO.organizacao);
    // Subtela de Configurações que não está no catálogo: cai no hub `/app/settings`.
    expect(classeDaSecao("/app/settings/atualizacao")).toBe(CLASSES_DE_SECAO.organizacao);
  });

  it("(b) a classe muda quando a rota muda, e a anterior sai do <main>", () => {
    rota.caminho = "/app/inbox";
    const { container, rerender } = renderCasca();
    expect(main(container).className).toContain("tela-secao-atendimento");

    rota.caminho = "/app/metrics";
    rerender(
      <ProvedorDaOcupacaoDoRodape>
        <AppShell sidebarCollapsed={false} podeAtender={false}>
          <p>conteúdo</p>
        </AppShell>
      </ProvedorDaOcupacaoDoRodape>,
    );
    expect(main(container).className).toContain("tela-secao-analise");
    expect(main(container).className).not.toContain("tela-secao-atendimento");

    // Rota fora do registro: só a classe comum, como a issue define.
    rota.caminho = "/app/onboarding";
    rerender(
      <ProvedorDaOcupacaoDoRodape>
        <AppShell sidebarCollapsed={false} podeAtender={false}>
          <p>conteúdo</p>
        </AppShell>
      </ProvedorDaOcupacaoDoRodape>,
    );
    expect(main(container).className).toContain("tela-secao");
    expect(
      CLASSES_DE_SECAO_CONHECIDAS.filter((classe) => classe !== "tela-secao").some((classe) =>
        main(container).className.includes(classe),
      ),
    ).toBe(false);
  });

  it("(c) o validador aceita a classe de seção e recusa a que não existe", () => {
    const aceita = validarCssPersonalizado(
      ".tela-secao-crm .rounded-lg { border-top-color: #1d4ed8; }",
    );
    expect(aceita.erro).toBeNull();
    expect(aceita.css).toContain(":root:root .tela-secao-crm .rounded-lg");

    // Controle negativo: a família é fechada, e o erro ENSINA o que existe.
    const inventada = validarCssPersonalizado(".tela-secao-inventada { color: #1d4ed8; }");
    expect(inventada.erro).not.toBeNull();
    expect(inventada.css).toBeNull();
    expect(inventada.erro).toContain("tela-secao-inventada");
    for (const conhecida of CLASSES_DE_SECAO_CONHECIDAS) {
      expect(inventada.erro).toContain(`.${conhecida}`);
    }

    // A classe comum e a do menu continuam aceitas — o validador só passou a
    // conhecer a família `tela-secao-*`; o resto do catálogo de classes do app
    // (`.card`, utilitárias) segue como sempre foi.
    expect(
      validarCssPersonalizado(".tela-secao .card { background-color: #10261a; }").erro,
    ).toBeNull();
    expect(
      validarCssPersonalizado(".nav-grupo-crm .rounded-md:hover { color: #52645a; }").erro,
    ).toBeNull();
    expect(validarCssPersonalizado(".tela-inbox { color: #1d4ed8; }").erro).toBeNull();
  });

  it("(d) o menu continua com as MESMAS classes de antes", () => {
    comoAdmin();
    rota.caminho = "/app/kanban";
    render(<Sidebar collapsed={false} />);

    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    for (const grupo of NAV_GROUPS) {
      if (grupo.id === GRUPO_NO_RODAPE) continue;
      expect(nav.querySelector(`.${classeDoGrupo(grupo.id)}`), grupo.id).not.toBeNull();
    }
    expect(nav.querySelector(".nav-grupo-crm")).not.toBeNull();
    const funis = screen.getByRole("link", { name: "Funis" });
    expect(funis.className).toContain(classeDoItem("/app/kanban"));
    expect(funis.className).not.toContain("tela-secao");
    // A classe nova é do CONTEÚDO: ela não vaza para dentro do menu.
    expect(nav.querySelector(".tela-secao")).toBeNull();
  });
});
