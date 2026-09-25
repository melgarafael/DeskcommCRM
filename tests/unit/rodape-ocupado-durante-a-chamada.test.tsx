/**
 * DURANTE A CHAMADA, O RODAPÉ DESCONTA O PAINEL — E A AÇÃO DELE SEGUE CLICÁVEL.
 *
 * ─── O que este arquivo prova (issue #1305) ─────────────────────────────────
 *
 * A issue é de um clique que não chega: com a chamada em andamento, o painel de
 * voz cobre o canto inferior direito da tela, e no detalhe do follow-up quem
 * está ali é o "Excluir nó", no rodapé do painel de configuração.
 *
 * Aqui, a casca de verdade (`AppShell`) e o painel de verdade
 * (`ActiveCallPanel`) são montados juntos, na mesma relação da tela real — o
 * painel é IRMÃO da casca, porque o `VoiceCallProvider` desenha os `children`
 * primeiro. O que se mede:
 *
 *   1. a peça declara o que ocupa, e é MAIOR que o rodapé que a casca tinha
 *      (é o defeito: 80px de painel dentro de uma faixa de 24px);
 *   2. a casca desconta isso no `<main>`, pela variável, e publica a reserva;
 *   3. a reserva acompanha a altura MEDIDA da peça — o painel que cresce com o
 *      aviso de mídia passa a reservar mais;
 *   4. duas peças no mesmo canto: a reserva é a MAIOR, não a soma;
 *   5. sem chamada não há faixa nenhuma, e quando a chamada termina a reserva
 *      volta a zero;
 *   6. o clique na ação do rodapé continua chegando.
 *
 * ─── O que este arquivo NÃO prova ───────────────────────────────────────────
 *
 * Geometria. O jsdom não faz layout: `getBoundingClientRect` devolve zero para
 * tudo aqui, então nenhuma asserção deste arquivo mostra o botão saindo de
 * baixo do painel — o que se prova é o NÚMERO que a tela vai descontar. Quem
 * prova o deslocamento em pixels é a medida no navegador, que fica com quem
 * mantém (a doutrina de QA Visual do repositório).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessao = vi.hoisted(() => ({ valor: {} as Record<string, unknown> }));

vi.mock("@/components/voice/VoiceCallContext", () => ({ useVoiceCall: () => sessao.valor }));
vi.mock("@/hooks/contacts/useContact", () => ({ useContact: () => ({ data: undefined }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

// As peças da casca que NÃO são o assunto: barra lateral, barra de cima, barra
// de progresso e os vigias de notificação/presença. Ficam fora para o teste
// medir o rodapé, e não a rede delas.
vi.mock("@/components/shell/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/components/shell/BarraDeProgressoNavegacao", () => ({
  BarraDeProgressoNavegacao: () => null,
}));
vi.mock("@/hooks/atendimento/useSinalDePresenca", () => ({ useSinalDePresenca: () => {} }));
vi.mock("@/hooks/notifications/useInboundMessageAlerts", () => ({
  useInboundMessageAlerts: () => {},
}));
vi.mock("@/hooks/notifications/useCrmAlerts", () => ({ useCrmAlerts: () => {} }));
// O AppShell passou a avisar de ligação ao vivo (#677). O hook lê `useActiveOrg`
// e `usePermission` do AuthProvider, que esta árvore de teste não monta — mesma
// razão dos três mocks acima, e mesma forma.
vi.mock("@/hooks/calls/useInboundCallAlerts", () => ({ useInboundCallAlerts: () => {} }));
vi.mock("@/lib/notifications/notify_open", () => ({ useNotifyOpenFromServiceWorker: () => {} }));

import type { ReactElement } from "react";

import { AppShell } from "@/app/app/_components/AppShell";
import { ActiveCallPanel, PAINEL_DE_CHAMADA } from "@/components/voice/ActiveCallPanel";
import {
  PISO_DO_RODAPE,
  ProvedorDaOcupacaoDoRodape,
  VARIAVEL_DA_OCUPACAO,
  ocupacaoDaPeca,
  usePecaDoRodape,
} from "@/lib/ui/rodape-ocupado";

const ACAO = "Excluir nó";

/** Uma segunda peça no mesmo canto — como o atalho flutuante do Inbox. */
const ATALHO = { dono: "teste/atalho", distancia: 96, altura: 56 };

/** O observador de caixa, que no jsdom existe mas nunca dispara sozinho. */
class ObservadorDeTeste {
  static instancias: ObservadorDeTeste[] = [];
  private readonly aoMedir: () => void;
  constructor(aoMedir: () => void) {
    this.aoMedir = aoMedir;
    ObservadorDeTeste.instancias.push(this);
  }
  observe() {}
  disconnect() {}
  disparar() {
    this.aoMedir();
  }
}

function sessaoEmChamada(): Record<string, unknown> {
  return {
    call: {
      id: "c1",
      contact_id: null,
      direction: "outbound",
      peer_phone: "553198966398",
      status: "connected",
      answered_at: new Date().toISOString(),
    },
    muted: false,
    connectingMedia: false,
    estadoDaMidia: "com_audio",
    midiaEmOutraAba: false,
    encerrando: false,
    toggleMute: vi.fn(),
    hangUp: vi.fn(),
    ouvirAqui: vi.fn(),
  };
}

/** A tela por baixo, na forma do detalhe do follow-up: a AÇÃO fica no fim dela. */
function Tela({ aoExcluir }: { aoExcluir: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <p>o miolo da tela</p>
      <button type="button" onClick={aoExcluir}>
        {ACAO}
      </button>
    </div>
  );
}

function AtalhoDeTeste() {
  const ancora = usePecaDoRodape(ATALHO);
  return <div ref={ancora} data-testid="atalho" />;
}

function arvore({
  comChamada,
  comAtalho,
  aoExcluir,
}: {
  comChamada: boolean;
  comAtalho: boolean;
  aoExcluir: () => void;
}): ReactElement {
  return (
    <ProvedorDaOcupacaoDoRodape>
      <AppShell sidebarCollapsed={false} podeAtender={false}>
        <Tela aoExcluir={aoExcluir} />
      </AppShell>
      {/* Irmão da casca, exatamente como o `VoiceCallProvider` monta o painel:
          ele desenha os `children` primeiro, e o painel DEPOIS. */}
      {comAtalho ? <AtalhoDeTeste /> : null}
      {comChamada ? <ActiveCallPanel /> : null}
    </ProvedorDaOcupacaoDoRodape>
  );
}

function montar({ comChamada = true, comAtalho = false } = {}) {
  sessao.valor = comChamada ? sessaoEmChamada() : {};
  const aoExcluir = vi.fn();
  const utilitarios = render(arvore({ comChamada, comAtalho, aoExcluir }));
  const rodape = screen.getByRole("main");
  return {
    ...utilitarios,
    aoExcluir,
    rodape,
    aoExcluirPresente: () => screen.getByRole("button", { name: ACAO }),
    painel: () => screen.queryByRole("region", { name: "Chamada em andamento" }),
    /** O que a casca está descontando agora — o que a tela mostra no inspetor. */
    reserva: () => Number(rodape.getAttribute("data-rodape-ocupado")),
    /** A variável que a casca consome, publicada no `<html>`. */
    variavel: () => document.documentElement.style.getPropertyValue(VARIAVEL_DA_OCUPACAO),
    redesenhar: (opcoes: { comChamada: boolean; comAtalho: boolean }) =>
      utilitarios.rerender(arvore({ ...opcoes, aoExcluir })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ObservadorDeTeste.instancias = [];
  vi.stubGlobal("ResizeObserver", ObservadorDeTeste);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(VARIAVEL_DA_OCUPACAO);
});

describe("com a chamada em andamento", () => {
  it("o painel ocupa mais que o rodapé, e a casca desconta o que ele ocupa", () => {
    const { reserva, variavel, rodape } = montar();
    const ocupacao = ocupacaoDaPeca(PAINEL_DE_CHAMADA);

    // Guarda de vacuidade: se a peça coubesse no `p-6` de sempre, este arquivo
    // estaria medindo um defeito que não existe — e passaria à toa.
    expect(ocupacao, "a peça coube no p-6: o caso deixaria de medir a #1305").toBeGreaterThan(
      PISO_DO_RODAPE,
    );

    expect(reserva()).toBeGreaterThanOrEqual(ocupacao);
    expect(variavel()).toBe(`${reserva()}px`);
    expect(rodape.getAttribute("style") ?? "").toContain(
      `max(${PISO_DO_RODAPE}px, var(${VARIAVEL_DA_OCUPACAO}, 0px))`,
    );
  });

  it("a ação do rodapé continua clicável", () => {
    const { aoExcluir, aoExcluirPresente } = montar();
    const acao = aoExcluirPresente();
    expect(acao).toBeEnabled();
    fireEvent.click(acao);
    expect(aoExcluir).toHaveBeenCalledTimes(1);
  });

  it("a posição do painel vem do contrato, não de uma classe dele", () => {
    const { painel } = montar();
    const elemento = painel();
    expect(elemento).not.toBeNull();
    expect(elemento!.style.bottom).toBe(`${PAINEL_DE_CHAMADA.distancia}px`);
    expect(
      elemento!.className,
      "o painel voltou a escrever a posição do rodapé por conta própria",
    ).not.toMatch(/(?:^|\s)bottom-\d/);
  });

  it("a reserva acompanha a altura MEDIDA — o painel que cresce reserva mais", () => {
    const { reserva, painel } = montar();
    const declarada = reserva();

    // O painel cresce quando a linha de aviso de mídia entra; quem avisa é o
    // observador de caixa, e é isso que este caso dirige.
    vi.spyOn(painel()!, "getBoundingClientRect").mockReturnValue({ height: 76 } as DOMRect);
    act(() => {
      for (const observador of ObservadorDeTeste.instancias) observador.disparar();
    });

    expect(reserva()).toBe(PAINEL_DE_CHAMADA.distancia + 76);
    expect(reserva()).toBeGreaterThan(declarada);
  });

  it("duas peças no mesmo canto: a reserva é a MAIOR, e não a soma", () => {
    const { reserva } = montar({ comAtalho: true });
    expect(reserva()).toBe(ocupacaoDaPeca(ATALHO));
    expect(reserva()).toBeLessThan(ocupacaoDaPeca(ATALHO) + ocupacaoDaPeca(PAINEL_DE_CHAMADA));
  });

  it("quando a chamada termina, a reserva volta a zero", () => {
    const { reserva, redesenhar } = montar();
    expect(reserva()).toBeGreaterThan(0);
    redesenhar({ comChamada: false, comAtalho: false });
    expect(reserva()).toBe(0);
  });
});

describe("sem chamada nenhuma", () => {
  it("a casca fica exatamente como sempre foi: nenhuma faixa reservada", () => {
    const { reserva, variavel, rodape, painel } = montar({ comChamada: false });
    expect(painel()).toBeNull();
    expect(reserva()).toBe(0);
    expect(variavel()).toBe("0px");
    // `undefined` em `estiloDaReserva`: nenhum estilo inline, então o `p-6` da
    // casca continua sendo o rodapé inteiro (é o que o mantenedor pediu: faixa
    // permanente em todas as telas seria cobrar por um painel que aparece em
    // algumas).
    expect(rodape.getAttribute("style")).toBeNull();
  });
});
