/**
 * A campanha PAUSA quando a plataforma recusa o MODELO na hora do envio.
 *
 * A recusa síncrona do número oficial chega gravada como o envio de modelo a
 * escreve (`meta/send-template-for-session.ts`): `error_code` é o código genérico
 * do adapter e a causa vai no texto, `<canal>_<código>: <detalhe>`. Quem decide a
 * pausa (`codigoDaPlataforma` → `falhaDoEnvioInteiro`) não lia esse prefixo: a
 * campanha com o modelo recusado seguia tentando contato por contato — cada envio
 * a mesma recusa, e o número perdendo qualidade a cada uma.
 *
 * O dublê do envio devolve a linha `failed` exatamente como `messages/_handler.ts`
 * a grava no `catch` (`error_code: adapter.codes.sendFailed`, `error_message`: o
 * texto da exceção).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";

const mundo = vi.hoisted(() => ({
  falha: { error_code: "", error_message: "" },
  envios: 0,
}));

vi.mock("@/lib/logger", () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => ({
    knobs: { ...PACING_DEFAULTS, throttleMs: 0, jitterMaxMs: 0 },
    numberActivatedAt: null,
  }),
  loadPacingState: async () => ({ lastSentAt: null, sentToday: 0, numberActivatedAt: null }),
  recordSend: async () => undefined,
}));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: async (_admin: unknown, _org: string, contato: string) => ({ conversation_id: `conv:${contato}` }),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async () => {
    mundo.envios += 1;
    return { id: `msg-${mundo.envios}`, status: "failed", ...mundo.falha };
  },
}));

import { rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";

type Linha = Record<string, unknown>;

const AGORA = new Date("2026-10-20T14:00:00.000Z"); // terça, 11h em São Paulo

/** PostgREST em memória: só o que a rodada usa neste caminho. */
function fakeAdmin(tabelas: Record<string, Linha[]>) {
  const de = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let limite = Infinity;
    let patch: Linha | null = null;
    const resolver = () => {
      const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))).slice(0, limite);
      if (patch) for (const l of linhas) Object.assign(l, patch);
      return { data: linhas, error: null, count: linhas.length };
    };
    const b: Record<string, unknown> = new Proxy(
      {},
      {
        get(_alvo, metodo) {
          switch (metodo) {
            case "then":
              return (ok: (v: unknown) => unknown) => Promise.resolve(resolver()).then(ok);
            case "maybeSingle":
              return async () => ({ data: resolver().data[0] ?? null, error: null });
            case "update":
              return (p: Linha) => ((patch = p), b);
            case "eq":
              return (coluna: string, valor: unknown) => {
                if (coluna === "organizations.status") filtros.push((l) => (l.organizations as Linha).status === valor);
                else filtros.push((l) => l[coluna] === valor);
                return b;
              };
            case "in":
              return (coluna: string, valores: unknown[]) => (filtros.push((l) => valores.includes(l[coluna])), b);
            case "gte":
              return (coluna: string, valor: string) => (filtros.push((l) => String(l[coluna] ?? "") >= valor), b);
            case "not":
              return (coluna: string) => (filtros.push((l) => l[coluna] != null), b);
            case "limit":
              return (n: number) => ((limite = n), b);
            default:
              return () => b;
          }
        },
      },
    );
    return b;
  };
  return { from: de } as never;
}

function cenario() {
  const contato = (id: string) => ({
    id,
    name: id,
    display_name: null,
    phone_number: "+5581999990000",
    is_blocked: false,
    is_personal: false,
    is_anonymized: false,
    consent: null,
  });
  const destinatario = (id: string, contatoId: string): Linha => ({
    id,
    campaign_id: "camp",
    status: "pending",
    sent_at: null,
    contact_id: contatoId,
    recipient_address: null,
    rendered_body: "Oi Ana, a promoção começou",
    variables: { modelo: { "1": "Ana" } },
    contacts: contato(contatoId),
  });
  const tabelas: Record<string, Linha[]> = {
    campaigns: [
      {
        id: "camp",
        organization_id: "org-1",
        channel_session_id: "oficial",
        name: "promo",
        message_mode: "template",
        provider_template_name: "promo_outubro",
        provider_template_language: "pt_BR",
        message_body: null,
        content_version: 1,
        intervalo_segundos: null,
        janela_inicio_hora: null,
        janela_fim_hora: null,
        teto_diario: null,
        teto_horario: null,
        status: "running",
        started_at: "2026-10-20T11:00:00.000Z",
        paused_at: null,
        organizations: { status: "active" },
      },
    ],
    campaign_recipients: [destinatario("r-ana", "ana"), destinatario("r-bia", "bia")],
    campaign_channel_sessions: [],
    channel_sessions: [{ id: "oficial", organization_id: "org-1", status: "WORKING", daily_message_limit: null }],
  };
  return { admin: fakeAdmin(tabelas), tabelas };
}

beforeEach(() => {
  mundo.envios = 0;
});

describe("rodada: a plataforma recusa o modelo no primeiro envio", () => {
  it.each([
    ["meta_132000: (#132000) Number of parameters does not match the expected number of params", "132000"],
    ["meta_132001: (#132001) Template name does not exist in the translation", "132001"],
    ["meta_132015: (#132015) Template is paused", "132015"],
    // O outro canal que passa pelo mesmo envio de modelo grava o PRÓPRIO prefixo
    // (`errorPrefix`); o nome dele não pode morar fora de `lib/channels/`.
    ["parceiro_132012: Parameter format does not match format in the created template", "132012"],
  ])("⭐ %s → a campanha pausa com o motivo", async (texto, codigo) => {
    mundo.falha = { error_code: `${texto.split("_")[0]}_error`, error_message: texto };
    const { admin, tabelas } = cenario();

    const r = await rodarUmaRodadaDeCampanha(admin, AGORA);

    const campanha = tabelas.campaigns![0]!;
    expect(r.detalhe).toContain(`pausada:${codigo}`);
    expect(campanha.status).toBe("paused");
    expect(campanha.failure_code).toBe(codigo);
    expect(campanha.failure_detail).toEqual(expect.any(String));
    expect(campanha.failure_detail).not.toBe(texto); // a frase traduzida, não o texto cru
    expect(tabelas.campaign_recipients!.find((d) => d.id === "r-ana")!.last_error_code).toBe(codigo);

    // A rodada seguinte não tenta a segunda pessoa: a campanha está parada.
    await rodarUmaRodadaDeCampanha(admin, new Date(AGORA.getTime() + 60_000));
    expect(mundo.envios).toBe(1);
    expect(tabelas.campaign_recipients!.find((d) => d.id === "r-bia")!.status).toBe("pending");
  });
});

describe("rodada: falha que é da pessoa ou passageira NÃO pausa", () => {
  it.each([
    ["meta_131026: (#131026) Message undeliverable", "131026"],
    ["meta_500: http_500", "500"],
    ["fetch failed", "send_failed"],
  ])("%s → segue para o próximo contato", async (texto, codigo) => {
    mundo.falha = { error_code: "meta_error", error_message: texto };
    const { admin, tabelas } = cenario();

    await rodarUmaRodadaDeCampanha(admin, AGORA);

    expect(tabelas.campaigns![0]!.status).toBe("running");
    expect(tabelas.campaign_recipients!.find((d) => d.id === "r-ana")!.last_error_code).toBe(codigo);
  });

  // A plataforma pediu para desacelerar: não é falha da pessoa, e falhá-la a
  // tiraria da campanha por pressa nossa. Ela volta para a fila e sai na rodada
  // seguinte — o mesmo desfecho do 429 do parceiro (`ehLimiteDeVelocidade`).
  it("meta_130429: (#130429) Rate limit hit → a pessoa volta para a fila", async () => {
    mundo.falha = { error_code: "meta_error", error_message: "meta_130429: (#130429) Rate limit hit" };
    const { admin, tabelas } = cenario();

    await rodarUmaRodadaDeCampanha(admin, AGORA);

    expect(tabelas.campaigns![0]!.status).toBe("running");
    const ana = tabelas.campaign_recipients!.find((d) => d.id === "r-ana")!;
    expect(ana.status).toBe("pending");
    expect(ana.last_error_code).toBe("limite_de_velocidade");
  });
});
