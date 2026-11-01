/**
 * O FREIO DO BROADCAST — os achados da revisão do #3126, um caso por achado.
 *
 * `transmissao.test.ts` cobre a regra pura do relatório; aqui é a ORQUESTRAÇÃO
 * (`rodarCampanhaEmTransmissao`, `encerrarTransmissao`, o opt-out em voo), contra
 * um PostgREST em memória e um provedor de mentira. Os dois lados que a revisão
 * pediu medidos: o que acontece com a campanha e o que chega ao provedor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { ErroDaTransmissao, type DestinatarioDaTransmissao, type OpsDeTransmissao } from "@/lib/channels/transmissao";

const mundo = vi.hoisted(() => ({
  ops: null as OpsDeTransmissao | null,
  enviadosHojeNoNumero: 0,
  contados: [] as number[],
  erroNoUpdateDaCampanha: null as { code: string; message: string } | null,
}));

vi.mock("@/lib/logger", () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => ({
    knobs: { ...PACING_DEFAULTS, windowStartHour: 0, windowEndHour: 24, allowSunday: true, timezone: "America/Asuncion" },
    numberActivatedAt: null,
  }),
  loadPacingState: async () => ({ lastSentAt: null, sentToday: mundo.enviadosHojeNoNumero, numberActivatedAt: null }),
  recordSends: async (_p: unknown, _o: string, _c: string, _a: Date, n: number) => {
    mundo.contados.push(n);
  },
}));
vi.mock("@/lib/channels/transmissao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  transmissaoDaConexao: async () => mundo.ops,
}));
vi.mock("@/lib/campanhas/modelo-da-conexao", () => ({
  definicaoDaCampanha: async () => ({ name: "aviso", language: "es" }),
  contratoDe: () => ({ slots: [] }),
}));

import { cancelarAcao, type CampanhaCarregada } from "./acoes";
import { aplicarRespostaNaCampanha } from "./resposta";
import {
  DETALHE_ACIMA_DO_TETO_DA_CAMPANHA,
  DETALHE_ACIMA_DO_TETO_DO_NUMERO,
  DETALHE_CANCELAMENTO_RECUSADO,
  DETALHE_CANCELAMENTO_SEM_CONEXAO,
  encerrarTransmissao,
  paginasDoRelatorio,
  rodarCampanhaEmTransmissao,
  tetoDaTransmissao,
  type CampanhaDaTransmissao,
} from "./transmissao";

type Linha = Record<string, unknown>;

const AGORA = new Date("2026-11-02T14:00:00.000Z"); // segunda, 11h em Assunção
const ORG = "org-1";

/** PostgREST em memória: só o que estes caminhos usam. */
function fakeAdmin(tabelas: Record<string, Linha[]>) {
  const de = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let patch: Linha | null = null;
    let soContagem = false;
    let limite = Infinity;
    let faixa: [number, number] | null = null;
    const resolver = () => {
      if (patch && tabela === "campaigns" && mundo.erroNoUpdateDaCampanha && "provider_broadcast_id" in patch) {
        return { data: null, error: mundo.erroNoUpdateDaCampanha, count: null };
      }
      let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      if (patch) for (const l of linhas) Object.assign(l, patch);
      if (faixa) linhas = linhas.slice(faixa[0], faixa[1] + 1);
      linhas = linhas.slice(0, limite);
      return { data: soContagem ? null : linhas.map((l) => ({ ...l })), error: null, count: linhas.length };
    };
    const b: Record<string, unknown> = new Proxy(
      {},
      {
        get(_alvo, metodo) {
          switch (metodo) {
            case "then":
              return (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
                Promise.resolve(resolver()).then(ok, falha);
            case "maybeSingle":
            case "single":
              return async () => {
                const r = resolver();
                return { data: r.data?.[0] ?? null, error: r.error };
              };
            case "select":
              return (_c?: string, opts?: { head?: boolean }) => {
                if (opts?.head) soContagem = true;
                return b;
              };
            case "update":
              return (p: Linha) => ((patch = p), b);
            case "eq":
              return (c: string, v: unknown) => (filtros.push((l) => l[c] === v), b);
            case "in":
              return (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), b);
            case "is":
              return (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), b);
            case "not":
              return (c: string) => (filtros.push((l) => (l[c] ?? null) !== null), b);
            case "gte":
              return (c: string, v: string) => (filtros.push((l) => String(l[c]) >= v), b);
            case "order":
              return () => b;
            case "limit":
              return (n: number) => ((limite = n), b);
            case "range":
              return (a: number, z: number) => ((faixa = [a, z]), b);
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

function destinatario(id: string, telefone: string, status = "pending"): Linha {
  return {
    id,
    campaign_id: "c1",
    organization_id: ORG,
    contact_id: `ct-${id}`,
    recipient_address: telefone,
    variables: { modelo: {} },
    status,
    sent_at: null,
    delivered_at: null,
    read_at: null,
    message_id: null,
    rendered_body: "Olá",
    contacts: { phone_number: telefone, is_blocked: false, is_personal: false, is_anonymized: false, consent: {} },
  };
}

function campanhaLinha(over: Linha = {}): Linha {
  return { id: "c1", organization_id: ORG, status: "running", provider_broadcast_id: null, failure_code: null, ...over };
}

const CAMPANHA: CampanhaDaTransmissao = {
  id: "c1",
  organization_id: ORG,
  channel_session_id: "s1",
  name: "Aviso",
  provider_template_name: "aviso",
  provider_template_language: "es",
  provider_template_variables: {},
  provider_broadcast_id: null,
  janela_inicio_hora: null,
  janela_fim_hora: null,
};

/** O provedor de mentira: grava o que recebeu e devolve o que o caso pede. */
function provedor(over: Partial<OpsDeTransmissao> = {}) {
  const chamadas = { criar: 0, adicionados: [] as string[], enviar: 0, cancelar: [] as string[] };
  const ops: OpsDeTransmissao = {
    criar: async () => (chamadas.criar++, { id: "b1" }),
    adicionar: async (_id, telefones) => (chamadas.adicionados.push(...telefones), { adicionados: telefones.length, pulados: 0 }),
    enviar: async () => (chamadas.enviar++, { estado: "sending" }),
    ler: async () => ({ estado: "draft" }),
    destinatarios: async () => ({ itens: [], temMais: false, lidos: 0 }),
    cancelar: async (id) => {
      chamadas.cancelar.push(id);
    },
    ...over,
  };
  return { ops, chamadas };
}

function mundoCom(tetoDoNumero: number | null, destinatarios: Linha[], campanha: Linha = campanhaLinha()) {
  return {
    campaigns: [campanha],
    campaign_recipients: destinatarios,
    campaign_suppressions: [],
    channel_sessions: [{ id: "s1", organization_id: ORG, status: "WORKING", daily_message_limit: tetoDoNumero }],
  };
}

const item = (telefone: string, x: Partial<DestinatarioDaTransmissao> = {}): DestinatarioDaTransmissao => ({
  telefone: telefone.replace(/\D/g, ""),
  status: "delivered",
  idDaMensagem: null,
  codigoDoErro: null,
  erro: null,
  enviadoEm: null,
  entregueEm: null,
  lidoEm: null,
  ...x,
});

beforeEach(() => {
  mundo.ops = null;
  mundo.enviadosHojeNoNumero = 0;
  mundo.contados = [];
  mundo.erroNoUpdateDaCampanha = null;
});

const tres = () => [
  destinatario("r1", "+595981000001"),
  destinatario("r2", "+595981000002"),
  destinatario("r3", "+595981000003"),
];

// ─── Achados 1 e 2: o teto é conferido ANTES, e só o que coube é contado ─────

describe("o teto do número e da campanha vale para a lista inteira", () => {
  it("lista maior que o teto diário do número: pausa antes de criar, nada sai, nada é contado", async () => {
    const t = mundoCom(2, tres());
    const { ops, chamadas } = provedor();
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r.detalhe).toBe("pausada:transmissao_acima_do_teto:3>2");
    expect(t.campaigns[0]).toMatchObject({ status: "paused", failure_code: "transmissao_acima_do_teto" });
    expect(t.campaigns[0]!.failure_detail).toBe(DETALHE_ACIMA_DO_TETO_DO_NUMERO);
    expect(chamadas.criar).toBe(0);
    expect(chamadas.adicionados).toEqual([]);
    expect(mundo.contados).toEqual([]);
    // Ninguém ficou reservado: a retomada recomeça da fila.
    expect(t.campaign_recipients.map((d) => d.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("o que o número já mandou hoje desconta do teto", async () => {
    const t = mundoCom(10, tres());
    mundo.enviadosHojeNoNumero = 8;
    mundo.ops = provedor().ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r.detalhe).toBe("pausada:transmissao_acima_do_teto:3>2");
  });

  it("o máximo da campanha também vale (a API aceita, a tela não oferece)", async () => {
    const t = mundoCom(300, tres());
    mundo.ops = provedor().ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, teto_diario: 2 }, AGORA);
    expect(r.detalhe).toBe("pausada:transmissao_acima_do_teto:3>2");
    expect(t.campaigns[0]!.failure_detail).toBe(DETALHE_ACIMA_DO_TETO_DA_CAMPANHA);
  });

  it("cabendo, a lista sai inteira e é contada uma vez, como disparo", async () => {
    const t = mundoCom(10, tres());
    mundo.enviadosHojeNoNumero = 7;
    const { ops, chamadas } = provedor();
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r).toMatchObject({ enviadas: 3, detalhe: "transmissao:sending:3" });
    expect(chamadas.adicionados).toHaveLength(3);
    expect(mundo.contados).toEqual([3]);
    expect(t.campaigns[0]).toMatchObject({ status: "running", provider_broadcast_id: "b1" });
  });

  it("a regra pura: sem teto conhecido cabe; o número vem antes da campanha", () => {
    const base = { tamanho: 5, enviadosHojeNoNumero: 0, tetoDiarioDaCampanha: null, tetoHorarioDaCampanha: null };
    expect(tetoDaTransmissao({ ...base, limiteDoNumero: null })).toEqual({ cabe: true });
    expect(tetoDaTransmissao({ ...base, limiteDoNumero: 5 })).toEqual({ cabe: true });
    expect(tetoDaTransmissao({ ...base, limiteDoNumero: 4 })).toEqual({ cabe: false, de: "numero", livre: 4 });
    expect(tetoDaTransmissao({ ...base, limiteDoNumero: 3, enviadosHojeNoNumero: 9 })).toEqual({
      cabe: false,
      de: "numero",
      livre: 0,
    });
    expect(
      tetoDaTransmissao({ ...base, limiteDoNumero: 100, tetoDiarioDaCampanha: 50, tetoHorarioDaCampanha: 4 }),
    ).toEqual({ cabe: false, de: "campanha", livre: 4 });
  });
});

// ─── Achado 3: quem pede para parar com a lista em voo ───────────────────────

describe("opt-out com a lista `sending`", () => {
  it("o destinatário em voo vira `opted_out`", async () => {
    const t = {
      contacts: [{ id: "ct-r1", organization_id: ORG, is_personal: false, is_blocked: true }],
      organizations: [{ id: ORG, settings: {} }],
      campaign_recipients: [{ ...destinatario("r1", "+595981000001", "sending"), contact_id: "ct-r1" }] as Linha[],
    };
    const r = await aplicarRespostaNaCampanha(fakeAdmin(t), { organizationId: ORG, contactId: "ct-r1", recebidoEm: AGORA });
    expect(r.optOut).toBe(1);
    expect(t.campaign_recipients[0]!.status).toBe("opted_out");
  });
});

// ─── Achado 4: a segunda rodada que manda a mesma transmissão ────────────────

describe("400 no envio de uma transmissão que outra rodada já mandou", () => {
  it("relê o estado e segue acompanhando, sem pausar a campanha", async () => {
    const t = mundoCom(null, tres(), campanhaLinha({ provider_broadcast_id: "b1" }));
    let lidas = 0;
    const { ops } = provedor({
      ler: async () => ({ estado: lidas++ === 0 ? "draft" : "sending" }),
      enviar: async () => {
        throw new ErroDaTransmissao(400, "http_400", "400 Broadcast is not in draft");
      },
    });
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r.detalhe).toMatch(/^transmissao:sending:/);
    expect(t.campaigns[0]).toMatchObject({ status: "running", failure_code: null });
  });
});

// ─── Achado 5: relatório lido pela metade ────────────────────────────────────

describe("relatório truncado", () => {
  it("quem não apareceu no pedaço lido NÃO vira falha, e a campanha não conclui", async () => {
    const lista = [destinatario("r1", "+595981000001", "sending"), destinatario("r2", "+595981000002", "sending")];
    const t = mundoCom(null, lista, campanhaLinha({ provider_broadcast_id: "b1" }));
    const { ops } = provedor({
      ler: async () => ({ estado: "completed" }),
      // O provedor nunca diz que acabou: só o r1 aparece, página após página.
      destinatarios: async () => ({ itens: [item("+595981000001")], temMais: true, lidos: 1 }),
    });
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r.detalhe).toMatch(/:relatorio_incompleto$/);
    expect(t.campaign_recipients[1]!.status).toBe("sending");
    expect(t.campaigns[0]!.status).toBe("running");
  });

  it("o teto de páginas acompanha o tamanho da lista", () => {
    expect(paginasDoRelatorio(0)).toBe(10);
    expect(paginasDoRelatorio(25_000)).toBe(260);
  });
});

// ─── Achado 6: todo mundo recusado ───────────────────────────────────────────

describe("a plataforma recusou todos", () => {
  it("a campanha falha com o motivo, em vez de «Concluída»", async () => {
    const lista = [destinatario("r1", "+595981000001", "sending"), destinatario("r2", "+595981000002", "sending")];
    const t = mundoCom(null, lista, campanhaLinha({ provider_broadcast_id: "b1" }));
    const falha = { status: "failed" as const, codigoDoErro: "131049", erro: "Meta chose not to deliver" };
    const { ops } = provedor({
      ler: async () => ({ estado: "completed" }),
      destinatarios: async () => ({
        itens: [item("+595981000001", falha), item("+595981000002", falha)],
        temMais: false,
        lidos: 2,
      }),
    });
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r.detalhe).toMatch(/:tudo_falhou$/);
    expect(t.campaigns[0]).toMatchObject({ status: "failed", failure_code: "transmissao_tudo_falhou" });
  });

  it("com UM entregue, conclui como sempre", async () => {
    const lista = [destinatario("r1", "+595981000001", "sending"), destinatario("r2", "+595981000002", "sending")];
    const t = mundoCom(null, lista, campanhaLinha({ provider_broadcast_id: "b1" }));
    const { ops } = provedor({
      ler: async () => ({ estado: "completed" }),
      destinatarios: async () => ({
        itens: [item("+595981000001"), item("+595981000002", { status: "failed", codigoDoErro: "131049" })],
        temMais: false,
        lidos: 2,
      }),
    });
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r.concluidas).toBe(1);
    expect(t.campaigns[0]!.status).toBe("completed");
  });
});

// ─── Achado 7: cancelar diz a verdade ────────────────────────────────────────

describe("cancelar a campanha por broadcast", () => {
  const carregada = (over: Partial<CampanhaCarregada> = {}) =>
    ({ id: "c1", organization_id: ORG, channel_session_id: "s1", status: "running", provider_broadcast_id: "b1", ...over }) as CampanhaCarregada;

  it("o provedor recusa: a campanha diz isso, e quem estava em voo fecha", async () => {
    const t = mundoCom(null, tres().map((d) => ({ ...d, status: "sending" })), campanhaLinha({ status: "cancelled", provider_broadcast_id: "b1" }));
    mundo.ops = provedor({
      cancelar: async () => {
        throw new ErroDaTransmissao(500, "http_500", "500 erro");
      },
    }).ops;
    const fechados = await encerrarTransmissao(fakeAdmin(t), carregada(), AGORA);
    expect(fechados).toBe(3);
    expect(t.campaigns[0]).toMatchObject({ failure_code: "transmissao_cancelamento_recusado", failure_detail: DETALHE_CANCELAMENTO_RECUSADO });
  });

  it("o número não fala mais com o provedor: fecha quem estava em voo e avisa", async () => {
    const t = mundoCom(null, tres().map((d) => ({ ...d, status: "sending" })), campanhaLinha({ status: "cancelled", provider_broadcast_id: "b1" }));
    mundo.ops = null;
    const fechados = await encerrarTransmissao(fakeAdmin(t), carregada(), AGORA);
    expect(fechados).toBe(3);
    expect(t.campaign_recipients.every((d) => d.status === "cancelled")).toBe(true);
    expect(t.campaigns[0]!.failure_detail).toBe(DETALHE_CANCELAMENTO_SEM_CONEXAO);
  });

  it("sem transmissão criada, `sending` de campanha de sempre não é tocado", async () => {
    const t = mundoCom(null, [destinatario("r1", "+595981000001", "sending")], campanhaLinha({ status: "cancelled" }));
    expect(await encerrarTransmissao(fakeAdmin(t), carregada({ provider_broadcast_id: null }), AGORA)).toBe(0);
    expect(t.campaign_recipients[0]!.status).toBe("sending");
  });

  it("a ação conta os que estavam em voo — não «0 cancelados»", async () => {
    const t = mundoCom(null, tres().map((d) => ({ ...d, status: "sending" })), campanhaLinha({ provider_broadcast_id: "b1" }));
    mundo.ops = provedor().ops;
    const r = await cancelarAcao(fakeAdmin(t), carregada(), AGORA);
    expect(r).toMatchObject({ ok: true, cancelados: 3 });
  });
});

// ─── Achado 8: erro de banco ao gravar o id ──────────────────────────────────

describe("o id da transmissão não grava", () => {
  it("pausa com o motivo e descarta a transmissão criada — não fica criando e descartando para sempre", async () => {
    const t = mundoCom(null, tres());
    mundo.erroNoUpdateDaCampanha = { code: "57014", message: "statement timeout" };
    const { ops, chamadas } = provedor();
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r.detalhe).toBe("pausada:transmissao_id_nao_gravado");
    expect(chamadas.cancelar).toEqual(["b1"]);
    expect(t.campaigns[0]).toMatchObject({ status: "paused", failure_code: "transmissao_id_nao_gravado" });
  });
});

// ─── Achado 9: o `skipped` do provedor ───────────────────────────────────────

describe("o que o provedor pulou", () => {
  it("é contado com nome neutro — repetido e sem WhatsApp são o mesmo `skipped`", async () => {
    const t = mundoCom(null, tres());
    mundo.ops = provedor({ adicionar: async (_id, tel) => ({ adicionados: tel.length - 1, pulados: 1 }) }).ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r.detalhe).toBe("transmissao:sending:3:pulados_pelo_provedor_1");
  });
});
