"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";

/**
 * PREFETCH POR INTENÇÃO — para o menu, que antes prefetchava a árvore inteira.
 *
 * ─── O defeito, medido ───────────────────────────────────────────────────────
 *
 * O `<Link>` do App Router prefetcha sozinho TODO destino que entra na viewport.
 * Na barra lateral isso é a árvore de navegação inteira: medido nesta base
 * (Chromium 1248, build de produção, `performance.getEntriesByType("resource")`),
 * uma única tela de `/app` dispara **37 pedidos `?_rsc=`** por conta própria —
 * um por link do menu (19 destinos × as duas instâncias, lateral e móvel) — e cada um deles é um render RSC COMPLETO: o
 * `proxy.ts` valida o JWT, `loadAuthUser` consulta `platform_admins`,
 * `user_organizations` e `fn_support_context`, o layout de `/app` roda as cinco
 * consultas dele, tudo para devolver um esqueleto de ~2,3 KB que a navegação
 * ainda vai refazer quando o dado chegar.
 *
 * Como as telas de `/app` são `force-dynamic`, o payload prefetchado é só a
 * casca: o prefetch paga o render inteiro e entrega quase nada. Esses renders
 * disputam CPU e banco com o render que a pessoa pediu. Medido com a tela de
 * partida já carregada (#3613), o pedido do destino sai em ~3 ms com ou sem a
 * rajada, mas o TTFB dele cai de 339 para 152 ms (30 ms de RTT até o banco)
 * quando ela some: a espera é no servidor, não no navegador.
 *
 * Esse mesmo bando já custou caro em outros lugares desta base: ele atropela
 * `router.refresh()` no meio (ver `components/branding/CampoDeLogo.tsx`,
 * `lib/branding/instalacao.ts`, `app/app/kanban/_client.tsx`) e é a causa de
 * telas que dizem "atualizado" mostrando o render anterior.
 *
 * ─── O que este hook faz ─────────────────────────────────────────────────────
 *
 * Desliga o prefetch automático (`prefetch: false`) e o move para a INTENÇÃO:
 * `pointerenter` e `focus` — os dois sinais que antecedem o clique em quem usa
 * mouse e em quem usa teclado. Quem só passa o olho pela tela não gera render
 * nenhum; quem vai clicar continua entrando na tela pelo caminho rápido, porque
 * o ponteiro chega dezenas de milissegundos antes do clique.
 *
 * Espalhar o retorno num `<Link>` já aplica as duas metades — a chave `prefetch`
 * viaja junto de propósito, para não existir o estado "lembrei do handler e
 * esqueci do `prefetch={false}`", que é justamente o que traz o bando de volta.
 *
 * O `Set` é por montagem e evita repetir o pedido: o ponteiro passa e volta no
 * mesmo item várias vezes, e `router.prefetch` refaria o render a cada entrada.
 * Ele não substitui o cache do router — só não pede duas vezes o mesmo destino.
 */
export function usePrefetchPorIntencao() {
  const router = useRouter();
  const jaPedidos = useRef(new Set<string>());

  return useCallback(
    (href: string) => {
      const pedir = () => {
        if (jaPedidos.current.has(href)) return;
        jaPedidos.current.add(href);
        router.prefetch(href);
      };
      return { prefetch: false as const, onPointerEnter: pedir, onFocus: pedir };
    },
    [router],
  );
}
