import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CONFIGURAÇÃO MALFORMADA NÃO VIRA IDA À REDE — EM NENHUM DOS DOIS CLIENTES.
 *
 * ─── O defeito, e por que ele é por CLASSE ──────────────────────────────────
 *
 * Dois módulos constroem um cliente Redis a partir das mesmas duas variáveis:
 *
 *   lib/ai/dispatcher/rate-limit.ts   (contador de login, convite, reset)
 *   lib/ai/rag/debounce.ts            (trava de indexação do material)
 *
 * Os dois só perguntavam `if (!url || !token)`. Com o valor PRESENTE e
 * malformado — as aspas do `.env` sobrando, a linha inteira colada, a quebra do
 * heredoc — o cliente era construído e cada chamada pagava uma ida à rede que
 * não tinha como dar certo, antes de cair no mesmo fallback em memória a que
 * esta guarda chega de graça.
 *
 * Consertar um e não o outro é o modo de falha "conserto por instância": os dois
 * são irmãos e não se parecem por fora. Por isso o caso é `it.each` sobre os
 * dois módulos, e não um teste em cada arquivo.
 *
 * ─── As duas metades ────────────────────────────────────────────────────────
 *
 * O controle positivo não é decoração: uma guarda que recusasse SEMPRE deixaria
 * os casos de cima verdes e desligaria o Redis de toda instalação em VPS — o
 * contador de login viraria per-instance sem ninguém notar, que é degradação de
 * segurança em silêncio.
 *
 * Achado de @prevprocesso-maker no PR #465.
 */

/** O `.env` com as aspas do arquivo dentro do valor. */
const URL_MALFORMADA = '"https://fila-do-cliente.exemplo:80"';
/** O mesmo endereço, bem formado. */
const URL_BOA = "https://fila-do-cliente.exemplo:80";
const TOKEN = "token-de-teste";

type Modulo = { nome: string; exercitar: () => Promise<unknown> };

const MODULOS: Array<[string, () => Promise<Modulo>]> = [
  [
    "lib/ai/dispatcher/rate-limit.ts",
    async () => {
      const m = await import("@/lib/ai/dispatcher/rate-limit");
      return {
        nome: "checkRateLimit",
        exercitar: () => m.checkRateLimit("teste-de-forma", 10, 60),
      };
    },
  ],
  [
    "lib/ai/rag/debounce.ts",
    async () => {
      const m = await import("@/lib/ai/rag/debounce");
      return {
        nome: "acquireDebounce",
        exercitar: () => m.acquireDebounce("org:agente:evento", 30),
      };
    },
  ],
];

function comRedis(url: string) {
  vi.doMock("@/lib/env", () => ({
    env: { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: TOKEN },
  }));
}

describe("a forma do valor é conferida antes de virar cliente", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/env");
    vi.unstubAllGlobals();
  });

  it.each(MODULOS)("⭐ %s: valor malformado não chega ao fetch", async (_arquivo, carregar) => {
    comRedis(URL_MALFORMADA);
    const espiao = vi.fn(() => Promise.reject(new Error("fetch não deveria ter sido chamado")));
    vi.stubGlobal("fetch", espiao);

    const { exercitar } = await carregar();
    // O caminho tem de SEGUIR funcionando: cair para a memória, não lançar.
    await expect(exercitar()).resolves.toBeDefined();

    expect(
      espiao.mock.calls.length,
      "houve ida à rede com um endereço que o `new URL()` recusa",
    ).toBe(0);
  });

  it.each(MODULOS)("%s: valor BEM formado continua indo ao Redis", async (_arquivo, carregar) => {
    // CONTROLE POSITIVO. Sem ele, uma guarda que recusasse sempre passaria nos
    // casos acima e desligaria o Redis compartilhado de toda instalação.
    comRedis(URL_BOA);
    const espiao = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ result: 1 }), { status: 200 })),
    );
    vi.stubGlobal("fetch", espiao);

    const { exercitar } = await carregar();
    await exercitar();

    expect(
      espiao.mock.calls.length,
      "o cliente parou de falar com o Redis mesmo com a configuração correta",
    ).toBeGreaterThan(0);
  });
});
