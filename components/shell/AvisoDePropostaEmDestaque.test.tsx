/**
 * O CARTÃO QUE GRITA SÓ QUANDO O AVISO É NOVO.
 *
 * O `proposta_pronta_para_revisao` nasce no worker e o CRM está aberto. A tela
 * tem duas exigências opostas, e é a segunda que costuma ser implementada: o
 * aviso tem que aparecer sem ninguém abrir a Central, e NÃO pode reaparecer a
 * cada F5 por causa dos avisos que já estavam abertos. Daí a primeira carga só
 * registrar ids.
 *
 * O `o-sino-conta-o-que-ninguem-olhou.test.tsx` mede a outra metade do mesmo
 * arquivo de avisos, pelo lado do sino (a contagem de não vistos, e o som que
 * sai por lá). Aqui é o lado da TELA: o que acontece quando o polling traz um
 * item que nasceu depois que a pessoa abriu o CRM. O cartão não tem som nem
 * `Notification` próprios — o caso final prende isso.
 *
 * E é aqui que mora o `portal`: o cartão é `fixed`, e o componente é filho do
 * `<header>` do `TopBar`, que tem `backdrop-blur`. Isso cria bloco containing
 * e o `fixed` passa a se posicionar contra a barra — o balão nascia cortado no
 * topo e o "Dispensar" ficava fora do alcance do olho. O caso novo monta o
 * componente dentro de um header com `backdrop-blur` de propósito, e prova que
 * o cartão NÃO está mais lá dentro.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentInboxItem } from "@/hooks/ai/useAgentInbox";

// O que o `useAgentInbox` devolve, trocado entre uma carga e outra. É `hoisted`
// porque o mock do módulo roda ANTES do corpo deste arquivo: um `let` aqui
// estaria em TDZ quando o componente o pedisse pela primeira vez.
const caixa = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@/hooks/ai/useAgentInbox", () => ({ useAgentInbox: () => ({ data: caixa.data }) }));
// Mesmo gate do `AlertsBell`: `useAuth` para o papel, `destinosDaInterface`
// para a interface da organização. A visibilidade do cartão NÃO é o que este
// arquivo mede — deixar a Central sempre liberada é o que separa "o cartão não
// apareceu" de "a interface escondeu a Central".
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "user-1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", name: "Imobiliária Rio", role: "agent" },
  }),
  usePermission: () => true,
}));
vi.mock("@/lib/navigation/interface", () => ({ destinosDaInterface: () => [{ href: "/app/ai/inbox" }] }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
// O `Link` de verdade pede o router do App Router por contexto; no jsdom não há
// nenhum, e o clique morreria antes de chegar ao `onClick`. A âncora simples
// preserva o que o cartão faz de observável: o `href` e o dispensar.
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

import { AvisoDePropostaEmDestaque } from "./AvisoDePropostaEmDestaque";

const ANTIGO: AgentInboxItem = {
  id: "antigo-1",
  kind: "proposta_pronta_para_revisao",
  severity: "info",
  title: "Proposta antiga — Casa do Ipê",
  body: null,
  ref_kind: "proposal",
  ref_id: "prop-antiga",
  status: "open",
  created_at: "2026-09-20T10:00:00Z",
  destination: { estado: "indisponivel", orientacao: "" },
};

const NOVO: AgentInboxItem = {
  id: "novo-1",
  kind: "proposta_pronta_para_revisao",
  severity: "info",
  // O título é DADO (nome da proposta, do cliente): entra como veio, nunca por
  // t(). Por isso o caso olha a string inteira.
  title: "Proposta da Ana — Condomínio Alvorada",
  body: null,
  ref_kind: "proposal",
  ref_id: "prop-nova",
  status: "open",
  created_at: "2026-09-27T10:00:00Z",
  destination: { estado: "disponivel", rotulo: "Abrir proposta", href: "/app/proposals/prop-nova" },
};

const DE_OUTRO_KIND: AgentInboxItem = {
  ...NOVO,
  id: "novo-2",
  kind: "budget_exceeded",
  title: "Orçamento de IA estourado",
  destination: { estado: "indisponivel", orientacao: "" },
};

/** Carga da Central: SEMPRE um objeto novo, porque o efeito só refaz com `data` novo. */
function abertos(items: AgentInboxItem[]) {
  return { items, open_count: items.length, unseen_count: items.length };
}

const cartao = () => screen.queryByTestId("aviso-proposta-destaque");

describe("aviso de proposta em destaque", () => {
  beforeEach(() => {
    caixa.data = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("primeira carga com aviso de proposta NÃO mostra o cartão", () => {
    // A carga que abre a tela já pode trazer avisos antigos. Mostrar o cartão
    // aqui é o defeito: o F5 do fim da tarde repetiria um grito de ontem.
    caixa.data = abertos([ANTIGO]);
    const { rerender } = render(<AvisoDePropostaEmDestaque />);
    expect(cartao()).toBeNull();

    // E o polling que devolve a MESMA lista também não pode acordar nada.
    caixa.data = abertos([ANTIGO]);
    rerender(<AvisoDePropostaEmDestaque />);
    expect(cartao()).toBeNull();
  });

  it("carga seguinte com aviso NOVO mostra o cartão com o título e o destino", async () => {
    caixa.data = abertos([ANTIGO]);
    const { rerender } = render(<AvisoDePropostaEmDestaque />);
    expect(cartao()).toBeNull();

    caixa.data = abertos([ANTIGO, NOVO]);
    rerender(<AvisoDePropostaEmDestaque />);

    const aviso = await screen.findByTestId("aviso-proposta-destaque");
    expect(aviso).toHaveTextContent("Proposta da Ana — Condomínio Alvorada");
    expect(aviso).toHaveTextContent("A IA preparou uma proposta. Confira antes de enviar.");
    expect(screen.getByRole("link", { name: "Abrir proposta" })).toHaveAttribute(
      "href",
      "/app/proposals/prop-nova",
    );
  });

  it("aviso NOVO de outro kind não mostra o cartão", () => {
    // O cartão é do `proposta_pronta_para_revisao`. Um handoff ou um orçamento
    // estourado é a Central que trata — se o cartão aparece para qualquer item
    // novo, ele vira sino e para de informar.
    caixa.data = abertos([ANTIGO]);
    const { rerender } = render(<AvisoDePropostaEmDestaque />);

    caixa.data = abertos([ANTIGO, DE_OUTRO_KIND]);
    rerender(<AvisoDePropostaEmDestaque />);
    expect(cartao()).toBeNull();
  });

  it("Dispensar esconde o cartão, e ele não volta na carga seguinte", async () => {
    caixa.data = abertos([ANTIGO]);
    const { rerender } = render(<AvisoDePropostaEmDestaque />);
    caixa.data = abertos([ANTIGO, NOVO]);
    rerender(<AvisoDePropostaEmDestaque />);
    await screen.findByTestId("aviso-proposta-destaque");

    fireEvent.click(await screen.findByTestId("aviso-proposta-dispensar"));
    expect(cartao()).toBeNull();

    // E a carga seguinte não ressuscita: dispensar vale para o aviso, não só
    // para o clique.
    caixa.data = abertos([ANTIGO, NOVO]);
    rerender(<AvisoDePropostaEmDestaque />);
    expect(cartao()).toBeNull();
  });

  it("o cartão é PORTAL para o `document.body`: dentro do `header` com backdrop-blur ele nascia cortado", async () => {
    // O defeito era a ÁRVORE, não a classe: `backdrop-blur` no `<header>` do
    // `TopBar` cria bloco containing, e o `position: fixed` do cartão passava a
    // se posicionar em relação à barra — colado no topo, cortado, e com o
    // "Dispensar" fora do alcance do olho (que é o "não fecha" que o dono viu).
    // Nenhuma troca de classe resolve; o que resolve é sair do header.
    caixa.data = abertos([ANTIGO]);
    const { rerender } = render(
      <header data-testid="barra-do-topo" className="sticky top-0 backdrop-blur">
        <AvisoDePropostaEmDestaque />
      </header>,
    );
    caixa.data = abertos([ANTIGO, NOVO]);
    rerender(
      <header data-testid="barra-do-topo" className="sticky top-0 backdrop-blur">
        <AvisoDePropostaEmDestaque />
      </header>,
    );

    const aviso = await screen.findByTestId("aviso-proposta-destaque");
    expect(document.body.contains(aviso)).toBe(true);
    expect(screen.getByTestId("barra-do-topo").contains(aviso)).toBe(false);
  });

  it("Abrir proposta também dispensa: o aviso atendido não volta no polling seguinte", async () => {
    caixa.data = abertos([ANTIGO]);
    const { rerender } = render(<AvisoDePropostaEmDestaque />);
    caixa.data = abertos([ANTIGO, NOVO]);
    rerender(<AvisoDePropostaEmDestaque />);
    await screen.findByTestId("aviso-proposta-destaque");

    fireEvent.click(screen.getByRole("link", { name: "Abrir proposta" }));
    expect(cartao()).toBeNull();

    // A proposta fica aberta na frente da pessoa; o cartão não pode reaparecer
    // em cima dela trinta segundos depois, quando o polling repete a lista.
    caixa.data = abertos([ANTIGO, NOVO]);
    rerender(<AvisoDePropostaEmDestaque />);
    expect(cartao()).toBeNull();
  });

  it("no celular o cartão fica ACIMA da barra de abas, pela reserva do rodapé", async () => {
    // `bottom-4` sozinho punha o cartão em cima do "Inbox"/"Mais" da barra de
    // baixo. A reserva vem da mesma variável que a casca desconta
    // (`lib/ui/rodape-ocupado.tsx`); acima de md não há barra e fica `bottom-4`.
    caixa.data = abertos([ANTIGO]);
    const { rerender } = render(<AvisoDePropostaEmDestaque />);
    caixa.data = abertos([ANTIGO, NOVO]);
    rerender(<AvisoDePropostaEmDestaque />);

    const c = ((await screen.findByTestId("aviso-proposta-destaque")).getAttribute("class") ?? "").split(/\s+/);
    expect(c).toContain("max-md:bottom-[calc(var(--rodape-ocupado,0px)+1rem)]");
    expect(c).toContain("bottom-4");
  });

  it("o cartão NÃO toca som próprio nem notifica o sistema — quem faz isso é o sino", async () => {
    // O som da organização e o push do celular vivem no `AlertsBell`
    // (`useSonsDaCentral`) e no `pushDoAvisoDaCentral`. Um sinal aqui tocaria
    // duas vezes para o mesmo aviso, com um som que a organização não escolheu.
    const notified: string[] = [];
    vi.stubGlobal(
      "Notification",
      class {
        static permission = "granted";
        constructor(titulo: string) {
          notified.push(titulo);
        }
      },
    );
    let contextoCriado = 0;
    vi.stubGlobal(
      "AudioContext",
      class {
        createOscillator() {
          contextoCriado += 1;
          return { connect: () => undefined, start: () => undefined, stop: () => undefined };
        }
        createGain() {
          return { connect: () => undefined };
        }
        get currentTime() {
          return 0;
        }
        get destination() {
          return undefined;
        }
        close() {
          return Promise.resolve();
        }
      },
    );

    caixa.data = abertos([ANTIGO]);
    const { rerender } = render(<AvisoDePropostaEmDestaque />);
    caixa.data = abertos([ANTIGO, NOVO]);
    rerender(<AvisoDePropostaEmDestaque />);

    // O CARTÃO aparece (é a notificação)…
    expect(await screen.findByTestId("aviso-proposta-destaque")).toHaveTextContent(
      "Proposta da Ana — Condomínio Alvorada",
    );
    // …e nada mais dispara por conta própria.
    expect(notified).toEqual([]);
    expect(contextoCriado).toBe(0);
  });
});
