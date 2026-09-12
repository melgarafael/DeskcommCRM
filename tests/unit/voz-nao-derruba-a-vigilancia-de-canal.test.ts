/**
 * UMA ORGANIZAÇÃO QUE PAREIA VOZ NÃO PODE CEGAR A VIGILÂNCIA DE TODAS AS OUTRAS.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * `app/api/v1/cron/channel-health` roda a cada minuto com o cliente admin,
 * SEM filtro de organização — por desenho: é o vigia de toda a instalação. Ele
 * lia 50 sessões de `channel_sessions` e chamava `getAdapter(s.provider)` FORA
 * do `try` da iteração.
 *
 * A migration 0232 pôs `'wacalls'` no CHECK de `channel_sessions.provider` sem
 * pôr um adapter correspondente em `lib/channels/index.ts`, e `getAdapter` falha
 * FECHADO: `unknown_channel_provider: wacalls`. Fora do `try`, essa exceção
 * escapava do laço e abortava a rodada inteira. Uma única organização que
 * pareasse chamada de voz derrubava a vigilância de conexão de TODOS os tenants
 * daquela instalação — e quem estivesse depois dela na fila daquela rodada
 * ficava sem vigia, sem nada na tela dizendo por quê.
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * Comportamento, em duas direções que precisam das DUAS correções e que
 * nenhuma das duas sozinha satisfaz:
 *
 *   1. a linha de voz é IGNORADA (`transportaMensagem`) — sem `warn`, sem
 *      consultar transporte nenhum: não é erro, é categoria;
 *   2. um provider que o BANCO já aceita e esta imagem ainda não conhece — o
 *      clone que aplicou o baseline antes de puxar a imagem nova — não aborta a
 *      rodada: ele cai no `catch` da própria iteração e as sessões seguintes
 *      seguem sendo verificadas.
 *
 * A segunda é a que guarda a linha cuja perda seria silenciosa: mover
 * `getAdapter` de volta para fora do `try` deixa o caso 1 verde.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO = "segredo-de-cron-da-voz";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: SEGREDO, INTERNAL_SECRET: "" },
}));

// Sem transporte configurado, `wahaAdapter.checkHealth` responde
// `{reachable:false}` na hora e sem rede — determinismo sem mockar o seam de
// canais, que é justamente o que está sob teste.
vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => null }));

const sincronizou = vi.fn();
vi.mock("@/lib/channels/health", () => ({
  sincronizarSaudeDaConexao: (...args: unknown[]) => {
    sincronizou(...args);
    return Promise.resolve("sem_mudanca");
  },
}));

const avisos = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { warn: (...a: unknown[]) => avisos(...a), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** As linhas que a consulta desta rodada devolve. */
let linhas: Array<Record<string, unknown>> = [];
const atualizou = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "is", "eq"]) cadeia[m] = () => cadeia;
      cadeia.update = (patch: unknown) => {
        atualizou(patch);
        return cadeia;
      };
      cadeia.limit = async () => ({ data: linhas, error: null });
      return cadeia;
    },
  }),
}));

function sessao(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "sess",
    organization_id: "org",
    status: "WORKING",
    display_name: null,
    phone_number: null,
    archived_at: null,
    provider: "waha",
    waha_session_name: "numero-de-verdade",
    meta_phone_number_id: null,
    zernio_account_id: null,
    ...over,
  };
}

async function rodar(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import("@/app/api/v1/cron/channel-health/route");
  const res = await GET({ headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never);
  const json = (await res.json()) as { data?: Record<string, unknown> };
  return { status: res.status, body: json.data ?? {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  linhas = [];
});

describe("o vigia de conexão sobrevive a um provider que ele não sabe consultar", () => {
  it("controle positivo: a rodada verifica um canal de mensagem", async () => {
    // Sem isto, "a rodada não quebrou" seria verdade por não ter medido nada.
    linhas = [sessao({ id: "waha-1" })];
    const { status, body } = await rodar();
    expect(status).toBe(200);
    expect(body.verificadas).toBe(1);
    expect(sincronizou).toHaveBeenCalledTimes(1);
  });

  it("uma linha de chamada de voz é ignorada, e a seguinte segue vigiada", async () => {
    linhas = [
      sessao({ id: "voz", provider: "wacalls", waha_session_name: null }),
      sessao({ id: "waha-2" }),
    ];
    const { status, body } = await rodar();
    expect(status).toBe(200);
    expect(body.sessoes).toBe(2);
    // A que importa: a org que vem DEPOIS da voz na fila não pode ficar sem vigia.
    expect(body.verificadas).toBe(1);
    expect(body.ignoradas).toBe(1);
    expect(sincronizou).toHaveBeenCalledTimes(1);
    // Categoria não é falha: nada de `warn` por sessão de voz a cada minuto.
    expect(avisos).not.toHaveBeenCalled();
  });

  it("provider que o banco aceita e esta imagem não conhece não aborta a rodada", async () => {
    linhas = [
      sessao({ id: "futuro", provider: "provider-do-futuro", waha_session_name: null }),
      sessao({ id: "waha-3" }),
    ];
    const { status, body } = await rodar();
    expect(status).toBe(200);
    expect(body.verificadas).toBe(1);
    // Aqui `warn` É devido: é falha, não categoria — e é o único rastro de que
    // esta instalação tem uma linha que o código não sabe consultar.
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(sincronizou).toHaveBeenCalledTimes(1);
  });
});
