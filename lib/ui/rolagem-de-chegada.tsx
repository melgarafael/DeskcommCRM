"use client";
import { useEffect } from "react";

export type Chegada = { ancora: string; scrollY: number };

/**
 * LEVA ATÉ A SEÇÃO DA ÂNCORA, QUANDO ELA PASSA A EXISTIR E PARA DE ANDAR (#4083, #3975).
 *
 * O navegador rola até o alvo do hash uma vez só: antes de o alvo existir (seção
 * que nasce depois de uma leitura), ou antes de uma leitura de cima empurrá-lo
 * para baixo. Nos dois casos a pessoa chega e não vê o que o link prometeu. Por
 * isso o gatilho é o próprio elemento aparecer, e `esperando` é a leitura que
 * ainda mexe no layout acima dele — ⚠️ um observador da MESMA leitura, e não
 * `useIsFetching`, que escuta a cache inteira e acorda com a resposta de outra.
 *
 * Roda uma vez por chegada: ao levar, sai de cena (`aoTerminar`), e revalidar a
 * tela com o hash velho na URL não a traz de volta. `scrollY` diferente do da
 * chegada é alguém rolando enquanto carregava, por qualquer meio: esse lugar é
 * dele. O alvo precisa de `scroll-mt-*` para não parar embaixo do cabeçalho fixo.
 */
export function RolagemDeChegada({
  ancora,
  scrollY,
  esperando,
  aoTerminar,
}: Chegada & { esperando: boolean; aoTerminar: () => void }) {
  useEffect(() => {
    if (esperando) return;
    const levar = () => {
      const secao = document.getElementById(ancora);
      if (!secao) return false;
      aoTerminar();
      if (window.scrollY === scrollY) {
        const reduzido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        secao.scrollIntoView({ behavior: reduzido ? "auto" : "smooth", block: "start" });
      }
      return true;
    };
    if (levar()) return;
    const observador = new MutationObserver(() => {
      if (levar()) observador.disconnect();
    });
    observador.observe(document.body, { childList: true, subtree: true });
    return () => observador.disconnect();
  }, [ancora, scrollY, esperando, aoTerminar]);
  return null;
}
