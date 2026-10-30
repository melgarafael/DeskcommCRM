/**
 * O MENU PEDE A TELA SÓ QUANDO ALGUÉM VAI PARA ELA (#3170).
 *
 * O `<Link>` do App Router prefetcha todo destino que entra na viewport. Na
 * barra lateral isso é a árvore inteira: medido nesta base, **37 requisições
 * `?_rsc=` por tela** (19 destinos × as duas instâncias do menu), cada uma um
 * render RSC completo (proxy + `loadAuthUser` + as cinco consultas do layout)
 * para devolver ~2,3 KB de casca. Esses renders disputam o servidor com o
 * clique da pessoa.
 *
 * Este teste guarda o COMPORTAMENTO, não o tempo: montar o hook não pode pedir
 * nada; o ponteiro (e o foco, para quem usa teclado) pede UMA vez por destino.
 * O número de milissegundos é medido fora da suíte (o instrumento e as tabelas
 * estão no PR) — aquí só se prende o que não pode voltar a acontecer.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prefetch } = vi.hoisted(() => ({ prefetch: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ prefetch }) }));

import { usePrefetchPorIntencao } from "./prefetchPorIntencao";

beforeEach(() => {
  prefetch.mockClear();
});

describe("usePrefetchPorIntencao", () => {
  it("não pede nada ao montar — o menu não prefetcha sozinho", () => {
    renderHook(() => usePrefetchPorIntencao());
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("desliga o prefetch automático do Link junto do resto", () => {
    const { result } = renderHook(() => usePrefetchPorIntencao());
    // A chave viaja no mesmo objeto do handler: espalhar as duas metades num
    // `<Link>` é o que impede o estado "lembrei do handler, esqueci do false".
    expect(result.current("/app/inbox").prefetch).toBe(false);
  });

  it("pede no ponteiro e no foco — os dois sinais que antecedem o clique", () => {
    const { result } = renderHook(() => usePrefetchPorIntencao());
    const inbox = result.current("/app/inbox");
    inbox.onPointerEnter();
    expect(prefetch).toHaveBeenCalledWith("/app/inbox");

    const agenda = result.current("/app/agenda");
    agenda.onFocus();
    expect(prefetch).toHaveBeenCalledWith("/app/agenda");
  });

  it("não repete o pedido do mesmo destino: ponteiro que entra e sai não vira rajada", () => {
    const { result } = renderHook(() => usePrefetchPorIntencao());
    const inbox = result.current("/app/inbox");
    inbox.onPointerEnter();
    inbox.onPointerEnter();
    inbox.onFocus();
    expect(prefetch).toHaveBeenCalledTimes(1);
  });
});
