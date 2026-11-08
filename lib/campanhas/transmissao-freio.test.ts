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
import {
  ErroDaTransmissao,
  type DestinatarioDaTransmissao,
  type EstadoDaTransmissao,
  type OpsDeTransmissao,
} from "@/lib/channels/transmissao";

const mundo = vi.hoisted(() => ({
  ops: null as OpsDeTransmissao | null,
  enviadosHojeNoNumero: 0,
  contados: [] as number[],
  lotes: new Map<string, number>(),
  datasDoLivro: [] as Date[],
  livroFalha: false,
  erroNoUpdateDaCampanha: null as { code: string; message: string } | null,
  erroNaListaDeExclusao: null as { message: string } | null,
}));

vi.mock("@/lib/logger", () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => ({
    knobs: { ...PACING_DEFAULTS, windowStartHour: 0, windowEndHour: 24, allowSunday: true, timezone: "America/Asuncion" },
    numberActivatedAt: null,
  }),
  loadPacingState: async () => ({ lastSentAt: null, sentToday: mundo.enviadosHojeNoNumero, numberActivatedAt: null }),
  // Como o livro real: o mesmo lote não conta duas vezes, e um relatório maior só
  // completa. O SQL disso é provado em `tests/invariants/pacing-ledger-resposta-nao-conta-no-teto.test.ts`.
  recordSends: async (_p: unknown, _o: string, _c: string, a: Date, n: number, lote: string) => {
    if (mundo.livroFalha) throw new Error("livro fora do ar");
    const novas = n - (mundo.lotes.get(lote) ?? 0);
    if (novas <= 0) return;
    mundo.lotes.set(lote, n);
    mundo.contados.push(novas);
    mundo.datasDoLivro.push(a);
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

import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { cancelarAcao, type CampanhaCarregada } from "./acoes";
import { hashDoEndereco } from "./exclusoes";
import { aplicarRespostaNaCampanha } from "./resposta";
import {
  DETALHE_ACIMA_DO_TETO_DA_CAMPANHA,
  DETALHE_ACIMA_DO_TETO_DO_NUMERO,
  DETALHE_CANCELAMENTO_RECUSADO,
  DETALHE_CANCELAMENTO_SEM_CONEXAO,
  DETALHE_ENVIO_EM_VOO,
  DETALHE_ENVIO_PODE_CONTINUAR,
  DETALHE_RASCUNHO_NAO_APAGADO,
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
      if (tabela === "campaign_suppressions" && mundo.erroNaListaDeExclusao) {
        return { data: null, error: mundo.erroNaListaDeExclusao, count: null };
      }
      let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      if (patch) for (const l of linhas) Object.assign(l, patch);
      if (faixa) linhas = linhas.slice(faixa[0], faixa[1] + 1);
      linhas = linhas.slice(0, limite);
      // `max_rows` do PostgREST (supabase/config.toml): `data` para em 1.000, `count` não.
      return { data: soContagem ? null : linhas.slice(0, 1_000).map((l) => ({ ...l })), error: null, count: linhas.length };
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
              return (c: string, v: string) => (filtros.push((l) => l[c] != null && String(l[c]) >= v), b);
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
  const chamadas = {
    criar: 0,
    adicionados: [] as string[],
    enviar: 0,
    cancelar: [] as string[],
    descartar: [] as string[],
  };
  const ops: OpsDeTransmissao = {
    criar: async () => (chamadas.criar++, { id: "b1" }),
    adicionar: async (_id, telefones) => (chamadas.adicionados.push(...telefones), { adicionados: telefones.length, pulados: 0 }),
    enviar: async () => (chamadas.enviar++, { estado: "sending" }),
    ler: async () => ({ estado: "draft" }),
    destinatarios: async () => ({ itens: [], temMais: false, lidos: 0, total: 0 }),
    cancelar: async (id) => {
      chamadas.cancelar.push(id);
    },
    descartar: async (id) => {
      chamadas.descartar.push(id);
      return true;
    },
    ...over,
  };
  return { ops, chamadas };
}

function mundoCom(tetoDoNumero: number | null, destinatarios: Linha[], campanha: Linha = campanhaLinha()) {
  return {
    campaigns: [campanha],
    campaign_recipients: destinatarios,
    campaign_suppressions: [] as Linha[],
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
  mundo.lotes = new Map();
  mundo.datasDoLivro = [];
  mundo.livroFalha = false;
  mundo.erroNoUpdateDaCampanha = null;
  mundo.erroNaListaDeExclusao = null;
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
    const base = {
      tamanho: 5,
      enviadosHojeNoNumero: 0,
      tetoDiarioDaCampanha: null,
      tetoHorarioDaCampanha: null,
      enviadasHojeNaCampanha: 0,
      enviadasNaHoraNaCampanha: 0,
    };
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

// ─── Da triagem: as duas portas que a lista não pode atravessar ──────────────

describe("o que segura a lista antes do envio", () => {
  it("sem a lista de exclusão, ninguém sai: a rodada cai e a seguinte confere de novo", async () => {
    const t = mundoCom(10, tres());
    const { ops, chamadas } = provedor();
    mundo.ops = ops;
    mundo.erroNaListaDeExclusao = { message: "banco fora" };
    await expect(rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA)).rejects.toThrow(/lista de exclusão/);
    expect(chamadas.criar).toBe(0);
    expect(chamadas.enviar).toBe(0);
    expect(t.campaign_recipients.map((d) => d.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("cancelada enquanto os telefones subiam: o envio não sai e ninguém fica `sending`", async () => {
    const t = mundoCom(10, tres());
    const { ops, chamadas } = provedor({
      adicionar: async (_id, telefones) => {
        t.campaigns[0]!.status = "cancelled";
        return { adicionados: telefones.length, pulados: 0 };
      },
    });
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r.detalhe).toBe("parada_antes_de_mandar:cancelled");
    expect(chamadas.enviar).toBe(0);
    expect(mundo.contados).toEqual([]);
    expect(t.campaign_recipients.map((d) => d.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("pausada enquanto os telefones subiam: o envio não sai e a lista volta à fila para a retomada", async () => {
    const t = mundoCom(10, tres());
    const { ops, chamadas } = provedor({
      adicionar: async (_id, telefones) => {
        t.campaigns[0]!.status = "paused";
        return { adicionados: telefones.length, pulados: 0 };
      },
    });
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r.detalhe).toBe("parada_antes_de_mandar:paused");
    expect(chamadas.enviar).toBe(0);
    expect(t.campaign_recipients.map((d) => d.status)).toEqual(["pending", "pending", "pending"]);
    expect(t.campaigns[0]!.provider_broadcast_id).toBe("b1");
  });
});

// ─── Do cético: o rascunho guarda quem saiu da lista depois de subir ─────────

/**
 * O provedor de verdade: um rascunho por id, que só cresce (`adicionar` acrescenta,
 * não existe remover), e `enviar` manda a quem estiver nele. `para` guarda quem
 * cada envio alcançou — é a afirmação que importa nestes casos.
 */
function provedorComRascunho() {
  const rascunhos = new Map<string, Set<string>>();
  const enviados: Array<{ id: string; para: string[] }> = [];
  const estados = new Map<string, EstadoDaTransmissao>();
  let criados = 0;
  const so = (telefone: string) => telefone.replace(/\D/g, "");
  const ops: OpsDeTransmissao = {
    criar: async () => {
      const id = `b${++criados}`;
      rascunhos.set(id, new Set());
      estados.set(id, "draft");
      return { id };
    },
    adicionar: async (id, telefones) => {
      for (const t of telefones) rascunhos.get(id)!.add(so(t));
      return { adicionados: telefones.length, pulados: 0 };
    },
    enviar: async (id) => {
      enviados.push({ id, para: [...rascunhos.get(id)!] });
      estados.set(id, "sending");
      return { estado: "sending" };
    },
    ler: async (id) => ({ estado: estados.get(id)! }),
    destinatarios: async (id) => {
      const itens = [...rascunhos.get(id)!].map((t) => item(t, { status: "pending" }));
      return { itens, temMais: false, lidos: itens.length, total: itens.length };
    },
    cancelar: async () => undefined,
    descartar: async (id) => {
      if (estados.get(id) !== "draft") return false;
      rascunhos.delete(id);
      estados.delete(id);
      return true;
    },
  };
  return { ops, rascunhos, enviados, estados };
}

/** Rodada 1: a campanha pausa com os telefones já no rascunho, como no caminho real. */
async function pausarComOsTelefonesSubindo(t: ReturnType<typeof mundoCom>, p: ReturnType<typeof provedorComRascunho>) {
  const adicionar = p.ops.adicionar;
  mundo.ops = {
    ...p.ops,
    adicionar: async (id, telefones) => {
      const r = await adicionar(id, telefones);
      t.campaigns[0]!.status = "paused";
      return r;
    },
  };
  const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
  expect(r.detalhe).toBe("parada_antes_de_mandar:paused");
  expect(p.rascunhos.get("b1")?.size).toBe(3);
  expect(t.campaigns[0]!.provider_broadcast_id).toBe("b1");
  mundo.ops = p.ops;
}

/** O que a retomada faz: `running` de novo, e as rodadas do cron até o envio sair. */
async function retomar(t: ReturnType<typeof mundoCom>) {
  t.campaigns[0]!.status = "running";
  const rodada = () =>
    rodarCampanhaEmTransmissao(
      fakeAdmin(t),
      { ...CAMPANHA, provider_broadcast_id: (t.campaigns[0]!.provider_broadcast_id as string | null) ?? null },
      AGORA,
    );
  return [await rodada(), await rodada()];
}

const SO_OS_OUTROS = ["595981000002", "595981000003"];

describe("quem saiu da lista depois que os telefones subiram", () => {
  it("opt-out na pausa: o rascunho é apagado, o novo sai sem a pessoa, e ela segue `opted_out`", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    await pausarComOsTelefonesSubindo(t, p);

    // A pessoa pede para sair durante a pausa, pelo caminho da ingestão.
    const r1 = t.campaign_recipients[0]!;
    (r1.contacts as Linha).is_blocked = true;
    await aplicarRespostaNaCampanha(
      fakeAdmin({
        contacts: [{ id: r1.contact_id, organization_id: ORG, is_personal: false, is_blocked: true }],
        organizations: [{ id: ORG, settings: {} }],
        campaign_recipients: t.campaign_recipients,
      }),
      { organizationId: ORG, contactId: r1.contact_id as string, recebidoEm: AGORA },
    );
    expect(r1.status).toBe("opted_out");

    const [refez] = await retomar(t);
    expect(refez!.detalhe).toBe("rascunho_refeito");
    expect(p.rascunhos.has("b1")).toBe(false);
    expect(p.enviados.map((e) => e.id)).toEqual(["b2"]);
    expect(p.enviados[0]!.para.sort()).toEqual(SO_OS_OUTROS);
    expect(t.campaigns[0]).toMatchObject({ status: "running", provider_broadcast_id: "b2" });
    expect(r1.status).toBe("opted_out");
    expect(mundo.contados).toEqual([2]);
  });

  it("entrou na lista de exclusão na pausa: mesma coisa", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    await pausarComOsTelefonesSubindo(t, p);
    t.campaign_suppressions = [{ organization_id: ORG, recipient_address_hash: hashDoEndereco("+595981000001") }];
    await retomar(t);
    expect(p.enviados.map((e) => e.id)).toEqual(["b2"]);
    expect(p.enviados[0]!.para.sort()).toEqual(SO_OS_OUTROS);
    expect(t.campaign_recipients[0]).toMatchObject({ status: "skipped", exclusion_reason: "suprimido" });
  });

  it("5xx no envio devolve à fila; quem foi anonimizado depois não sai na retomada", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    mundo.ops = {
      ...p.ops,
      enviar: async () => {
        throw new ErroDaTransmissao(503, "http_503", "503 fora do ar");
      },
    };
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r.detalhe).toBe("pausada:transmissao_http_503");
    expect(p.enviados).toEqual([]);
    expect(t.campaign_recipients.map((d) => d.status)).toEqual(["pending", "pending", "pending"]);

    mundo.ops = p.ops;
    (t.campaign_recipients[0]!.contacts as Linha).is_anonymized = true;
    await retomar(t);
    expect(p.enviados.map((e) => e.id)).toEqual(["b2"]);
    expect(p.enviados[0]!.para.sort()).toEqual(SO_OS_OUTROS);
  });

  it("reservado de uma rodada que caiu passa pelos mesmos vetos, e ninguém fica `sending` sem id", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    await pausarComOsTelefonesSubindo(t, p);
    // A rodada caiu depois de reservar: todos `sending`, nenhum na fila.
    for (const d of t.campaign_recipients) d.status = "sending";
    (t.campaign_recipients[0]!.contacts as Linha).is_blocked = true;
    t.campaigns[0]!.status = "running";
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r).toMatchObject({ detalhe: "rascunho_refeito", pulados: 1 });
    expect(p.enviados).toEqual([]);
    expect(t.campaign_recipients.map((d) => d.status)).toEqual(["opted_out", "pending", "pending"]);
    expect(t.campaigns[0]!.provider_broadcast_id).toBeNull();
  });

  it("todo mundo saiu: o rascunho é apagado e a campanha conclui sem mandar", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    await pausarComOsTelefonesSubindo(t, p);
    for (const d of t.campaign_recipients) (d.contacts as Linha).is_blocked = true;
    const [refez, depois] = await retomar(t);
    expect(refez!.detalhe).toBe("rascunho_refeito");
    expect(depois).toMatchObject({ concluidas: 1, detalhe: "concluida" });
    expect(p.enviados).toEqual([]);
    expect(t.campaigns[0]).toMatchObject({ status: "completed", provider_broadcast_id: null });
  });

  it("ninguém saiu: o rascunho é reaproveitado, sem apagar nem criar outro", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    await pausarComOsTelefonesSubindo(t, p);
    const [r] = await retomar(t);
    expect(r!.detalhe).toBe("transmissao:sending:3");
    expect(p.enviados.map((e) => e.id)).toEqual(["b1"]);
    expect(p.enviados[0]!.para).toHaveLength(3);
  });

  it("rascunho com alguém que não dá para ler é refeito: na dúvida, não sai", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    await pausarComOsTelefonesSubindo(t, p);
    const destinatarios = p.ops.destinatarios;
    mundo.ops = {
      ...p.ops,
      destinatarios: async (id, pagina) => {
        const r = await destinatarios(id, pagina);
        return { ...r, lidos: r.lidos + 1 };
      },
    };
    t.campaigns[0]!.status = "running";
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r.detalhe).toBe("rascunho_refeito");
    expect(p.enviados).toEqual([]);
  });

  it("página vazia sem total confirmado não é rascunho vazio: é refeito, nada sai", async () => {
    for (const total of [null, 3]) {
      const t = mundoCom(10, tres());
      const p = provedorComRascunho();
      await pausarComOsTelefonesSubindo(t, p);
      mundo.ops = { ...p.ops, destinatarios: async () => ({ itens: [], temMais: false, lidos: 0, total }) };
      t.campaigns[0]!.status = "running";
      const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
      expect(r.detalhe).toBe("rascunho_refeito");
      expect(p.enviados).toEqual([]);
    }
  });

  it("página vazia com total zero é rascunho vazio de verdade: reaproveita", async () => {
    const t = mundoCom(10, tres(), campanhaLinha({ provider_broadcast_id: "b1" }));
    const { ops, chamadas } = provedor();
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r.detalhe).toBe("transmissao:sending:3");
    expect(chamadas.descartar).toEqual([]);
    expect(chamadas.enviar).toBe(1);
  });

  it("alguém sai da fila entre a conferência e a reserva: não manda, refaz o rascunho", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    await pausarComOsTelefonesSubindo(t, p);
    t.campaign_recipients[1]!.status = "sending";
    const destinatarios = p.ops.destinatarios;
    mundo.ops = {
      ...p.ops,
      // A conferência passa com os 3; logo depois dela, o r1 sai pelo opt-out.
      destinatarios: async (id, pagina) => {
        const r = await destinatarios(id, pagina);
        t.campaign_recipients[0]!.status = "opted_out";
        return r;
      },
    };
    t.campaigns[0]!.status = "running";
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r.detalhe).toBe("rascunho_refeito");
    expect(p.enviados).toEqual([]);
    expect(p.rascunhos.has("b1")).toBe(false);
    expect(t.campaigns[0]!.provider_broadcast_id).toBeNull();
    expect(t.campaign_recipients.map((d) => d.status)).toEqual(["opted_out", "pending", "pending"]);
    expect(mundo.contados).toEqual([]);
  });

  describe("quem sai enquanto os telefones sobem, antes do envio", () => {
    /** A lista sobe; no meio da subida, `saida` tira alguém. */
    const rodadaCom = async (saida: (t: ReturnType<typeof mundoCom>) => void) => {
      const t = mundoCom(10, tres());
      const p = provedorComRascunho();
      const adicionar = p.ops.adicionar;
      mundo.ops = {
        ...p.ops,
        adicionar: async (id, telefones) => {
          const r = await adicionar(id, telefones);
          saida(t);
          return r;
        },
      };
      const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
      return { t, p, r };
    };
    const refezSemMandar = ({ t, p, r }: Awaited<ReturnType<typeof rodadaCom>>) => {
      expect(r.detalhe).toBe("rascunho_refeito");
      expect(p.enviados).toEqual([]);
      expect(p.rascunhos.has("b1")).toBe(false);
      expect(t.campaigns[0]!.provider_broadcast_id).toBeNull();
      expect(mundo.contados).toEqual([]);
    };

    it("o status mudou: descarta, devolve a fila e a pessoa fica de fora", async () => {
      const f = await rodadaCom((t) => {
        t.campaign_recipients[0]!.status = "opted_out";
      });
      refezSemMandar(f);
      expect(f.t.campaign_recipients.map((d) => d.status)).toEqual(["opted_out", "pending", "pending"]);
    });

    it("o veto da pessoa mudou, com o status ainda `sending`: mesma coisa", async () => {
      const f = await rodadaCom((t) => {
        (t.campaign_recipients[0]!.contacts as Linha).is_blocked = true;
      });
      refezSemMandar(f);
      expect(f.r.pulados).toBe(1);
      expect(f.t.campaign_recipients.map((d) => d.status)).toEqual(["opted_out", "pending", "pending"]);
    });

    it("o telefone da pessoa mudou, com o status ainda `sending`: o que subiu é o antigo, mesma coisa", async () => {
      const f = await rodadaCom((t) => {
        (t.campaign_recipients[0]!.contacts as Linha).phone_number = "+595981009999";
      });
      refezSemMandar(f);
      expect(f.t.campaign_recipients.map((d) => d.status)).toEqual(["pending", "pending", "pending"]);
    });

    it("entrou na lista de exclusão: mesma coisa", async () => {
      const f = await rodadaCom((t) => {
        t.campaign_suppressions = [{ organization_id: ORG, recipient_address_hash: hashDoEndereco("+595981000002") }];
      });
      refezSemMandar(f);
      expect(f.t.campaign_recipients.map((d) => d.status)).toEqual(["pending", "skipped", "pending"]);
    });

    it("no reaproveitamento do rascunho também: a releitura vem depois da conferência", async () => {
      const t = mundoCom(10, tres());
      const p = provedorComRascunho();
      await pausarComOsTelefonesSubindo(t, p);
      const adicionar = p.ops.adicionar;
      mundo.ops = {
        ...p.ops,
        adicionar: async (id, telefones) => {
          t.campaign_recipients[0]!.status = "opted_out";
          return adicionar(id, telefones);
        },
      };
      t.campaigns[0]!.status = "running";
      const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
      expect(r.detalhe).toBe("rascunho_refeito");
      expect(p.enviados).toEqual([]);
    });

    it("a releitura não dá para fazer: nada sai e a rodada cai", async () => {
      const t = mundoCom(10, tres());
      const p = provedorComRascunho();
      const adicionar = p.ops.adicionar;
      mundo.ops = {
        ...p.ops,
        adicionar: async (id, telefones) => {
          const r = await adicionar(id, telefones);
          mundo.erroNaListaDeExclusao = { message: "banco fora" };
          return r;
        },
      };
      await expect(rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA)).rejects.toThrow(/lista de exclusão/);
      expect(p.enviados).toEqual([]);
      expect(t.campaign_recipients.map((d) => d.status)).toEqual(["pending", "pending", "pending"]);
    });
  });

  it("última página sem total, ou com a conta que não fecha: é refeito, nada sai", async () => {
    for (const total of [null, 2, 4]) {
      const t = mundoCom(10, tres());
      const p = provedorComRascunho();
      await pausarComOsTelefonesSubindo(t, p);
      const destinatarios = p.ops.destinatarios;
      mundo.ops = {
        ...p.ops,
        destinatarios: async (id, pagina) => ({ ...(await destinatarios(id, pagina)), total }),
      };
      t.campaigns[0]!.status = "running";
      const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
      expect(r.detalhe).toBe("rascunho_refeito");
      expect(p.enviados).toEqual([]);
    }
  });

  it("a conta da última página soma o que as anteriores leram: duas páginas, total certo, reaproveita", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    await pausarComOsTelefonesSubindo(t, p);
    const todos = [...p.rascunhos.get("b1")!].map((tel) => item(tel, { status: "pending" }));
    mundo.ops = {
      ...p.ops,
      destinatarios: async (_id, { pular }) =>
        pular === 0
          ? { itens: todos.slice(0, 2), temMais: true, lidos: 2, total: 3 }
          : { itens: todos.slice(2), temMais: false, lidos: 1, total: 3 },
    };
    t.campaigns[0]!.status = "running";
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r.detalhe).toBe("transmissao:sending:3");
    expect(p.enviados.map((e) => e.id)).toEqual(["b1"]);
  });

  it("o provedor não leu o rascunho: a campanha pausa e nada sai", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    await pausarComOsTelefonesSubindo(t, p);
    mundo.ops = {
      ...p.ops,
      destinatarios: async () => {
        throw new ErroDaTransmissao(500, "http_500", "500 erro");
      },
    };
    t.campaigns[0]!.status = "running";
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r.detalhe).toBe("pausada:transmissao_http_500");
    expect(p.enviados).toEqual([]);
    expect(t.campaigns[0]).toMatchObject({ status: "paused", provider_broadcast_id: "b1" });
  });

  it("outra rodada já mandou o rascunho: não esquece o id nem cria outro", async () => {
    const t = mundoCom(10, tres());
    const p = provedorComRascunho();
    await pausarComOsTelefonesSubindo(t, p);
    (t.campaign_recipients[0]!.contacts as Linha).is_blocked = true;
    const ler = p.ops.ler;
    let lidas = 0;
    mundo.ops = {
      ...p.ops,
      // A 1ª leitura ainda vê rascunho; no meio da rodada, a outra manda.
      ler: async (id) => (lidas++ === 0 ? { estado: "draft" } : ler(id)),
      descartar: async () => {
        p.estados.set("b1", "sending");
        return false;
      },
    };
    t.campaigns[0]!.status = "running";
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, provider_broadcast_id: "b1" }, AGORA);
    expect(r.detalhe).toMatch(/^transmissao:sending:/);
    expect(t.campaigns[0]!.provider_broadcast_id).toBe("b1");
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
      destinatarios: async () => ({ itens: [item("+595981000001")], temMais: true, lidos: 1, total: 2 }),
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
        total: 2,
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
        total: 2,
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
      ler: async () => ({ estado: "sending" }),
      cancelar: async () => {
        throw new ErroDaTransmissao(500, "http_500", "500 erro");
      },
    }).ops;
    const fechados = await encerrarTransmissao(fakeAdmin(t), carregada(), AGORA);
    expect(fechados).toBe(3);
    expect(t.campaigns[0]).toMatchObject({ failure_code: "transmissao_cancelamento_recusado", failure_detail: DETALHE_CANCELAMENTO_RECUSADO });
  });

  describe("só o provedor dizer que terminou é parada", () => {
    /** O provedor responde `estados` a cada leitura, repetindo o último. */
    const lendo = (...estados: EstadoDaTransmissao[]) => {
      let i = 0;
      return { ler: async () => ({ estado: estados[Math.min(i++, estados.length - 1)]! }) };
    };
    const cancelada = () =>
      mundoCom(null, tres().map((d) => ({ ...d, status: "sending" })), campanhaLinha({ status: "cancelled", provider_broadcast_id: "b1" }));

    it.each(["sending", "scheduled"] as const)("em `%s`, cancela e, sem parar, avisa que o envio pode continuar", async (estado) => {
      const t = cancelada();
      const { ops, chamadas } = provedor(lendo(estado));
      mundo.ops = ops;
      expect(await encerrarTransmissao(fakeAdmin(t), carregada(), AGORA)).toBe(3);
      expect(chamadas.cancelar).toEqual(["b1"]);
      expect(chamadas.descartar).toEqual([]);
      expect(t.campaigns[0]).toMatchObject({
        failure_code: "transmissao_envio_pode_continuar",
        failure_detail: DETALHE_ENVIO_PODE_CONTINUAR,
      });
    });

    it("em `sending`, cancela e o provedor confirma: sem aviso", async () => {
      const t = cancelada();
      const { ops, chamadas } = provedor(lendo("sending", "cancelled"));
      mundo.ops = ops;
      await encerrarTransmissao(fakeAdmin(t), carregada(), AGORA);
      expect(chamadas.cancelar).toEqual(["b1"]);
      expect(t.campaigns[0]!.failure_code).toBeNull();
    });

    it.each(["completed", "failed", "cancelled"] as const)("em `%s` não há o que fazer: nem cancela, nem avisa", async (estado) => {
      const t = cancelada();
      const { ops, chamadas } = provedor(lendo(estado));
      mundo.ops = ops;
      await encerrarTransmissao(fakeAdmin(t), carregada(), AGORA);
      expect(chamadas.cancelar).toEqual([]);
      expect(chamadas.descartar).toEqual([]);
      expect(t.campaigns[0]!.failure_code).toBeNull();
    });

    it("descartar devolve false porque outra rodada mandou: cancela, e confirmada a parada não avisa", async () => {
      const t = cancelada();
      const { ops, chamadas } = provedor({ ...lendo("draft", "cancelled"), descartar: async () => false });
      mundo.ops = ops;
      await encerrarTransmissao(fakeAdmin(t), carregada(), AGORA);
      expect(chamadas.cancelar).toEqual(["b1"]);
      expect(t.campaigns[0]!.failure_code).toBeNull();
    });

    it("a última foto vem depois de parar, e rascunho apagado não pede relatório", async () => {
      const ordem: string[] = [];
      const passos = (estado: EstadoDaTransmissao) =>
        provedor({
          ler: async () => ({ estado }),
          cancelar: async () => void ordem.push("cancelar"),
          destinatarios: async () => {
            ordem.push("relatorio");
            return { itens: [], temMais: false, lidos: 0, total: 0 };
          },
        }).ops;
      mundo.ops = passos("sending");
      await encerrarTransmissao(fakeAdmin(cancelada()), carregada(), AGORA);
      expect(ordem).toEqual(["cancelar", "relatorio"]);

      ordem.length = 0;
      mundo.ops = passos("draft");
      await encerrarTransmissao(fakeAdmin(cancelada()), carregada(), AGORA);
      expect(ordem).toEqual([]);
    });

    it("cancelada com os telefones subindo e outra rodada já mandou: a rodada também cancela e avisa", async () => {
      const t = mundoCom(10, tres());
      const { ops, chamadas } = provedor({
        ...lendo("sending"),
        adicionar: async (_id, telefones) => {
          t.campaigns[0]!.status = "cancelled";
          return { adicionados: telefones.length, pulados: 0 };
        },
      });
      mundo.ops = ops;
      const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
      expect(r.detalhe).toBe("parada_antes_de_mandar:cancelled");
      expect(chamadas.cancelar).toEqual(["b1"]);
      expect(t.campaigns[0]).toMatchObject({
        failure_code: "transmissao_envio_pode_continuar",
        failure_detail: DETALHE_ENVIO_PODE_CONTINUAR,
      });
    });
  });

  describe("uma frase só, com tudo o que há para conferir", () => {
    it("cada frase de parada não confirmada fala do envio e do rascunho", () => {
      for (const frase of [DETALHE_CANCELAMENTO_RECUSADO, DETALHE_CANCELAMENTO_SEM_CONEXAO, DETALHE_ENVIO_PODE_CONTINUAR]) {
        expect(frase).toMatch(/o envio pode continuar/);
        expect(frase).toMatch(/apague o rascunho/);
      }
    });

    it("a tela traduz a frase pela frase inteira: as quatro têm espanhol", () => {
      for (const frase of [
        DETALHE_CANCELAMENTO_RECUSADO,
        DETALHE_CANCELAMENTO_SEM_CONEXAO,
        DETALHE_ENVIO_PODE_CONTINUAR,
        DETALHE_RASCUNHO_NAO_APAGADO,
      ]) {
        expect(traduzir(frase, "es")).not.toBe(frase);
      }
    });

    it("estado que não dá para ler e cancelamento recusado: fica o aviso do provedor, que cobre o rascunho", async () => {
      const t = mundoCom(null, tres(), campanhaLinha({ status: "cancelled", provider_broadcast_id: "b1" }));
      mundo.ops = provedor({
        ler: async () => {
          throw new ErroDaTransmissao(503, "http_503", "503 fora do ar");
        },
        cancelar: async () => {
          throw new ErroDaTransmissao(503, "http_503", "503 fora do ar");
        },
      }).ops;
      await encerrarTransmissao(fakeAdmin(t), carregada(), AGORA);
      expect(t.campaigns[0]).toMatchObject({
        failure_code: "transmissao_cancelamento_recusado",
        failure_detail: DETALHE_CANCELAMENTO_RECUSADO,
      });
    });

    it("rascunho que o provedor não apagou: o aviso do rascunho não some, e ninguém tenta cancelar o que não sai", async () => {
      const t = mundoCom(null, tres(), campanhaLinha({ status: "cancelled", provider_broadcast_id: "b1" }));
      const { ops, chamadas } = provedor({
        descartar: async () => {
          throw new ErroDaTransmissao(500, "http_500", "500 erro");
        },
      });
      mundo.ops = ops;
      await encerrarTransmissao(fakeAdmin(t), carregada(), AGORA);
      expect(chamadas.cancelar).toEqual([]);
      expect(t.campaigns[0]!.failure_detail).toBe(DETALHE_RASCUNHO_NAO_APAGADO);
    });
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

  it("cancelar com a lista no rascunho apaga o rascunho; com a transmissão em envio, não", async () => {
    const emRascunho = mundoCom(null, tres(), campanhaLinha({ status: "cancelled", provider_broadcast_id: "b1" }));
    const rascunho = provedor();
    mundo.ops = rascunho.ops;
    await encerrarTransmissao(fakeAdmin(emRascunho), carregada(), AGORA);
    expect(rascunho.chamadas.descartar).toEqual(["b1"]);

    const emEnvio = mundoCom(null, tres(), campanhaLinha({ status: "cancelled", provider_broadcast_id: "b1" }));
    const saindo = provedor({ ler: async () => ({ estado: "sending" }) });
    mundo.ops = saindo.ops;
    await encerrarTransmissao(fakeAdmin(emEnvio), carregada(), AGORA);
    expect(saindo.chamadas.descartar).toEqual([]);
  });

  it("o rascunho não foi apagado: quem cancelou fica sabendo", async () => {
    const recusas: Array<[Partial<OpsDeTransmissao>, string, string]> = [
      [
        {
          descartar: async () => {
            throw new ErroDaTransmissao(500, "http_500", "500 erro");
          },
        },
        "transmissao_rascunho_nao_apagado",
        DETALHE_RASCUNHO_NAO_APAGADO,
      ],
      [{ descartar: async () => false }, "transmissao_envio_pode_continuar", DETALHE_ENVIO_PODE_CONTINUAR],
      [
        {
          ler: async () => {
            throw new ErroDaTransmissao(503, "http_503", "503 fora do ar");
          },
        },
        "transmissao_envio_pode_continuar",
        DETALHE_ENVIO_PODE_CONTINUAR,
      ],
    ];
    const log = vi.spyOn(logger, "warn");
    for (const [recusa, codigo, frase] of recusas) {
      log.mockClear();
      const t = mundoCom(null, tres(), campanhaLinha({ status: "cancelled", provider_broadcast_id: "b1" }));
      mundo.ops = provedor(recusa).ops;
      expect(await encerrarTransmissao(fakeAdmin(t), carregada(), AGORA)).toBe(3);
      expect(t.campaigns[0]).toMatchObject({ failure_code: codigo, failure_detail: frase });
      expect(log).toHaveBeenCalledWith(
        "[campanha] parada da transmissão cancelada não confirmada",
        expect.objectContaining({ campanha: "c1", transmissao: "b1", codigo }),
      );
    }
    log.mockRestore();
  });

  it("cancelada com os telefones subindo: a rodada apaga o rascunho, e avisa se não conseguir", async () => {
    const rodada = async (over: Partial<OpsDeTransmissao>) => {
      const t = mundoCom(10, tres());
      const { ops, chamadas } = provedor({
        ...over,
        adicionar: async (_id, telefones) => {
          t.campaigns[0]!.status = "cancelled";
          return { adicionados: telefones.length, pulados: 0 };
        },
      });
      mundo.ops = ops;
      const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
      expect(r.detalhe).toBe("parada_antes_de_mandar:cancelled");
      expect(chamadas.enviar).toBe(0);
      expect(t.campaign_recipients.every((d) => d.status === "cancelled")).toBe(true);
      return { t, chamadas };
    };

    const apagou = await rodada({});
    expect(apagou.chamadas.descartar).toEqual(["b1"]);
    expect(apagou.t.campaigns[0]!.failure_code).toBeNull();

    const recusou = await rodada({
      descartar: async () => {
        throw new ErroDaTransmissao(500, "http_500", "500 erro");
      },
    });
    expect(recusou.t.campaigns[0]).toMatchObject({
      failure_code: "transmissao_rascunho_nao_apagado",
      failure_detail: DETALHE_RASCUNHO_NAO_APAGADO,
    });
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
    expect(chamadas.descartar).toEqual(["b1"]);
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

// ─── Revisão depois do merge do #3126 ────────────────────────────────────────

describe("`sending` sem id de transmissão não é reserva do broadcast", () => {
  /** A rodada gradual reservou o r1 e a campanha trocou para broadcast. */
  const comR1SaindoPelaRodadaDeSempre = () => {
    const lista = tres();
    lista[0]!.status = "sending";
    return mundoCom(10, lista);
  };

  it("a lista não sai: quem podia estar saindo não recebe de novo, e a campanha pausa com a frase", async () => {
    const t = comR1SaindoPelaRodadaDeSempre();
    const { ops, chamadas } = provedor();
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r.detalhe).toBe("pausada:transmissao_envio_em_voo");
    expect(chamadas.criar).toBe(0);
    expect(chamadas.adicionados).toEqual([]);
    expect(chamadas.enviar).toBe(0);
    expect(t.campaigns[0]).toMatchObject({ status: "paused", failure_code: "transmissao_envio_em_voo" });
    expect(t.campaigns[0]!.failure_detail).toBe(DETALHE_ENVIO_EM_VOO);
    expect(t.campaign_recipients.map((d) => d.status)).toEqual(["sending", "pending", "pending"]);
  });

  it("depois que o envio antigo termina, a retomada entrega só quem falta", async () => {
    const t = comR1SaindoPelaRodadaDeSempre();
    const { ops, chamadas } = provedor();
    mundo.ops = ops;
    await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    t.campaign_recipients[0]!.status = "sent";
    t.campaigns[0]!.status = "running";
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r.detalhe).toBe("transmissao:sending:2");
    expect(chamadas.adicionados).toEqual(["+595981000002", "+595981000003"]);
  });

  it("a rodada de sempre reserva logo depois da conferência: quem ela reservou fica fora da lista", async () => {
    const t = mundoCom(10, tres());
    const { ops, chamadas } = provedor();
    mundo.ops = ops;
    const admin = fakeAdmin(t) as unknown as { from: (tabela: string) => unknown };
    let leituras = 0;
    const comACorrida = {
      from: (tabela: string) => {
        // A 1ª leitura é a conferência; a reserva alheia cai antes da 2ª.
        if (tabela === "campaign_recipients" && ++leituras === 2) t.campaign_recipients[0]!.status = "sending";
        return admin.from(tabela);
      },
    };
    const r = await rodarCampanhaEmTransmissao(comACorrida as never, CAMPANHA, AGORA);
    expect(r.detalhe).toBe("transmissao:sending:2");
    expect(chamadas.adicionados).toEqual(["+595981000002", "+595981000003"]);
  });

  it("o `sending` é de uma rodada sobreposta, que já gravou o id: não pausa nem cria outra", async () => {
    const t = comR1SaindoPelaRodadaDeSempre();
    t.campaigns[0]!.provider_broadcast_id = "b9";
    const { ops, chamadas } = provedor();
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(r.detalhe).toBe("ja_entregue");
    expect(chamadas.criar).toBe(0);
    expect(t.campaigns[0]!.status).toBe("running");
  });
});

describe("o volume do broadcast entra uma vez no ritmo do número", () => {
  const todos = ["+595981000001", "+595981000002", "+595981000003"];
  const relatorio = (x: Partial<DestinatarioDaTransmissao> = {}) =>
    provedor({
      ler: async () => ({ estado: "sending" }),
      destinatarios: async () => ({
        itens: todos.map((f) => item(f, { status: "sent", ...x })),
        temMais: false,
        lidos: 3,
        total: 3,
      }),
    }).ops;
  const jaEntregue = () =>
    mundoCom(10, tres().map((d) => ({ ...d, status: "sending" })), campanhaLinha({ provider_broadcast_id: "b1" }));
  const COM_ID = { ...CAMPANHA, provider_broadcast_id: "b1" };

  it("o livro falhou depois de mandar: a lista não volta à fila, e a rodada seguinte conta", async () => {
    const t = mundoCom(10, tres());
    mundo.ops = provedor().ops;
    mundo.livroFalha = true;
    const primeira = await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    expect(primeira.enviadas).toBe(3);
    expect(t.campaign_recipients.map((d) => d.status)).toEqual(["sending", "sending", "sending"]);
    expect(mundo.contados).toEqual([]);

    mundo.livroFalha = false;
    mundo.ops = relatorio();
    await rodarCampanhaEmTransmissao(fakeAdmin(t), COM_ID, AGORA);
    expect(mundo.contados).toEqual([3]);
  });

  it("a rodada caiu entre mandar e contar: quem acompanha conta, na hora em que o provedor mandou", async () => {
    const t = jaEntregue();
    mundo.ops = relatorio({ enviadoEm: "2026-11-02T13:50:00.000Z" });
    await rodarCampanhaEmTransmissao(fakeAdmin(t), COM_ID, AGORA);
    expect(mundo.contados).toEqual([3]);
    expect(mundo.datasDoLivro).toEqual([new Date("2026-11-02T13:50:00.000Z")]);
  });

  it("contado ao mandar, não conta de novo a cada rodada de acompanhamento", async () => {
    const t = mundoCom(10, tres());
    mundo.ops = provedor().ops;
    await rodarCampanhaEmTransmissao(fakeAdmin(t), CAMPANHA, AGORA);
    mundo.ops = relatorio();
    await rodarCampanhaEmTransmissao(fakeAdmin(t), COM_ID, AGORA);
    await rodarCampanhaEmTransmissao(fakeAdmin(t), COM_ID, AGORA);
    expect(mundo.contados).toEqual([3]);
    expect([...mundo.lotes.keys()]).toEqual(["c1:b1"]);
  });

  it("o livro fora do ar não derruba o acompanhamento", async () => {
    const t = jaEntregue();
    mundo.ops = relatorio();
    mundo.livroFalha = true;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), COM_ID, AGORA);
    expect(r.detalhe).toMatch(/^transmissao:sending:/);
    expect(t.campaign_recipients[0]!.status).toBe("sent");
  });
});

describe("o máximo da campanha desconta o que ela já mandou", () => {
  const HOJE_CEDO = "2026-11-02T04:00:00.000Z"; // 1h em Assunção, fora da última hora
  const HA_MEIA_HORA = "2026-11-02T13:30:00.000Z";
  const enviadas = (quantas: number, em: string) =>
    Array.from({ length: quantas }, (_, i) => ({ ...destinatario(`e${i}`, `+59598200${i}`, "sent"), sent_at: em }));

  it("o dia: 3 cabem no máximo de 5, mas 3 já saíram hoje — pausa antes de criar", async () => {
    const t = mundoCom(null, [...enviadas(3, HOJE_CEDO), ...tres()]);
    const { ops, chamadas } = provedor();
    mundo.ops = ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, teto_diario: 5 }, AGORA);
    expect(r.detalhe).toBe("pausada:transmissao_acima_do_teto:3>2");
    expect(t.campaigns[0]!.failure_detail).toBe(DETALHE_ACIMA_DO_TETO_DA_CAMPANHA);
    expect(chamadas.criar).toBe(0);
  });

  it("a hora: o que saiu cedo não gasta a hora, o que saiu há meia hora gasta", async () => {
    const cedo = mundoCom(null, [...enviadas(3, HOJE_CEDO), ...tres()]);
    mundo.ops = provedor().ops;
    expect((await rodarCampanhaEmTransmissao(fakeAdmin(cedo), { ...CAMPANHA, teto_horario: 3 }, AGORA)).enviadas).toBe(3);

    const recente = mundoCom(null, [...enviadas(1, HA_MEIA_HORA), ...tres()]);
    mundo.ops = provedor().ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(recente), { ...CAMPANHA, teto_horario: 3 }, AGORA);
    expect(r.detalhe).toBe("pausada:transmissao_acima_do_teto:3>2");
  });

  it("ontem não conta: o máximo por dia é do dia de hoje", async () => {
    const t = mundoCom(null, [...enviadas(3, "2026-11-01T20:00:00.000Z"), ...tres()]);
    mundo.ops = provedor().ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, teto_diario: 5 }, AGORA);
    expect(r.enviadas).toBe(3);
  });

  it("acima de 1.000 enviadas a conta não para no teto de linhas do PostgREST", async () => {
    const t = mundoCom(null, [...enviadas(1_200, HOJE_CEDO), ...tres()]);
    mundo.ops = provedor().ops;
    const r = await rodarCampanhaEmTransmissao(fakeAdmin(t), { ...CAMPANHA, teto_diario: 1_202 }, AGORA);
    expect(r.detalhe).toBe("pausada:transmissao_acima_do_teto:3>2");
  });

  it("a regra pura desconta o dia e a hora, e nunca devolve livre negativo", () => {
    const base = {
      tamanho: 5,
      limiteDoNumero: null,
      enviadosHojeNoNumero: 0,
      tetoDiarioDaCampanha: 10,
      tetoHorarioDaCampanha: 8,
      enviadasHojeNaCampanha: 0,
      enviadasNaHoraNaCampanha: 0,
    };
    expect(tetoDaTransmissao(base)).toEqual({ cabe: true });
    expect(tetoDaTransmissao({ ...base, enviadasHojeNaCampanha: 6 })).toEqual({ cabe: false, de: "campanha", livre: 4 });
    expect(tetoDaTransmissao({ ...base, enviadasNaHoraNaCampanha: 4 })).toEqual({ cabe: false, de: "campanha", livre: 4 });
    expect(tetoDaTransmissao({ ...base, enviadasHojeNaCampanha: 99 })).toEqual({ cabe: false, de: "campanha", livre: 0 });
  });
});
