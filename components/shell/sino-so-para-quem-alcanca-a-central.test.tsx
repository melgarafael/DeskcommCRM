/**
 * O SINO E A PORTA SÃO A MESMA RÉGUA (issue #3163).
 *
 * O `AlertsBell` não pergunta por permissão: ele pergunta SE A PORTA EXISTE —
 * `destinosDaInterface(...).some((d) => d.href === "/app/ai/inbox")`. Quem
 * responde por essa porta é a entrada `/app/ai/inbox` do catálogo de navegação,
 * e ela não declarava `minRole`: valia para TODO papel, enquanto a vizinha
 * `/app/ai/cases` declarava `agent`. Para o `viewer` o sino aparecia e o
 * contador NUNCA chegava — `useAgentInbox` só consulta quando o papel alcança a
 * Central (`ai.inbox.view` = `agent`, em `hooks/auth/AuthProvider.tsx`) e as
 * três rotas de `/api/v1/ai/inbox` exigem `PAPEL_MINIMO_DA_CENTRAL` e recusam o
 * `viewer` com 403. Não era defeito de API: era uma porta oferecida a quem não
 * entra, e a pessoa via um sino que jamais ia contar nada.
 *
 * O que este arquivo mede é o PAR, para cada papel: o sino E a entrada
 * "Alertas" do menu aparecem exatamente quando o papel alcança a Central, e o
 * piso é o `PAPEL_MINIMO_DA_CENTRAL` — a mesma régua das rotas e do push —,
 * nunca um literal. O CONTROLE é o outro lado: para quem alcança, o contador
 * continua funcionando, com a consulta disparada e o número desenhado no sino.
 *
 * O gate do sino NÃO é mockado aqui de propósito: `destinosDaInterface` e as
 * projeções do menu são as de verdade. Mocká-las mediria o mock, que é
 * exatamente o defeito que este arquivo existe para pegar.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PAPEL_MINIMO_DA_CENTRAL } from "@/lib/ai/inbox-destino";
import { PAPEIS_HUMANOS, ROLE_RANK, type Role } from "@/lib/auth/types";
import { NAV_CATALOG, type NavMetadata } from "@/lib/navigation/catalogo";
import { hubSections, searchable } from "@/lib/navigation/registry";

const ENDERECO_DA_CENTRAL = "/app/ai/inbox";

/**
 * O que o papel ATIVO responde e o que a consulta da Central devolve. É
 * `hoisted` porque o mock de módulo roda antes do corpo do arquivo: um `let`
 * aqui estaria em TDZ na primeira renderização.
 */
const cenario = vi.hoisted(() => ({
  papel: "viewer" as Role,
  abertos: 3,
  consultas: [] as string[],
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "pessoa-1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", role: cenario.papel },
  }),
}));
// O hook de verdade é quem decide se a consulta sai (`enabled: usePermission`),
// e a permissão já é medida pelo gate da porta — aqui o que interessa é (a)
// SE ele é montado e (b) o que o contador faz com o número que chega.
vi.mock("@/hooks/ai/useAgentInbox", () => ({
  useAgentInbox: (status: string) => {
    cenario.consultas.push(status);
    return { data: { items: [], open_count: cenario.abertos } };
  },
}));
// O som da organização e o áudio são assunto do outro arquivo do sino
// (`o-sino-conta-o-que-ninguem-olhou`): aqui ele só não pode interferir.
vi.mock("@/hooks/notifications/useSonsDaCentral", () => ({ useSonsDaCentral: () => undefined }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
// O `Link` de verdade pede o router do App Router por contexto, que não existe
// no jsdom. A âncora preserva o que o sino tem de observável: existe e aponta.
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));

import { AlertsBell } from "./AlertsBell";

/** O sino desenhado — o `<Link>` com o contador —, ou nada. */
const sino = () => screen.queryByTestId("alerts-bell");

/** A entrada "Alertas" do MENU: a mesma porta, pelo lado do hub e do ⌘K. */
const entradaAlertasNoMenu = (papel: Role) =>
  [
    ...searchable(false, papel),
    ...hubSections("ia", false, papel).flatMap((secao) => secao.items),
  ].filter((d) => d.href === ENDERECO_DA_CENTRAL);

/** O que o rank do papel diz sobre alcançar a Central — a régua, não uma lista. */
const alcancaACentral = (papel: Role) => ROLE_RANK[papel] >= ROLE_RANK[PAPEL_MINIMO_DA_CENTRAL];

function abrirSino(papel: Role) {
  cenario.papel = papel;
  return render(<AlertsBell />);
}

describe("o sino de avisos só aparece para quem alcança a Central (#3163)", () => {
  beforeEach(() => {
    cenario.abertos = 3;
    cenario.consultas = [];
  });

  it("viewer: não mostra o sino nem a entrada Alertas — e nenhuma consulta sai", () => {
    abrirSino("viewer");

    expect(sino()).toBeNull();
    expect(entradaAlertasNoMenu("viewer")).toEqual([]);
    // Esta é a metade do defeito que não se vê: o contador nunca chegaria. Sem
    // sino, não fica consulta pendurada esperando um número que a API recusa.
    expect(cenario.consultas).toEqual([]);
  });

  it("agent: mostra o sino e a entrada Alertas do menu", () => {
    abrirSino("agent");

    expect(sino()).not.toBeNull();
    expect(entradaAlertasNoMenu("agent").map((d) => d.label)).toContain("Alertas");
  });

  it("manager e admin também mostram: o piso é um mínimo, não uma lista", () => {
    for (const papel of ["manager", "admin"] as const) {
      abrirSino(papel);

      expect(sino(), `sino ausente para ${papel}`).not.toBeNull();
      expect(
        entradaAlertasNoMenu(papel).length,
        `entrada Alertas ausente para ${papel}`,
      ).toBeGreaterThan(0);
      cleanup();
    }
  });

  it("CONTROLE: quem alcança a Central continua com o contador funcionando", () => {
    cenario.abertos = 7;
    abrirSino("agent");

    // A consulta segue disparada — foi só a porta que passou a ter piso.
    expect(cenario.consultas).toEqual(["open"]);
    expect(screen.getByTestId("alerts-bell")).toHaveAttribute("href", ENDERECO_DA_CENTRAL);
    expect(screen.getByTestId("alerts-bell-count")).toHaveTextContent("7");
  });

  it("o piso é o PAPEL_MINIMO_DA_CENTRAL — a régua das rotas —, nunca o literal", () => {
    const entrada = (NAV_CATALOG as readonly NavMetadata[]).find(
      (d) => d.href === ENDERECO_DA_CENTRAL,
    );
    expect(entrada, `a entrada ${ENDERECO_DA_CENTRAL} sumiu do catálogo`).toBeDefined();
    // IGUALDADE COM A CONSTANTE, e não com "agent": se alguém escrever o
    // literal aqui, os dois divergem no dia em que o piso da Central mudar — e
    // é exatamente nesse dia que a porta se reabriria em silêncio, para todo
    // mundo, sem nenhum teste ficando vermelho.
    expect(entrada!.minRole).toBe(PAPEL_MINIMO_DA_CENTRAL);

    // E a régua vale igual para os TRÊS lados — sino, menu e rank: nada aqui
    // lista papéis à mão, então trocar o piso move os três juntos.
    for (const papel of PAPEIS_HUMANOS) {
      abrirSino(papel);
      const mostraNoSino = sino() !== null;
      const mostraNoMenu = entradaAlertasNoMenu(papel).length > 0;

      expect(mostraNoSino, `sino para ${papel}`).toBe(alcancaACentral(papel));
      expect(mostraNoMenu, `entrada Alertas para ${papel}`).toBe(alcancaACentral(papel));
      cleanup();
    }
  });
});
