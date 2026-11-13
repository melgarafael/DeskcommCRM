/**
 * A CASCA NÃO PEDE A TELA ANTES DE ALGUÉM PEDIR — CONTAGEM DE PEDIDOS (#3170).
 *
 * O `<Link>` do App Router prefetcha sozinho TODO destino que entra na viewport,
 * e cada prefetch é um render RSC completo (`proxy.ts` + `loadAuthUser` + as
 * consultas do layout de `/app`) para devolver a casca de uma tela
 * `force-dynamic`. A parte principal da #3170 tirou esse bando do menu (37
 * pedidos `?_rsc` por tela → 4); o que sobrou de pé na casca são os dois
 * destinos que o header oferece em TODA tela de `/app`:
 *
 *   - `AlertsBell` (o sino, `<Link href="/app/ai/inbox">`), montado sempre;
 *   - `AvisoDePropostaEmDestaque` (`<Link href={destino}>`), que monta assim que
 *     o cartão de proposta nova aparece.
 *
 * Este arquivo mede PEDIDO, não milissegundo: o dublê do `next/link` reproduz a
 * metade que interessa do componente de verdade — `prefetch` diferente de
 * `false` é um pedido RSC na montagem — e o dublê do router conta o pedido por
 * intenção. O cronômetro mediria a VPS; a contagem mede o produto.
 *
 * O primeiro caso é a CALIBRAÇÃO da régua: um `<Link>` sem `prefetch={false}`
 * TEM de aparecer na contagem, senão todo "zero" abaixo seria zero de um
 * instrumento quebrado.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentInboxItem } from "@/hooks/ai/useAgentInbox";

/**
 * O que a régua enxerga. `hoisted` porque os mocks de módulo rodam antes do
 * corpo do arquivo — um `let` aqui estaria em TDZ na primeira renderização.
 *
 * `rsc`: pedidos que saíram SÓ POR MONTAR (o prefetch automático do `<Link>`).
 * `intencao`: pedidos do `router.prefetch`, que é o caminho do ponteiro/foco.
 */
const regua = vi.hoisted(() => ({
  rsc: [] as string[],
  intencao: [] as string[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    prefetch: (href: string) => regua.intencao.push(href),
    push: () => undefined,
    refresh: () => undefined,
  }),
  usePathname: () => "/app/inbox",
}));

vi.mock("next/link", async () => {
  const { useEffect } = await import("react");
  /** O `<Link>` do App Router, reduzido à metade que este arquivo mede. */
  function DubleDoLink({
    href,
    prefetch,
    children,
    ...resto
  }: {
    href: string;
    prefetch?: boolean;
    children: React.ReactNode;
  }) {
    // Montar com prefetch ligado (o padrão do Next) é pedir o render RSC do
    // destino — é essa a requisição que a contagem abaixo conta.
    const pedeAoMontar = prefetch !== false;
    useEffect(() => {
      if (pedeAoMontar) regua.rsc.push(href);
    }, [pedeAoMontar, href]);
    return (
      <a href={href} {...resto}>
        {children}
      </a>
    );
  }
  return { default: DubleDoLink };
});

const caixa = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@/hooks/ai/useAgentInbox", () => ({ useAgentInbox: () => ({ data: caixa.data }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "pessoa-1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", role: "agent" },
  }),
  usePermission: () => true,
}));
vi.mock("@/lib/navigation/interface", () => ({
  destinosDaInterface: () => [{ href: "/app/ai/inbox" }],
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/notifications/useSonsDaCentral", () => ({ useSonsDaCentral: () => undefined }));

import Link from "next/link";

import { AlertsBell } from "./AlertsBell";
import { AvisoDePropostaEmDestaque } from "./AvisoDePropostaEmDestaque";

const CENTRAL = "/app/ai/inbox";

const NOVO: AgentInboxItem = {
  id: "novo-1",
  kind: "proposta_pronta_para_revisao",
  severity: "info",
  title: "Proposta da Ana — Condomínio Alvorada",
  body: null,
  ref_kind: "proposal",
  ref_id: "prop-nova",
  status: "open",
  created_at: "2026-11-12T10:00:00Z",
  destination: { estado: "disponivel", rotulo: "Abrir proposta", href: "/app/proposals/prop-nova" },
};

/** Carga da Central: objeto novo a cada chamada, porque o efeito só refaz com `data` novo. */
function abertos(items: AgentInboxItem[]) {
  return { items, open_count: items.length, unseen_count: items.length };
}

describe("#3170 — a casca pede o destino por intenção, não na montagem", () => {
  beforeEach(() => {
    regua.rsc = [];
    regua.intencao = [];
    caixa.data = undefined;
  });

  it("calibração: um <Link> sem prefetch={false} É contado como pedido RSC", () => {
    render(<Link href="/app/qualquer">tela</Link>);
    expect(regua.rsc).toEqual(["/app/qualquer"]);
  });

  it("sino: montar não pede a Central — só o ponteiro (e o foco) pede", () => {
    render(<AlertsBell />);
    const sino = screen.getByTestId("alerts-bell");
    expect(sino).toBeTruthy();
    // A contagem na montagem é o defeito: é ela que paga um render RSC inteiro
    // em toda tela de `/app` para devolver uma casca.
    expect(regua.rsc).toEqual([]);
    expect(regua.intencao).toEqual([]);

    fireEvent.pointerEnter(sino);
    expect(regua.intencao).toEqual([CENTRAL]);
    // Ponteiro que entra, sai e volta não vira rajada: uma vez por destino.
    fireEvent.pointerEnter(sino);
    fireEvent.focus(sino);
    expect(regua.intencao).toEqual([CENTRAL]);
  });

  it("cartão de proposta: aparecer não pede o destino — o foco no link pede", () => {
    const { rerender } = render(<AvisoDePropostaEmDestaque />);
    // Primeira carga só registra ids; o cartão nasce quando chega um aviso novo.
    caixa.data = abertos([NOVO]);
    rerender(<AvisoDePropostaEmDestaque />);

    const cartao = screen.getByTestId("aviso-proposta-destaque");
    expect(cartao).toBeTruthy();
    expect(regua.rsc).toEqual([]);

    const abrir = screen.getByRole("link", { name: "Abrir proposta" });
    fireEvent.focus(abrir);
    expect(regua.intencao).toEqual([NOVO.destination.estado === "disponivel" ? NOVO.destination.href : CENTRAL]);
  });

  it("as duas metades viajam juntas: `prefetch={false}` no <Link> de cada componente", () => {
    // Sem a chave, o handler do ponteiro fica decorativo: o pedido automático
    // continua saindo na montagem e o por-intenção vira um segundo pedido.
    render(<AlertsBell />);
    expect(screen.getByTestId("alerts-bell").closest("a")).toBeTruthy();
    expect(regua.rsc).toEqual([]);
  });
});
