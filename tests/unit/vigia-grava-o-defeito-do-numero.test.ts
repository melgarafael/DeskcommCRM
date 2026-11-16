import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O VIGIA DE SAÚDE GRAVA O DEFEITO DO NÚMERO DE PÉ — pela rota, não pela fonte.
 *
 * Achado pelo sabotador deste conserto: o caso anterior conferia o cron com
 * expressões regulares, e uma guarda desligando a escrita do motivo
 * (`if (motivo !== undefined && …falso…)`) passava verde — as expressões
 * continuavam casando. Aqui a rota do cron roda de verdade, com a sonda do
 * provedor dublada na rede, e o que se mede é o UPDATE que chega ao banco e o
 * idioma com que o aviso é pedido.
 */

const SEGREDO = "segredo-do-vigia-do-defeito";

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
      cadeia.maybeSingle = async () => ({ data: tabela === "organizations" ? { locale: "es" } : null, error: null });
      return cadeia;
    },
  }),
}));

function sessao(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sess-oficial",
    organization_id: "org-1",
    status: "WORKING",
    status_reason: null,
    display_name: "Loja Centro",
    phone_number: null,
    archived_at: null,
    provider: "zernio",
    waha_session_name: null,
    meta_phone_number_id: null,
    zernio_account_id: "conta-1",
    datafy_phone_number_id: null,
    ...over,
  };
}

function sonda(platformConnection: Record<string, unknown>) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ status: "healthy", messagingRestriction: null, platformConnection }), { status: 200 }),
  );
}

async function rodar() {
  const { GET } = await import("@/app/api/v1/cron/channel-health/route");
  const res = await GET({ headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never);
  return res.status;
}

const motivosGravados = () =>
  updates.filter((u) => u.tabela === "channel_sessions" && "status_reason" in u.patch).map((u) => u.patch.status_reason);

beforeEach(() => {
  vi.clearAllMocks();
  linhas = [];
  updates.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("o vigia e o motivo do número de pé", () => {
  it("⭐ a sonda diz que o número não recebe: o motivo vai ao banco, o status não muda, e o aviso sai no idioma da organização", async () => {
    linhas = [sessao()];
    vi.stubGlobal("fetch", sonda({ status: "connected", phoneStatus: "CONNECTED", metaError: null, inboundWebhookSubscribed: false }));

    expect(await rodar()).toBe(200);

    expect(motivosGravados()).toEqual(["numero_nao_recebe_mensagens"]);
    expect(
      updates.some((u) => u.tabela === "channel_sessions" && "status" in u.patch),
      "o vigia mudou o status — barrar o envio é pior que o defeito",
    ).toBe(false);
    expect(sincronizou).toHaveBeenCalledOnce();
    const args = sincronizou.mock.calls[0]!;
    expect(args[2]).toMatchObject({ status: "WORKING", detail: "numero_nao_recebe_mensagens" });
    expect(args[5], "o aviso do defeito sai no idioma da organização").toBe("es");
  });

  it("⭐ a sonda volta limpa: o motivo que o vigia gravou é limpo", async () => {
    linhas = [sessao({ status_reason: "numero_nao_recebe_mensagens" })];
    vi.stubGlobal("fetch", sonda({ status: "connected", phoneStatus: "CONNECTED", metaError: null, inboundWebhookSubscribed: true }));

    await rodar();

    expect(motivosGravados()).toEqual([null]);
  });

  it("⭐ a sonda não informa o recebimento: o motivo fica, e a regra do aviso recebe o que está aberto", async () => {
    linhas = [sessao({ status_reason: "numero_nao_recebe_mensagens" })];
    vi.stubGlobal("fetch", sonda({ status: "connected", phoneStatus: "CONNECTED", metaError: null, inboundWebhookSubscribed: null }));

    await rodar();

    expect(motivosGravados()).toEqual([]);
    const args = sincronizou.mock.calls[0]!;
    expect(args[1]).toMatchObject({ status_reason: "numero_nao_recebe_mensagens" });
    expect(args[2]).toMatchObject({ defeitosSemMedida: ["nao_recebe"] });
  });

  it("controle: número inteiro sem motivo gravado — nenhuma escrita de motivo", async () => {
    linhas = [sessao()];
    vi.stubGlobal("fetch", sonda({ status: "connected", phoneStatus: "CONNECTED", metaError: null, inboundWebhookSubscribed: true }));

    await rodar();

    expect(motivosGravados()).toEqual([]);
    expect(sincronizou.mock.calls[0]![5]).toBe("pt-BR");
  });
});
