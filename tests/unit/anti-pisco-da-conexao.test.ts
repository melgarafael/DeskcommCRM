import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * UMA PERGUNTA QUE FALHA NÃO É UMA CONEXÃO CAÍDA.
 *
 * ─── O defeito, medido numa instalação real ─────────────────────────────────
 *
 *   t+0      a conexão oficial sai de WORKING
 *   t+6 s    o operador manda um texto   → queued
 *   t+63 s   o operador manda um áudio   → queued
 *   t+5 min  a conexão volta
 *
 * Cinco minutos, duas mensagens escritas à mão que nunca saíram. E não houve
 * queda: a pergunta ao provedor falhou UMA vez, e a varredura traduziu isso em
 * queda na primeira tentativa. O canal por QR não sofria disso porque o
 * transporte dele responde local; o intermediado depende de uma API pela
 * internet, onde piscar é normal.
 *
 * ─── Por que a recuperação NÃO espera confirmação ──────────────────────────
 *
 * Os dois erros não custam o mesmo. Demorar a acreditar numa queda custa alguns
 * minutos de aviso atrasado. Demorar a acreditar numa VOLTA custa continuar
 * barrando envio de um canal que já funciona.
 *
 * Duas metades: a regra pura (`julgarQueda`) e a fiação no vigia, pela ROTA do
 * cron, com a sonda do provedor dublada na rede — o que se mede é o que chega ao
 * banco e se o aviso é pedido, não a forma do código.
 */

const SEGREDO = "segredo-do-anti-pisco";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: SEGREDO, INTERNAL_SECRET: "" },
}));

vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveZernioCreds: async () => ({
    accountId: "conta-1",
    apiKey: "chave",
    baseUrl: "https://z.example",
    source: "session" as const,
  }),
}));

const sincronizou = vi.fn();
vi.mock("@/lib/channels/health", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sincronizarSaudeDaConexao: (...args: unknown[]) => {
    sincronizou(...args);
    return Promise.resolve("avisado");
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

let linhas: Array<Record<string, unknown>> = [];
const updates: Array<{ tabela: string; patch: Record<string, unknown> }> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "is", "eq"]) cadeia[m] = () => cadeia;
      cadeia.update = (patch: Record<string, unknown>) => {
        updates.push({ tabela, patch });
        return cadeia;
      };
      cadeia.limit = async () => ({ data: linhas, error: null });
      cadeia.maybeSingle = async () => ({ data: null, error: null });
      return cadeia;
    },
  }),
}));

import { CONFIRMACOES_PARA_QUEDA, julgarQueda } from "@/lib/channels/health";

const DE_PE = { reachable: true, status: "WORKING", detail: null };
const CAIDO = { reachable: true, status: "STOPPED", detail: null };
const NAO_SEI = { reachable: false, status: null, detail: "ECONNRESET" };

describe("a regra: o pisco não vira queda", () => {
  it("a PRIMEIRA observação ruim não confirma nada", () => {
    const r = julgarQueda(CAIDO, 0);
    expect(r.confirmada, "acreditou na queda na primeira tentativa").toBe(false);
    expect(r.contador).toBe(1);
  });

  it("a segunda seguida confirma — o limiar é o declarado", () => {
    expect(julgarQueda(CAIDO, 1).confirmada).toBe(true);
    expect(julgarQueda(CAIDO, CONFIRMACOES_PARA_QUEDA - 1).confirmada).toBe(true);
    expect(julgarQueda(CAIDO, CONFIRMACOES_PARA_QUEDA - 2).confirmada).toBe(false);
    // O contador para no teto: a sessão caída não paga um UPDATE por rodada.
    expect(julgarQueda(CAIDO, CONFIRMACOES_PARA_QUEDA)).toEqual({ confirmada: true, contador: CONFIRMACOES_PARA_QUEDA });
  });

  it("uma observação BOA zera o contador na hora — a volta não espera confirmação", () => {
    // Sem isto, dois piscos separados por horas somariam e derrubariam o canal.
    expect(julgarQueda(DE_PE, 1)).toEqual({ confirmada: false, contador: 0 });
    expect(julgarQueda(DE_PE, 5).contador).toBe(0);
  });

  it("'não deu para perguntar' conta como ruim", () => {
    // Do lado de quem atende, provedor que não responde e canal caído são a
    // mesma coisa: ninguém recebe mensagem. O que muda é o texto do aviso.
    expect(julgarQueda(NAO_SEI, 0).contador).toBe(1);
    expect(julgarQueda(NAO_SEI, 1).confirmada).toBe(true);
  });

  it("status que não está na lista de alarme não conta como ruim", () => {
    // `STARTING` é o estado normal de todo boot; contá-lo faria cada reinício
    // caminhar em direção a um aviso de queda.
    expect(julgarQueda({ reachable: true, status: "STARTING", detail: null }, 1).contador).toBe(0);
  });
});

function sessao(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sess-oficial",
    organization_id: "org-1",
    status: "WORKING",
    status_reason: null,
    display_name: "Loja Centro",
    phone_number: null,
    archived_at: null,
    consecutive_health_fails: 0,
    provider: "zernio",
    waha_session_name: null,
    meta_phone_number_id: null,
    zernio_account_id: "conta-1",
    datafy_phone_number_id: null,
    ...over,
  };
}

/** A sonda do elo: `disconnected` é queda (o adapter devolve FAILED); `connected`, de pé. */
function sonda(status: "connected" | "disconnected") {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        status: status === "connected" ? "healthy" : "unhealthy",
        messagingRestriction: null,
        platformConnection: { status, phoneStatus: status === "connected" ? "CONNECTED" : null, metaError: null },
      }),
      { status: 200 },
    ),
  );
}

async function rodar(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/v1/cron/channel-health/route");
  const res = await GET({ headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

const escritas = (coluna: string) =>
  updates.filter((u) => u.tabela === "channel_sessions" && coluna in u.patch).map((u) => u.patch[coluna]);

beforeEach(() => {
  vi.clearAllMocks();
  linhas = [];
  updates.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a fiação no vigia, pela rota", () => {
  it("⭐ primeira sonda ruim: o contador sobe, mas nem o status muda nem o aviso é pedido", async () => {
    linhas = [sessao()];
    vi.stubGlobal("fetch", sonda("disconnected"));

    const corpo = await rodar();

    expect(escritas("consecutive_health_fails")).toEqual([1]);
    expect(escritas("status"), "o pisco virou queda no banco").toEqual([]);
    expect(sincronizou, "o pisco abriu aviso de queda").not.toHaveBeenCalled();
    expect(corpo.aguardando_confirmacao).toBe(1);
  });

  it("⭐ segunda sonda ruim seguida: a queda vale — status no banco e aviso pedido", async () => {
    linhas = [sessao({ consecutive_health_fails: 1 })];
    vi.stubGlobal("fetch", sonda("disconnected"));

    await rodar();

    expect(escritas("consecutive_health_fails")).toEqual([2]);
    expect(escritas("status")).toEqual(["FAILED"]);
    expect(sincronizou).toHaveBeenCalledOnce();
  });

  it("a volta não espera: uma sonda boa depois de um pisco zera o contador e segue o caminho normal", async () => {
    linhas = [sessao({ consecutive_health_fails: 1 })];
    vi.stubGlobal("fetch", sonda("connected"));

    await rodar();

    expect(escritas("consecutive_health_fails")).toEqual([0]);
    expect(sincronizou).toHaveBeenCalledOnce();
  });

  it("controle: de pé e sem pisco anterior — nenhuma escrita de contador (a rodada comum não paga UPDATE)", async () => {
    linhas = [sessao()];
    vi.stubGlobal("fetch", sonda("connected"));

    await rodar();

    expect(escritas("consecutive_health_fails")).toEqual([]);
    expect(sincronizou).toHaveBeenCalledOnce();
  });
});
