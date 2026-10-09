import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * "SEU ARQUIVO ESTÁ ERRADO" E "O SERVIÇO CAIU" SÃO DIAGNÓSTICOS OPOSTOS.
 *
 * ─── O que estava indistinguível ────────────────────────────────────────────
 *
 * `UPSTASH_REDIS_REST_URL` e `_TOKEN` são `required()` puro em `lib/env.ts` —
 * sem `.url()`. Um `.env` de self-host com as aspas do arquivo sobrando no valor
 * passa pelo Zod, chega ao `fetch`, e falha. O `reason` que saía era o de
 * ALCANCE, o mesmo que sai quando o contêiner da fila está parado de verdade.
 *
 * As duas leituras mandam quem opera para lugares opostos: uma para reiniciar um
 * serviço saudável, a outra para abrir o editor. É o modo de falha já catalogado
 * nesta casa como ".env sem aspas", e ele custou uma sessão inteira de QA de
 * instalação em VPS.
 *
 * ─── Por que as DUAS metades ────────────────────────────────────────────────
 *
 * Só provar que a forma errada vira `configuracao_invalida` deixaria verde um
 * validador que reprovasse tudo — e aí toda instalação em VPS passaria a
 * reportar `.env` quebrado com o `.env` correto. O segundo caso é o controle:
 * mesma falha de rede, configuração BEM formada, motivo de alcance preservado.
 *
 * Achado de @prevprocesso-maker no PR #465.
 */

const SEGREDO = "segredo-interno-de-teste-com-tamanho-suficiente";

function pedido(): NextRequest {
  return new NextRequest("https://crm.exemplo.com.br/api/v1/health");
}

function comEnv(redisUrl: string, redisToken: string) {
  vi.doMock("@/lib/env", () => ({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://projeto-do-cliente.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
      UPSTASH_REDIS_REST_URL: redisUrl,
      UPSTASH_REDIS_REST_TOKEN: redisToken,
      INTERNAL_CRON_SECRET: SEGREDO,
      INTERNAL_SECRET: "",
    },
  }));
}

/**
 * Os endereços que a rota tentou alcançar. O spy deixa a chamada passar (não
 * troca o `fetch`): o que se mede é se a tentativa EXISTIU, e o controle
 * positivo abaixo prova que o spy enxerga a chamada ao Redis quando ela existe.
 */
function enderecosTentados(espiao: { mock: { calls: unknown[][] } }): string[] {
  return espiao.mock.calls.map(([alvo]) => (alvo instanceof Request ? alvo.url : String(alvo)));
}

describe("GET /api/v1/health — o motivo aponta para o que precisa ser feito", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/env");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("⭐ `.env` com as aspas sobrando: o motivo é a CONFIGURAÇÃO, e o serviço nem é procurado", async () => {
    // A forma exata que um heredoc de instalador produz.
    comEnv('"https://fila-do-cliente.exemplo:80"', "token-de-teste");
    const { GET } = await import("@/app/api/v1/health/route");

    const espiao = vi.spyOn(globalThis, "fetch");

    const { data } = await (await GET(pedido())).json();

    expect(data.checks.redis.reason).toBe("configuracao_invalida");
    expect(data.checks.redis.status).toBe("down");
    // Sem ida à rede: um endereço que não é endereço não tem o que ser tentado.
    // Medido pelo `fetch`, não pelo relógio — o tempo da rota inteira inclui
    // Supabase e WAHA, e passou de 2s num CI lento sem tentativa nenhuma ao Redis.
    expect(
      enderecosTentados(espiao).filter((u) => u.includes("fila-do-cliente.exemplo")),
      "houve ida à rede para um endereço malformado",
    ).toEqual([]);
  });

  it("⭐ configuração BEM formada e serviço inalcançável: o motivo volta a ser de alcance", async () => {
    // CONTROLE POSITIVO. Sem ele, um validador que reprovasse tudo deixaria o
    // caso acima verde e faria toda instalação saudável reportar `.env` quebrado.
    // A porta 9 é reservada (discard) e recusa na hora — nada fica pendurado.
    comEnv("http://127.0.0.1:9", "token-de-teste");
    const { GET } = await import("@/app/api/v1/health/route");
    const espiao = vi.spyOn(globalThis, "fetch");

    const { data } = await (await GET(pedido())).json();

    // O spy NÃO está cego: com endereço bem formado, a tentativa ao Redis
    // aparece. Sem isto, o `toEqual([])` do caso acima passaria com um spy que
    // não vê chamada nenhuma.
    expect(
      enderecosTentados(espiao).some((u) => u.includes("127.0.0.1:9")),
      "o spy não viu a ida à rede que a configuração válida faz",
    ).toBe(true);

    expect(data.checks.redis.status).toBe("down");
    expect(
      data.checks.redis.reason,
      "a configuração é válida — chamar isto de erro de configuração manda o operador editar um arquivo correto",
    ).not.toBe("configuracao_invalida");
    expect(data.checks.redis.reason).toBeTruthy();
  });

  it("o endereço malformado continua sem sair para quem não tem o segredo", async () => {
    // A redação de `semAlvo()` não pode ter sido furada pelo caminho novo: ele
    // é o único que monta o `error` à mão, e um caminho novo é exatamente onde
    // uma guarda de saída deixa de alcançar.
    comEnv('"https://fila-do-cliente.exemplo:80"', "token-de-teste");
    const { GET } = await import("@/app/api/v1/health/route");

    const corpo = JSON.stringify(await (await GET(pedido())).json());
    expect(corpo).not.toContain("fila-do-cliente.exemplo");
  });
});
