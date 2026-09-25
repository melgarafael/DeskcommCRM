"use client";

/**
 * O CONTRATO DE OCUPAÇÃO DO RODAPÉ (issue #1305).
 *
 * ─── O defeito que ele fecha, visto por quem usa ────────────────────────────
 *
 * Numa chamada, o painel de voz é `fixed bottom-4 right-4` e cobre o canto
 * inferior direito da tela. No detalhe do follow-up, quem está ali é o botão
 * "Excluir nó", no rodapé do painel de configuração: o clique não chega — o
 * painel de chamada está por cima dele.
 *
 * ─── A causa, e por que ela é estrutural ────────────────────────────────────
 *
 * O número que causava isso não estava errado: estava escrito em DOIS lugares.
 * O painel se posiciona a 16px do fundo (classe `bottom-4`, em
 * `components/voice/ActiveCallPanel.tsx`) e o `<main>` da casca reserva 24px
 * (`p-6`, em `app/app/_components/AppShell.tsx`). Enquanto as duas medidas
 * concordam ninguém vê nada; no dia em que uma peça de 64px de altura nasce
 * dentro dessa faixa de 24px, o canto fica coberto e a ação do rodapé fica
 * inclicável. É a mesma classe de defeito que a barra lateral teve — duas
 * medidas para a mesma coisa, em arquivos diferentes (ver o comentário em
 * `tests/unit/barra-lateral-nao-flutua.test.ts`).
 *
 * ─── O desenho: uma medida só, em três partes ───────────────────────────────
 *
 *   1. cada peça fixa DECLARA o que ocupa (`PecaDoRodape`), no arquivo que a
 *      desenha — `dono` é esse arquivo, e é o que torna o número rastreável;
 *   2. o `ProvedorDaOcupacaoDoRodape` guarda o que está declarado vivo e
 *      publica a reserva na variável `--rodape-ocupado` do `<html>`;
 *   3. a casca DESCONTA essa variável no `<main>`, e mais nada no produto
 *      precisa saber que existe um painel de chamada.
 *
 * A reserva é o MAIOR alcance declarado, e não a soma: duas peças no mesmo
 * canto ocupam faixas que não se somam — o atalho flutuante do Inbox sobe para
 * 96px durante a chamada e o painel de voz fica a 16px; o que a tela precisa
 * descontar é a mais alta (152px), não 232px.
 *
 * SEM peça registrada a reserva é ZERO e a casca não encolhe nada: o rodapé só
 * perde altura enquanto existe algo fixo nele. Reservar uma faixa permanente
 * seria cobrar de todas as telas por um painel que aparece em algumas — e é o
 * que o `<main>` já faz hoje quando não há chamada nenhuma.
 *
 * ─── O que este contrato NÃO resolve ────────────────────────────────────────
 *
 * Ele desconta no `<main>`. Tela que calcula a PRÓPRIA altura a partir da
 * janela — o `grid` do Inbox, em `components/inbox/InboxLayout.tsx`, que se
 * mede por `100dvh - 3.5rem - 2*var(--space-6)` — não passa por aqui e segue
 * com a medida dela; quem fechar aquilo troca o número de lá por esta variável.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/** O `p-6` do `<main>` da casca, em px: o rodapé que já existe sem peça nenhuma. */
export const PISO_DO_RODAPE = 24;

/**
 * A variável que a casca desconta, publicada no `<html>`. Peça escrita em CSS
 * puro (um `bottom-[calc(var(--rodape-ocupado,0px)+1rem)]`) também pode lê-la.
 */
export const VARIAVEL_DA_OCUPACAO = "--rodape-ocupado";

/**
 * Uma peça FIXA do rodapé — o que ela ocupa, declarado por quem a desenha.
 *
 * `altura` é um PISO tirado da régua do próprio CSS da peça (`p-3` + a linha
 * mais alta), não um teto: quando o navegador mede a caixa de verdade, a
 * medição só pode AUMENTAR a reserva (ver `usePecaDoRodape`). É o que faz um
 * aviso que aparece dentro do painel — "o áudio está em outra aba" — continuar
 * contando no dia em que ele empurra a altura.
 */
export interface PecaDoRodape {
  /** O arquivo que desenha a peça. É o dono do número — e o que o torna rastreável. */
  dono: string;
  /** Distância do fundo da janela até a borda de baixo da peça, em px. */
  distancia: number;
  /** Altura declarada da peça, em px (piso: medição real só aumenta). */
  altura: number;
}

/** Quanto do rodapé a peça ocupa: a distância até o fundo mais a altura dela. */
export function ocupacaoDaPeca(peca: PecaDoRodape, alturaMedida = 0): number {
  return Math.round(peca.distancia + Math.max(peca.altura, alturaMedida));
}

/** A reserva da tela: o MAIOR alcance declarado — peças no mesmo canto não se somam. */
export function reservaDoRodape(ocupacoes: readonly number[]): number {
  return ocupacoes.reduce((maior, ocupacao) => Math.max(maior, ocupacao), 0);
}

/**
 * O `padding-bottom` que a casca aplica. `undefined` — nenhum estilo, o `p-6`
 * de sempre — quando não há peça: sem peça não há faixa a reservar, e o rodapé
 * de todas as telas continua exatamente o que era.
 */
export function estiloDaReserva(reserva: number): { paddingBottom: string } | undefined {
  if (reserva <= 0) return undefined;
  return {
    paddingBottom: `max(${PISO_DO_RODAPE}px, var(${VARIAVEL_DA_OCUPACAO}, 0px))`,
  };
}

interface ContratoDoRodape {
  /** O que as peças registradas ocupam agora. Zero quando não há nenhuma. */
  ocupacao: number;
  registrar: (dono: string, ocupacao: number) => () => void;
}

const ContratoCtx = createContext<ContratoDoRodape | null>(null);

/**
 * Guarda o que cada peça viva declarou e publica a reserva.
 *
 * Monta UMA vez, em `app/app/layout.tsx`, e POR FORA do `VoiceCallProvider`:
 * as peças de voz são IRMÃS da casca (o provider desenha o painel depois dos
 * `children`), então o contrato precisa envolver as duas. Provedor dentro do
 * `VoiceCallProvider` deixaria o painel de fora e a reserva nunca apareceria.
 */
export function ProvedorDaOcupacaoDoRodape({ children }: { children: ReactNode }) {
  const [ocupacoes, setOcupacoes] = useState<Record<string, number>>({});

  const registrar = useCallback((dono: string, ocupacao: number) => {
    // A guarda evita re-render a cada medição que não mudou nada: `setState` com
    // o mesmo valor já não repinta, mas o objeto novo entraria no `useMemo` da
    // reserva e acordaria a árvore inteira a cada quadro de arrasto.
    setOcupacoes((antes) => (antes[dono] === ocupacao ? antes : { ...antes, [dono]: ocupacao }));
    return () => {
      setOcupacoes((antes) => {
        if (!(dono in antes)) return antes;
        const depois = { ...antes };
        delete depois[dono];
        return depois;
      });
    };
  }, []);

  const ocupacao = useMemo(() => reservaDoRodape(Object.values(ocupacoes)), [ocupacoes]);

  // A variável vive no `<html>` para alcançar QUALQUER peça fixa — inclusive as
  // que não são filhas do `<main>` (o painel de chamada é irmão da casca) e as
  // que o React desenha em portal.
  useEffect(() => {
    document.documentElement.style.setProperty(VARIAVEL_DA_OCUPACAO, `${ocupacao}px`);
  }, [ocupacao]);

  useEffect(
    () => () => {
      document.documentElement.style.removeProperty(VARIAVEL_DA_OCUPACAO);
    },
    [],
  );

  const valor = useMemo(() => ({ ocupacao, registrar }), [ocupacao, registrar]);
  return <ContratoCtx.Provider value={valor}>{children}</ContratoCtx.Provider>;
}

/**
 * O que o rodapé está ocupado agora — o número que a casca desconta.
 *
 * Erro alto fora do provedor: sem contrato a casca descontaria zero em silêncio,
 * e o defeito da #1305 voltaria sem nada indicando por quê. É o mesmo contrato
 * de `useVoiceCall` ("nunca fora de `VoiceCallProvider`").
 */
export function useOcupacaoDoRodape(): number {
  const contrato = useContext(ContratoCtx);
  if (!contrato) {
    throw new Error("useOcupacaoDoRodape precisa estar dentro de <ProvedorDaOcupacaoDoRodape>");
  }
  return contrato.ocupacao;
}

/**
 * Devolve SÓ a âncora que mede a peça — a data (distância/ocupação) fica no
 * provedor, nunca no retorno.
 *
 * A separação não é estética: a regra `react-hooks/refs` marca como proibida
 * qualquer leitura, durante a renderização, de um valor que carregue uma
 * referência junto. Um retorno `{ ancora, distancia }` seria recusado no lint
 * exatamente por causa do campo ao lado da âncora, e quem quisesse usar os dois
 * ficaria sem saída. Devolvendo a referência sozinha, `ref={ancora}` continua
 * sendo o uso normal de uma referência em React.
 *
 * Fora do provedor a peça simplesmente não reserva: ela desenha no lugar certo
 * do mesmo jeito (a distância é dela) e quem deixa de descontar é a tela. Não é
 * erro — é o estado que existia antes deste contrato, e é o que mantém o painel
 * montável num teste isolado, sem provedor em volta.
 */
export function usePecaDoRodape(peca: PecaDoRodape): RefObject<HTMLDivElement | null> {
  const contrato = useContext(ContratoCtx);
  const ref = useRef<HTMLDivElement | null>(null);
  const [alturaMedida, setAlturaMedida] = useState(0);

  useEffect(() => {
    const elemento = ref.current;
    if (!elemento) return;
    const medir = () => {
      const altura = elemento.getBoundingClientRect().height;
      // Zero é "não houve medição" (jsdom não faz layout, e um elemento
      // escondido também mede zero) — nunca "a peça sumiu": a altura declarada
      // continua valendo como piso.
      if (altura > 0) setAlturaMedida(Math.ceil(altura));
    };
    medir();
    if (typeof ResizeObserver === "undefined") return;
    // `ResizeObserver` alcança o que o layout do React não avisa: a linha de
    // aviso de mídia que aparece dentro do painel, uma quebra de texto, o
    // rodapé que cresce com a tradução.
    const observador = new ResizeObserver(medir);
    observador.observe(elemento);
    return () => observador.disconnect();
  }, []);

  const ocupacao = ocupacaoDaPeca(peca, alturaMedida);
  const registrar = contrato?.registrar;
  useEffect(() => {
    if (!registrar) return;
    return registrar(peca.dono, ocupacao);
  }, [registrar, peca.dono, ocupacao]);

  return ref;
}
