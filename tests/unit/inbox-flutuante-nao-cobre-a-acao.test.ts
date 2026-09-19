import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * O atalho de mensagens é `fixed` — ele não empurra nada, fica POR CIMA. Um
 * elemento assim tem duas dívidas com o resto do app, e as duas já foram pagas
 * caro uma vez:
 *
 *   1. Ele cobre o rodapé direito de TODA tela. Medido no CI (job 105914234412,
 *      head 0442ce273): o botão "Excluir nó" do painel de fluxos passou 30s
 *      apanhando clique, com o log nomeando o culpado — "<aside aria-label=
 *      'Mensagens rápidas'> subtree intercepts pointer events". Não é problema
 *      de teste: o usuário também não consegue clicar.
 *   2. No próprio Inbox ele é a tela que já está aberta, e pior, se planta
 *      sobre o campo de envio.
 *
 * Um conserto por instância deixaria a próxima tela cair igual. Por isso a
 * reserva é do shell e este arquivo liga as duas grandezas: quem aumentar o
 * atalho sem aumentar a reserva encontra um vermelho aqui, não um relato de
 * usuário depois.
 */

const RAIZ = path.resolve(__dirname, "../..");
const ATALHO = path.join(RAIZ, "components/inbox/FloatingInbox.tsx");
const SHELL = path.join(RAIZ, "app/app/_components/AppShell.tsx");

/** Tailwind: `4` = 1rem = 16px. Só o que este arquivo precisa. */
const PX_POR_PASSO = 4;

/**
 * Captura o grupo 1 ou FALHA com a razão. Uma sonda que não casa devolve
 * `undefined`, e `undefined` lido como texto vira zero medido — o jeito de
 * errar mais barato que existe neste repo.
 */
function capturar(m: RegExpMatchArray | null, oQue: string): string {
  expect(m?.[1], oQue).toBeTruthy();
  return m![1]!;
}

function classesDoAside(fonte: string): string {
  // O `<aside>` é o invólucro fixo; é ele que carrega bottom/right/z.
  const m = fonte.match(/<aside[\s\S]*?className=\{cn\(([\s\S]*?)\)\}/);
  return capturar(m, "o atalho deve continuar sendo um <aside> com className via cn()");
}

/**
 * A distância do rodapé no estado PERMANENTE.
 *
 * O atalho sobe (`bottom-24`) enquanto existe chamada de voz, e aí ocupa 152px.
 * Esse caso fica DE FORA de propósito, e a razão é medida: nele o canto já está
 * tomado pelo `components/voice/ActiveCallPanel.tsx` — `fixed bottom-4 right-4
 * z-50`, que é da MAIN e este PR não toca. Ou seja, a ação no rodapé direito já
 * ficava coberta durante uma chamada antes deste atalho existir; cobrar 160px de
 * reserva permanente aqui pagaria, em faixa vazia em toda tela o tempo todo, por
 * uma dívida que tem outro dono e outro momento.
 *
 * O que este gate cobra é o estado de 100% do tempo.
 */
function distanciaDoRodapePermanente(aside: string): number {
  const ternario = aside.match(/\?\s*"bottom-\d+"\s*:\s*"bottom-(\d+)"/);
  if (ternario?.[1]) return Number(ternario[1]) * PX_POR_PASSO;
  return passo(aside, "bottom") * PX_POR_PASSO;
}

/** A altura do gatilho: o botão que fica visível com o painel fechado. */
function alturaDoGatilho(fonte: string): number {
  const botao = fonte.match(/<button[^>]*aria-controls="floating-inbox-panel"[\s\S]{0,400}?className=\{?["'`]([^"'`]+)/);
  const classes = capturar(
    botao,
    'não achei o botão com aria-controls="floating-inbox-panel" — se o gatilho mudou de forma, ' +
      "esta sonda precisa mudar junto, e não silenciosamente",
  );
  return passo(classes, "h") * PX_POR_PASSO;
}

function passo(classes: string, prefixo: string): number {
  const m = classes.match(new RegExp(`(?:^|["'\\s])${prefixo}-(\\d+)(?:["'\\s]|$)`));
  return Number(capturar(m, `esperava uma classe ${prefixo}-N em: ${classes.slice(0, 200)}`));
}

describe("o atalho de mensagens não cobre a ação de ninguém", () => {
  it("o shell RESERVA pelo menos o que o atalho ocupa no rodapé", () => {
    const atalho = fs.readFileSync(ATALHO, "utf8");
    const shell = fs.readFileSync(SHELL, "utf8");

    const distanciaDoRodape = distanciaDoRodapePermanente(classesDoAside(atalho));
    const altura = alturaDoGatilho(atalho);
    const ocupado = distanciaDoRodape + altura;

    const main = shell.match(/<main className="([^"]+)"/);
    const reservado = passo(capturar(main, "o <main> do shell deve ter className literal"), "pb") * PX_POR_PASSO;

    expect(
      reservado,
      `o atalho ocupa ${ocupado}px do rodapé (bottom ${distanciaDoRodape} + altura ${altura}) ` +
        `e o <main> reserva ${reservado}px. Ação desenhada no rodapé direito fica inclicável.`,
    ).toBeGreaterThanOrEqual(ocupado);
  });

  it("o atalho não aparece na tela que ele mesmo é", () => {
    const atalho = fs.readFileSync(ATALHO, "utf8");

    expect(
      atalho.includes('from "next/navigation"') && atalho.includes("usePathname"),
      "sem usePathname não há como saber em que tela ele está",
    ).toBe(true);

    // A guarda tem de DESLIGAR o componente (return null), não só esconder uma parte.
    const guarda = atalho.match(/if\s*\(\s*rota\??\.\s*startsWith\(\s*"\/app\/inbox"\s*\)\s*\)\s*return null/);
    expect(
      guarda,
      'esperava `if (rota?.startsWith("/app/inbox")) return null` no componente exportado',
    ).toBeTruthy();
  });
});
