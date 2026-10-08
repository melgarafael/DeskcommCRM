/**
 * A consulta de CNPJ precisa mandar um `User-Agent` PRÓPRIO — não o do Node.
 *
 * Não é preferência de estilo. Quando o código não define o cabeçalho, o
 * `fetch` do Node 22 manda `User-Agent: node` sozinho, e a borda que serve a
 * BrasilAPI recusa esse valor (403 ou 429; o status variou entre medições).
 * Sem o cabeçalho, ou com ele vazio, também recusa (429). Com o valor neutro
 * deste cliente, 200 — contra o mesmo CNPJ, na mesma rodada.
 *
 * O sintoma que isso produzia na tela não dizia nada disso: "Não foi possível
 * consultar o CNPJ", o texto de reserva de `app/app/companies/_client.tsx`, mais
 * uma dica de que seria "bloqueio temporário". Quem a lesse esperaria — e nunca
 * ia funcionar, em instalação nenhuma.
 *
 * Por isso a asserção não fixa o texto do cabeçalho, mas reprova os três
 * valores que a borda recusa: ausente (que o Node troca por `node`), vazio e o
 * próprio `node`. Trocar por outro valor é livre.
 */
import { describe, expect, it } from "vitest";

import { createBrasilApiClient } from "./client";

const CNPJ = "00000000000191";

/** Captura o `init` do fetch e devolve uma resposta mínima que o Zod aceita. */
function espiao() {
  const chamadas: Array<{ url: string; headers: Headers }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ cnpj: CNPJ, razao_social: "BANCO DO BRASIL SA" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { chamadas, fetchFn };
}

describe("cliente da BrasilAPI", () => {
  it("manda um User-Agent próprio — o padrão do Node, `node`, é recusado pela BrasilAPI", async () => {
    const { chamadas, fetchFn } = espiao();

    const r = await createBrasilApiClient({ fetchFn }).lookupCnpj(CNPJ);

    expect(r.ok).toBe(true);
    expect(chamadas).toHaveLength(1);

    // Ausente aqui vira `node` no fio: o Node preenche sozinho.
    const ua = chamadas[0]!.headers.get("user-agent");
    expect(ua, "sem User-Agent o Node manda `node`, que a BrasilAPI recusa").toBeTruthy();
    expect(ua!.trim().length, "User-Agent vazio é recusado pela BrasilAPI").toBeGreaterThan(0);
    expect(ua!.trim().toLowerCase(), "`node` é o padrão do Node e a BrasilAPI o recusa").not.toBe(
      "node",
    );
  });

  /*
   * NÃO HÁ CASO AQUI PARA "o User-Agent não leva a marca", E É DE PROPÓSITO.
   *
   * O cabeçalho sai para um terceiro, e uma instalação de marca própria não
   * pode entregar o nome de quem a revende à BrasilAPI — mas quem já vigia isso
   * é `tests/unit/branding.test.ts`, que varre `lib/` inteiro atrás do nome do
   * produto e exige linha escrita em `MARCA_CONGELADA` para cada exceção. Ele
   * cobre `lib/brasil-api/client.ts` sem que ninguém precise lembrar.
   *
   * A primeira versão deste arquivo tinha o caso, e ele REPROVOU aquele gate: a
   * asserção `not.toContain("<marca>")` escrevia a marca no próprio teste, em
   * `lib/`. A cerca funcionou contra quem tentava reforçá-la — e a lição é que
   * o caso era redundante, não que o gate estava errado.
   */

  it("ainda distingue 404 de erro de upstream", async () => {
    // Controle de que o espião não está mascarando o tratamento de status: a
    // tela precisa separar "CNPJ não existe" de "não consegui consultar".
    const naoEncontrado = (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    const recusado = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;

    const a = await createBrasilApiClient({ fetchFn: naoEncontrado }).lookupCnpj(CNPJ);
    const b = await createBrasilApiClient({ fetchFn: recusado }).lookupCnpj(CNPJ);

    expect(a).toMatchObject({ ok: false, code: "not_found" });
    expect(b).toMatchObject({ ok: false, code: "upstream_error", status: 403 });
  });
});
