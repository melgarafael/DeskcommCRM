"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Barra de progresso ultrafina no topo do viewport (0ms).
 *
 * Fornece resposta tátil imediata no clique de qualquer aba ou link interno do CRM,
 * eliminando a sensação de travamento ou tela congelada enquanto o servidor responde.
 */
export function BarraDeProgressoNavegacao() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [visivel, setVisivel] = useState(false);
  const [progresso, setProgresso] = useState(0);

  /**
   * A rota atual LIDA DE DENTRO do ouvinte — e por isso num ref, não na closure.
   *
   * O ouvinte é registrado uma vez só (`[]`), de propósito: um `addEventListener`
   * no `document` que se re-registra a cada navegação é caro e ainda perde
   * cliques na janela entre remover e adicionar. Mas uma closure criada uma vez
   * congela o `pathname` do PRIMEIRO render — e aí a comparação "é o mesmo
   * destino?" passa a medir contra uma rota que o usuário já deixou.
   *
   * O efeito medido (`tests/unit/barra-de-progresso-navegacao.test.tsx`): depois
   * da primeira navegação, clicar no link da página em que você JÁ ESTÁ acendia
   * a barra. Uma barra que acende sempre não informa nada — é o oposto exato do
   * que esta peça existe para fazer.
   */
  const rotaAtual = useRef(pathname);
  useEffect(() => {
    rotaAtual.current = pathname;
  }, [pathname]);

  // Conclui e reseta a barra quando a rota termina de mudar
  useEffect(() => {
    const t1 = setTimeout(() => {
      setProgresso(100);
    }, 0);
    const t2 = setTimeout(() => {
      setVisivel(false);
      setProgresso(0);
    }, 200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [pathname, searchParams]);

  // Captura cliques em links internos para disparo imediato (0ms)
  useEffect(() => {
    // Os avanços graduais agendados por um clique precisam morrer com o
    // componente: sem isto, desmontar entre 180ms e 450ms deixa dois
    // `setProgresso` pendentes escrevendo num estado que não existe mais.
    const agendados: ReturnType<typeof setTimeout>[] = [];
    const agendar = (fn: () => void, ms: number) => {
      agendados.push(setTimeout(fn, ms));
    };

    const aoClicar = (e: MouseEvent) => {
      const target = (e.target as HTMLElement)?.closest("a");
      if (!target) return;

      const href = target.getAttribute("href");
      if (!href) return;

      // Ignora links externos, novas abas, modificadores de tecla ou hash local
      if (
        target.target === "_blank" ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey ||
        e.altKey ||
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:")
      ) {
        return;
      }

      const urlDestino = new URL(target.href, window.location.href);
      if (urlDestino.origin !== window.location.origin) return;

      const mesmoDestino =
        urlDestino.pathname === rotaAtual.current &&
        urlDestino.search === window.location.search;

      if (!mesmoDestino) {
        setVisivel(true);
        setProgresso(25);
        // Avanço gradual simulado enquanto a requisição está em trânsito
        agendar(() => setProgresso((p) => (p === 25 ? 65 : p)), 180);
        agendar(() => setProgresso((p) => (p === 65 ? 85 : p)), 450);
      }
    };

    document.addEventListener("click", aoClicar, { capture: true });
    return () => {
      document.removeEventListener("click", aoClicar, { capture: true });
      for (const id of agendados) clearTimeout(id);
    };
  }, []);

  if (!visivel) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[9999] h-[2px] bg-transparent"
    >
      <div
        className="h-full bg-primary shadow-[0_0_8px_var(--color-primary)] transition-all duration-200 ease-out"
        style={{
          width: `${progresso}%`,
          opacity: progresso === 100 ? 0 : 1,
        }}
      />
    </div>
  );
}
