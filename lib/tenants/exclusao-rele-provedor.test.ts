/**
 * O PROVEDOR É RELIDO ANTES DA TRAVA DE ASSINATURA VIVA (#2626).
 *
 * O gatilho `trg_cobranca_trava_exclusao_com_assinatura_viva` (migration 0601,
 * linhas 347 a 372) decide pela LINHA de `cobranca_assinaturas` — o que a
 * última releitura gravou —, e o comentário da própria 0601 (linha 340) diz que
 * quem exclui pelo painel relê o provedor ANTES (`lerSituacao`). O
 * `lib/tenants/exclusao.ts` não fazia essa releitura: a assinatura que voltou a
 * ficar viva depois da última gravação passava pela trava.
 *
 * Este arquivo mede a ordem na porta de entrada do painel:
 *
 *   1. o provedor é relido NA HORA — outro resultado que o gravado;
 *   2. a releitura é GRAVADA na linha;
 *   3. só então a rpc `fn_excluir_organizacao` dispara a trava, que lê essa linha.
 *
 * O gatilho de verdade não cabe num teste unitário: aqui a rpc é um DUBLÊ que
 * repete a fórmula da 0601 (`provedor is not null and (assinaturas_vivas > 1 or
 * (assinaturas_vivas = 1 and not cancela_no_fim))`) sobre a linha que o banco
 * tem naquele instante, e devolve o mesmo `PT409
 * organizacao_com_assinatura_viva`. A trava real está provada contra Postgres em
 * `tests/invariants/cobranca-exclusao-com-assinatura-viva.test.ts`
 * (`pnpm test:db`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

import type { Situacao } from "@/lib/cobranca/provedores/contrato";

const h = vi.hoisted(() => ({
  /** O `lerSituacao` do provedor, mockado: o teste decide o que ele responde. */
  ler: vi.fn(),
  /** A ordem em que os passos acontecem, na ordem em que aconteceram. */
  ordem: [] as string[],
  /** O que a trava (a rpc) LEU da linha — é ela que decide. */
  viuNaTrava: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => {
    h.ordem.push("audit");
  }),
}));
vi.mock("@/lib/channels/desligar-da-organizacao", () => ({
  inventarioDaLapide: vi.fn((linhas: Array<{ id: string }>) => ({
    canais: linhas.map((l) => ({ id: l.id, provider: "p", wahaSessionName: `sessao-${l.id}`, meta: null })),
    sessaoDeVoz: null,
  })),
  inventariarCanaisDaOrganizacao: vi.fn(async () => {
    h.ordem.push("canais.inventario");
    return { canais: [{ id: "canal-1", provider: "qr", wahaSessionName: "s1", meta: null }], sessaoDeVoz: null };
  }),
  desligarCanaisInventariados: vi.fn(async () => {
    h.ordem.push("canais.desligar");
    return [{ id: "canal-1", provedor: "qr", desfecho: "ok" }];
  }),
}));
vi.mock("@/lib/wacalls/client", () => ({ getWacallsClient: () => null }));
vi.mock("@/lib/voice/desparear", () => ({ desligarSessaoDeVozNoTransporte: vi.fn(async () => undefined) }));
vi.mock("@/lib/nuvemshop/api-client", () => ({ NuvemshopApiClient: class {} }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => "tok") }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
// A releitura passa pelo adaptador de produção — só o que ela RESPONDE é do
// teste. O passo "releitura" é registrado aqui: é ele que a ordem mede.
vi.mock("@/lib/cobranca/provedores", () => ({
  adaptador: () => ({
    lerSituacao: (p: { clienteRef: string }) => {
      h.ordem.push("releitura");
      return h.ler(p);
    },
  }),
}));
vi.mock("@/lib/cobranca/configuracao", () => ({ toleranciaDias: async () => 7 }));
vi.mock("@/lib/cobranca/emails", () => ({ enviarAvisoAosAdmins: vi.fn() }));

import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";
import { logger } from "@/lib/logger";

import { excluirOrganizacao } from "./exclusao";

const ORG = "7e0a0000-0000-4000-8000-0000000000ee";
const ATOR = "7e0a1111-0000-4000-8000-0000000000ff";
const AGORA = new Date("2026-10-10T12:00:00Z");
const ha = (horas: number) => new Date(AGORA.getTime() - horas * 3_600_000).toISOString();

/** A linha gravada — o que a ÚLTIMA releitura deixou. Os testes mudam só as vivas. */
const GRAVADA = {
  organization_id: ORG,
  plano_id: "plano-a",
  plano_agendado_id: null,
  estado: "ativa",
  trial_ate: null,
  provedor: "stripe",
  provedor_cliente_id: "cus_1",
  provedor_assinatura_id: "sub_1",
  vencida_desde: null,
  proximo_vencimento: "2026-11-01T00:00:00.000Z",
  cancela_no_fim: false,
  prazo_extra_ate: null,
  ultimo_aviso: null,
  ultimo_aviso_em: null,
  relida_em: ha(48),
  link_de_pagamento: null,
  assinaturas_vivas: 0,
  ultimo_erro: null,
  ultimo_erro_em: null,
  checkout_url: null,
  checkout_expira_em: null,
  updated_at: ha(48),
};

const EMPRESA = {
  id: ORG,
  slug: "acme",
  status: "suspended",
  suspended_kind: "administrativa",
  locale: "pt-BR",
  timezone: "America/Sao_Paulo",
};

function situacao(p: Partial<Situacao> = {}): Situacao {
  return {
    assinaturaRef: "sub_1",
    existe: true,
    assinaturasVivas: 1,
    cancelada: false,
    cancelaNoFim: false,
    emAtraso: false,
    vencidaDesde: null,
    proximoVencimento: new Date("2026-11-01T00:00:00Z"),
    jaPagou: true,
    emTesteNoProvedorAte: null,
    pagamentoSemAssinaturaViva: false,
    linkDePagamento: null,
    statusBruto: "active",
    ...p,
  };
}

interface Mundo {
  empresa: Record<string, unknown> | null;
  linha: Record<string, unknown> | null;
}
let m: Mundo;
let banco: BancoFalso;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "organizations") return { data: m.empresa };
  if (c.tabela === "api_audit_log") return { data: [] };
  if (c.tabela === "tenant_integrations") return { data: null };
  if (c.tabela === "agent_inbox_items") return { data: null };
  if (c.tabela !== "cobranca_assinaturas") throw new Error(`tabela inesperada: ${c.tabela}`);
  if (operacao(c) === "select") return { data: m.linha };
  // A gravação da releitura (compare-and-set, ou só `ultimo_erro` quando o
  // provedor falha): é ESTA linha que a trava vai ler em seguida.
  const campos = argumentos(c, "update")?.[0] as Record<string, unknown>;
  if (m.linha) m.linha = { ...m.linha, ...campos };
  h.ordem.push("gravacao");
  return { data: { organization_id: ORG } };
}

/**
 * A rpc da exclusão, com a fórmula da trava da 0601 por dentro: ela lê a linha
 * de `cobranca_assinaturas` do momento e recusa com o mesmo `PT409`.
 */
function rpc(nome: string): Resposta {
  if (nome === "fn_arquivos_da_organizacao" || nome === "fn_logins_sem_vinculo") return { data: [] };
  if (nome !== "fn_excluir_organizacao") throw new Error(`rpc inesperada: ${nome}`);
  h.ordem.push("trava");
  const l = m.linha;
  h.viuNaTrava = l;
  const viva =
    l !== null &&
    l.provedor !== null &&
    (Number(l.assinaturas_vivas) > 1 || (Number(l.assinaturas_vivas) === 1 && l.cancela_no_fim !== true));
  if (viva) return { data: null, error: { code: "PT409", message: "organizacao_com_assinatura_viva" } };
  m.empresa = null;
  m.linha = null;
  return { data: { slug: "acme", contagens: { membros: 2 }, usuarios_removiveis: [] }, error: null };
}

function admin() {
  return {
    ...banco.cliente,
    storage: {
      from: (bucket: string) => ({
        remove: async (nomes: string[]) => {
          h.ordem.push(`storage:${bucket}:${nomes.length}`);
          return { error: null };
        },
      }),
    },
    auth: { admin: { deleteUser: async () => ({ error: null }) } },
  };
}

const entrada = {
  orgId: ORG,
  atorId: ATOR,
  confirmacao: "acme",
  motivo: "contrato encerrado pelo cliente",
  requestId: "req-2626",
};

/** Índice de um passo na ordem — com a mensagem, se não aconteceu. */
const pos = (p: string): number => {
  const i = h.ordem.indexOf(p);
  expect(i, `passo "${p}" não aconteceu; ordem: ${h.ordem.join(" → ")}`).toBeGreaterThanOrEqual(0);
  return i;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.ordem.length = 0;
  h.viuNaTrava = null;
  h.ler.mockReset();
  m = { empresa: { ...EMPRESA }, linha: { ...GRAVADA } };
  banco = bancoFalso(responder, rpc);
});

describe("excluir tenant pelo painel: o provedor é relido antes da trava de assinatura viva", () => {
  it("⭐ a gravação dizia ZERO vivas e o provedor responde 1: a releitura de hoje é gravada, a trava lê e RECUSA", async () => {
    expect(m.linha!.assinaturas_vivas).toBe(0);
    h.ler.mockResolvedValue(situacao({ assinaturasVivas: 1 }));

    await expect(excluirOrganizacao(admin() as never, entrada)).rejects.toMatchObject({
      codigo: "exclusao_com_assinatura_viva",
    });

    // Outro resultado que o anterior: 0 gravado, 1 relido — e a trava viu 1.
    expect(h.ler).toHaveBeenCalledTimes(1);
    expect(h.ler).toHaveBeenCalledWith({ clienteRef: "cus_1" });
    expect(m.linha!.assinaturas_vivas).toBe(1);
    expect(h.viuNaTrava).toMatchObject({ assinaturas_vivas: 1 });
    // A ordem: reler, gravar e só ENTÃO disparar a trava.
    expect(pos("releitura")).toBeLessThan(pos("gravacao"));
    expect(pos("gravacao")).toBeLessThan(pos("trava"));
    // A recusa veio da trava, antes de qualquer coisa: nada externo foi tocado.
    expect(h.ordem).not.toContain("canais.desligar");
    expect(h.ordem).not.toContain("audit");
  });

  it("⭐ a gravação dizia 1 VIVA e o provedor responde 0: a releitura fresca é a que libera — e a trava roda depois dela", async () => {
    m.linha = { ...GRAVADA, assinaturas_vivas: 1, cancela_no_fim: false };
    h.ler.mockResolvedValue(situacao({ assinaturasVivas: 0, existe: false, cancelada: true, statusBruto: "canceled" }));

    const r = await excluirOrganizacao(admin() as never, entrada);

    expect(r.slug).toBe("acme");
    // Outro resultado que o anterior: 1 gravado, 0 relido — e a trava viu 0.
    expect(h.viuNaTrava).toMatchObject({ assinaturas_vivas: 0 });
    expect(pos("releitura")).toBeLessThan(pos("gravacao"));
    expect(pos("gravacao")).toBeLessThan(pos("trava"));
    expect(pos("trava")).toBeLessThan(pos("canais.desligar"));
    expect(h.ordem.at(-1)).toBe("audit");
  });

  it.each([
    ["viva", 1],
    ["sem assinatura viva", 0],
  ])("provedor fora com a última gravação %s: a exclusão RECUSA (503) sem chegar à trava — nada é apagado pelo estado velho", async (_n, vivas) => {
    m.linha = { ...GRAVADA, assinaturas_vivas: vivas, cancela_no_fim: false };
    h.ler.mockRejectedValue(new ErroDoProvedor(503, "stripe_5xx", true));

    await expect(excluirOrganizacao(admin() as never, entrada)).rejects.toMatchObject({
      codigo: "provedor_indisponivel",
    });

    expect(h.ler).toHaveBeenCalledTimes(1);
    // A falha não apaga o estado gravado, e a exclusão nem chega à rpc.
    expect(m.linha).toMatchObject({ assinaturas_vivas: vivas, ultimo_erro: "provedor_fora" });
    expect(h.ordem).not.toContain("trava");
    expect(h.ordem).not.toContain("canais.inventario");
    const avisos = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
    expect(avisos.some((a) => a.includes("cobranca.leitura_falhou"))).toBe(true);
  });

  it("empresa sem linha de cobrança: nenhum chamado ao provedor, e a exclusão segue a mesma ordem de sempre", async () => {
    m.linha = null;

    const r = await excluirOrganizacao(admin() as never, entrada);

    expect(r.slug).toBe("acme");
    expect(h.ler).not.toHaveBeenCalled();
    expect(h.ordem).not.toContain("gravacao");
    expect(pos("trava")).toBeLessThan(pos("canais.desligar"));
    expect(h.ordem.at(-1)).toBe("audit");
  });
});
