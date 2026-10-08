/**
 * A BARRA DE ABAS DO CELULAR — a regra, não o pixel.
 *
 * jsdom não faz layout: ele não sabe que a tela tem 360px nem onde a barra
 * desenha. Então aqui se prova o que decide o comportamento — qual classe
 * esconde acima de `md`, quantas vagas existem, e de onde saem as abas — e a
 * prova de geometria fica com `tests/e2e/celular-cabe-na-tela.spec.ts`, que mede
 * por `getBoundingClientRect` num browser de verdade. É o mesmo arranjo de
 * `components/shell/TenantSwitcher.celular.test.tsx`.
 *
 * O caso que mais importa é o terceiro: a barra NÃO pode ter régua própria de
 * permissão. Ela projeta `sidebarGroups()` — a mesma função do sidebar e da
 * gaveta —, e por isso `sidebarGroups` entra aqui DE VERDADE, sem mock. Mockar
 * a projeção deixaria o caso verde provando a minha fiação e não a herança.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const estado = {
  role: "admin" as string | null,
  caminho: "/app/inbox",
};

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { is_platform_admin: false, support: null },
    activeOrg: {
      orgId: "org-1",
      role: estado.role,
      interface_settings: undefined,
      modulos_ligados: [],
      capacidades_ligadas: [],
    },
  }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ usePathname: () => estado.caminho }));
// Os contadores leem React Query; a presença deles tem teste próprio. Aqui
// interessa que a barra os POSICIONE, então viram marcas visíveis.
vi.mock("@/components/shell/ContadorDaFila", () => ({
  ContadorDaFila: ({ compacto }: { compacto: boolean }) => (
    <span data-testid="contador-fila" data-compacto={String(compacto)} />
  ),
}));
vi.mock("@/components/shell/ContadorDeCasos", () => ({
  ContadorDeCasos: () => <span data-testid="contador-casos" />,
}));
// A gaveta arrasta o `SidebarContent` inteiro atrás de si. O que se prova dela
// aqui é que a quinta vaga existe e pede a aparência de aba.
vi.mock("@/components/shell/MobileSidebar", () => ({
  GavetaDeNavegacao: ({ comoAba }: { comoAba?: boolean }) => (
    <button type="button" data-testid="mais" data-como-aba={String(!!comoAba)}>
      Mais
    </button>
  ),
}));

import { BARRA_INFERIOR, BarraInferior } from "./BarraInferior";

function montar() {
  return render(<BarraInferior />);
}

describe("a barra de abas do celular", () => {
  it("existe só abaixo de `md` — acima dela quem navega é a barra lateral", () => {
    estado.role = "admin";
    montar();
    const barra = screen.getByRole("navigation", { name: "Navegação rápida" });
    // `md:hidden` é o MESMO corte do `hidden md:block` da barra lateral no
    // `AppShell`. Se os dois divergirem, existe uma largura com duas navegações
    // na tela ou com nenhuma.
    expect(barra.className).toContain("md:hidden");
  });

  it("cabem quatro abas mais o `Mais`, e não mais que isso", () => {
    estado.role = "admin";
    montar();
    // Cinco vagas: quatro destinos e a gaveta. Numa tela de 360px cada vaga tem
    // ~72px — a sexta aba não teria onde escrever o rótulo.
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByTestId("mais").getAttribute("data-como-aba")).toBe("true");
  });

  it("a aba da conversa continua acesa dentro de `/app/inbox/[id]`", () => {
    estado.role = "admin";
    estado.caminho = "/app/inbox/abc-123";
    montar();
    const inbox = screen.getByRole("link", { name: /Inbox/ });
    // Igualdade de caminho apagaria a barra inteira justamente na tela de
    // conversa, que é onde se passa mais tempo no celular.
    expect(inbox.getAttribute("aria-current")).toBe("page");
    estado.caminho = "/app/inbox";
  });

  it("o contador do Inbox é um PONTO, não um número ao lado do rótulo", () => {
    estado.role = "admin";
    montar();
    // `compacto` é o que troca o número por um ponto de 8px. Numa aba de ~72px o
    // número não caberia junto do texto.
    expect(screen.getByTestId("contador-fila").getAttribute("data-compacto")).toBe("true");
  });

  it("declara a ocupação do rodapé encostada na borda, e não um `bottom` próprio", () => {
    // `distancia: 0` é o que faz dela barra de abas e não painel flutuante; e o
    // número vem do contrato (`lib/ui/rodape-ocupado.tsx`), que é quem a casca
    // desconta. Duas medidas para a mesma faixa foi o defeito da #1305.
    expect(BARRA_INFERIOR.distancia).toBe(0);
    expect(BARRA_INFERIOR.dono).toBe("components/shell/BarraInferior.tsx");
    montar();
    const barra = screen.getByRole("navigation", { name: "Navegação rápida" });
    expect(barra.style.bottom).toBe("0px");
  });

  it("NÃO declara piso de altura — senão o desktop reserva rodapé para uma barra invisível", () => {
    // O contrato normalmente pede um piso em `altura`, para a reserva valer antes
    // de o navegador medir. Aqui piso é defeito: quem esconde esta barra acima de
    // `md` é CSS, então no laptop ela está no DOM com `display: none`. Como
    // `ocupacaoDaPeca` é `distancia + max(altura, medida)`, um piso de 56 faria o
    // `<main>` do desktop — e o Inbox e o quadro do funil, que leem a mesma
    // variável — perderem 56px por uma barra que não está na tela.
    //
    // Com zero, quem decide é a medição, e `getBoundingClientRect()` devolve 0
    // para elemento escondido. Este caso existe para que "otimizar" o piso de
    // volta reprove.
    expect(BARRA_INFERIOR.altura).toBe(0);
  });

  it("sem nenhuma aba visível, a barra não desenha nada", () => {
    // Papel nulo: ninguém resolveu a organização ainda. Uma barra só com o
    // "Mais" tomaria altura da tela para repetir o hambúrguer da barra de cima.
    estado.role = null;
    const { container } = montar();
    expect(container.firstChild).toBeNull();
    estado.role = "admin";
  });
});
