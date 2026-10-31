/**
 * A LISTA DE SERVIÇOS QUE A TELA OFERECE E O VALIDADOR QUE PROVA A CHAVE SÃO
 * A MESMA LISTA.
 *
 * Irmão de `tests/unit/provedores-x-registry.test.ts`, mas para
 * `lib/ai/pontos/provedores-de-servico.ts` — que não tem um "registry de
 * execução" único porque STT e TTS não compartilham a mesma forma de chamada
 * (cada ponto tem o seu executor próprio, numa Onda própria). O que todo
 * serviço listado PRECISA ter, sem exceção, é um caso em
 * `validateProviderKey` — sem ele, o operador cadastra a chave, a tela some no
 * "validando…" para sempre (ou pior, grava `unknown_provider:<id>` como se
 * fosse erro de rede), e não há onde investigar porque a chave em si pode
 * estar certa.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { IDS_DE_SERVICO } from "@/lib/ai/pontos/provedores-de-servico";
import { validateProviderKey } from "@/lib/ai/provider-validators";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("todo provedor de serviço oferecido na tela tem validador", () => {
  it("nenhum provedor de serviço cai no branch 'desconhecido' do validador", async () => {
    // fetch sempre falha com 500: um provedor SEM caso dedicado (que cairia no
    // `default` de `validateProviderKey`) e um provedor COM caso dedicado
    // ficariam indistinguíveis se o fetch nunca fosse chamado — este stub
    // garante que, se houver um caso real, ele de fato tentou a rede.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response),
    );

    expect(IDS_DE_SERVICO.length).toBeGreaterThan(0); // controle positivo

    for (const id of IDS_DE_SERVICO) {
      const r = await validateProviderKey(id, "chave-de-teste-qualquer");
      expect(
        r.ok === false ? r.error : "ok_inesperado",
        `"${id}" está na tela de serviços e precisa de um caso em validateProviderKey`,
      ).not.toMatch(/^unknown_provider:/);
    }
  });
});
