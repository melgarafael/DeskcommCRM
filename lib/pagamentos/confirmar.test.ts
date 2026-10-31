import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  argumentos,
  bancoFalso,
  operacao,
  type BancoFalso,
  type Cadeia,
  type Resposta,
} from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ erro: vi.fn(), aviso: vi.fn(), auditorias: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.aviso, error: h.erro, info: vi.fn() } }));
vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    h.auditorias.push(entrada);
  },
}));

import { confirmarPagamento } from "./confirmar";
import type { Recebimento } from "./registrar";

const ORG = "cccccccc-0000-4000-8000-000000000001";
const CONV = "cccccccc-0000-4000-8000-000000000002";
const MSG = "cccccccc-0000-4000-8000-000000000003";
const LEAD = "cccccccc-0000-4000-8000-000000000004";
const REC = "cccccccc-0000-4000-8000-000000000005";
const ETAPA_GANHO = "cccccccc-0000-4000-8000-000000000007";
const ETAPA_ATUAL = "cccccccc-0000-4000-8000-000000000008";
const PIPELINE = "cccccccc-0000-4000-8000-000000000009";
const CONTATO = "cccccccc-0000-4000-8000-00000000000a";

const QUANDO = new Date("2026-10-27T12:00:00Z");

const pendente = (over: Partial<Recebimento> = {}): Recebimento => ({
  id: REC,
  organization_id: ORG,
  conversation_id: CONV,
  message_id: MSG,
  lead_id: LEAD,
  provedor: "infinitepay",
  external_id: "pay_123",
  valor_cents: 15000,
  moeda: "BRL",
  status: "pendente",
  pago_em: null,
  ...over,
});

interface Mundo {
  linhas: Recebimento[];
  cas: Resposta;
  moveu: Resposta;
  etapa: { id: string; name: string } | null;
  lead: {
    id: string;
    stage_id: string | null;
    pipeline_id: string | null;
    status: string;
    contact_id: string | null;
    custom_fields?: Record<string, unknown> | null;
  } | null;
  /** O status que a SEGUNDA leitura do negócio vê (a do fecho compartilhado). */
  statusNoFecho?: string;
  /** `crm_pipelines.settings` — é dele que a régua de campos obrigatórios lê. */
  settings: Record<string, unknown> | null;
  mensagem: { id: string; metadata: Record<string, unknown> | null } | null;
  atividade: Resposta;
}

let m: Mundo;
let banco: BancoFalso;
let leiturasDoNegocio = 0;

function responder(c: Cadeia): Resposta {
  const op = operacao(c);
  if (c.tabela === "pagamento_recebimentos") {
    if (op === "update") return m.cas;
    return { data: m.linhas };
  }
  if (c.tabela === "messages") {
    if (op === "update") return { data: null };
    return { data: m.mensagem };
  }
  if (c.tabela === "crm_stages") return { data: m.etapa };
  if (c.tabela === "crm_leads") {
    if (op === "update") return m.moveu;
    leiturasDoNegocio += 1;
    if (leiturasDoNegocio > 1 && m.lead && m.statusNoFecho) return { data: { ...m.lead, status: m.statusNoFecho } };
    return { data: m.lead };
  }
  if (c.tabela === "crm_pipelines") return { data: { settings: m.settings } };
  if (c.tabela === "crm_lead_activities") return m.atividade;
  return {};
}

const cadeias = (tabela: string) => banco.cadeias.filter((c) => c.tabela === tabela);
const escritas = (tabela: string) => cadeias(tabela).filter((c) => operacao(c) !== "select");

beforeEach(() => {
  vi.clearAllMocks();
  h.auditorias = [];
  leiturasDoNegocio = 0;
  m = {
    linhas: [pendente()],
    cas: { data: [{ id: REC }] },
    moveu: { data: [{ id: LEAD }] },
    etapa: { id: ETAPA_GANHO, name: "Pago" },
    lead: { id: LEAD, stage_id: ETAPA_ATUAL, pipeline_id: PIPELINE, status: "open", contact_id: CONTATO },
    mensagem: {
      id: MSG,
      metadata: {
        pagamento: {
          provedor: "infinitepay",
          id: "pay_123",
          valor: 15000,
          moeda: "BRL",
          status: "pendente",
          recebimento_id: REC,
        },
      },
    },
    atividade: { data: null },
    settings: null,
  };
  banco = bancoFalso(responder);
});

const pedido = { provedor: "infinitepay", externalId: "pay_123", quando: QUANDO };

describe("confirmar o pagamento", () => {
  it("⭐ aviso válido: marca paga UMA vez, move o negócio e escreve uma linha na timeline", async () => {
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r).toMatchObject({ ok: true, efeito: "pago" });
    if (!r.ok || r.efeito !== "pago") return;
    expect(r.recebimento.status).toBe("paga");
    expect(r.movido).toEqual({ moveu: true });

    // O compare-and-set: o filtro LEVA `status = 'pendente'` — é ele que faz a
    // segunda entrega não encontrar linha nenhuma.
    const cas = argumentos(cadeias("pagamento_recebimentos").find((c) => operacao(c) === "update")!, "update")?.[0];
    expect(cas).toMatchObject({ status: "paga" });
    const filtro = cadeias("pagamento_recebimentos").find((c) => operacao(c) === "update")!;
    expect(filtro.passos.filter((p) => p.metodo === "eq").map((p) => p.args)).toContainEqual(["status", "pendente"]);

    // O ponteiro da conversa acompanha.
    const patch = argumentos(cadeias("messages").find((c) => operacao(c) === "update")!, "update")?.[0] as {
      metadata: { pagamento: { status: string } };
    };
    expect(patch.metadata.pagamento.status).toBe("paga");

    // A timeline: UMA linha de pagamento, com o tipo próprio e o valor.
    const linhas = cadeias("crm_lead_activities").map(
      (c) => argumentos(c, "insert")?.[0] as { type: string; reason: string; payload: { movimento: { moveu: boolean } } },
    );
    const atividades = linhas.find((l) => l.type === "payment_confirmed")!;
    expect(linhas.filter((l) => l.type === "payment_confirmed")).toHaveLength(1);
    expect(atividades.reason).toContain("Pagamento confirmado");
    expect(atividades.payload.movimento.moveu).toBe(true);
  });

  it("⭐ evento REPETIDO (já pago): nada muda — sem update, sem etapa, sem segunda linha na timeline", async () => {
    m.linhas = [pendente({ status: "paga", pago_em: QUANDO.toISOString() })];
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r).toEqual({ ok: true, efeito: "duplicado", status: "paga" });
    expect(escritas("pagamento_recebimentos")).toEqual([]);
    expect(escritas("crm_leads")).toEqual([]);
    expect(cadeias("crm_lead_activities")).toEqual([]);
  });

  it("⭐ CORRIDA: o compare-and-set atualiza zero linhas (outra entrega chegou antes) — nada acontece", async () => {
    m.cas = { data: [] };
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r).toEqual({ ok: true, efeito: "duplicado", status: "paga" });
    expect(escritas("crm_leads")).toEqual([]);
    expect(cadeias("crm_lead_activities")).toEqual([]);
    expect(escritas("messages")).toEqual([]);
  });

  it("limite de 2 na busca por id externo: é a ambiguidade que se mede, não a primeira linha", async () => {
    await confirmarPagamento(banco.cliente as never, pedido);
    const select = cadeias("pagamento_recebimentos")[0]!;
    expect(select.passos.filter((p) => p.metodo === "limit").map((p) => p.args)).toContainEqual([2]);
  });

  it("⭐ id externo ambíguo (mesma conta em duas empresas): 500 e NADA é marcado", async () => {
    m.linhas = [pendente(), pendente({ id: "cccccccc-0000-4000-8000-0000000000bb", organization_id: "cccccccc-0000-4000-8000-0000000000cc" })];
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(escritas("pagamento_recebimentos")).toEqual([]);
    expect(h.erro).toHaveBeenCalled();
  });

  it("id que não é nosso: `desconhecido` e nada escrito", async () => {
    m.linhas = [];
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r).toEqual({ ok: true, efeito: "desconhecido" });
    expect(banco.cadeias.filter((c) => operacao(c) !== "select")).toEqual([]);
  });

  it("⭐ ganhar pelo pagamento é o MESMO fecho do botão Ganhar: grava a etapa de ganho, a linha de encerramento e a auditoria `lead.won`", async () => {
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r.ok && r.efeito === "pago" && r.movido).toEqual({ moveu: true });
    const patch = argumentos(escritas("crm_leads")[0]!, "update")?.[0] as { stage_id: string };
    expect(patch.stage_id).toBe(ETAPA_GANHO);
    const tipos = cadeias("crm_lead_activities").map((c) => (argumentos(c, "insert")?.[0] as { type: string }).type);
    expect(tipos).toContain("demand_closed");
    expect(h.auditorias).toContainEqual(
      expect.objectContaining({ action: "lead.won", organizationId: ORG, resourceId: LEAD, actorUserId: null }),
    );
  });

  it("⭐ a RÉGUA de campos obrigatórios vale também aqui: funil exige campo ao ganhar, o pagamento vale e o card NÃO anda", async () => {
    m.settings = {
      fields: [{ key: "nota_fiscal", label: "Nota fiscal", type: "text", obrigatorio_em: { ao_ganhar: true } }],
    };
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r).toMatchObject({ ok: true, efeito: "pago" });
    if (!r.ok || r.efeito !== "pago") return;
    expect(r.recebimento.status).toBe("paga");
    expect(r.movido).toMatchObject({ moveu: false, motivo: "campos_obrigatorios" });
    expect(JSON.stringify(r.movido)).toContain("Nota fiscal");
    expect(escritas("crm_leads")).toEqual([]);
    expect(h.auditorias.filter((a) => a.action === "lead.won")).toEqual([]);
    // A timeline diz POR QUE o card ficou: sem isso o vendedor vê "pago" e o card parado.
    const linha = cadeias("crm_lead_activities")
      .map((c) => argumentos(c, "insert")?.[0] as { type: string; reason: string })
      .find((l) => l.type === "payment_confirmed")!;
    expect(linha.reason).toContain("Nota fiscal");
  });

  it("motivo de ganho exigido pelo funil também segura o card (a mesma régua do botão)", async () => {
    m.settings = { won_reason_required: true };
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r.ok && r.efeito === "pago" && r.movido).toMatchObject({ moveu: false, motivo: "campos_obrigatorios" });
    expect(escritas("crm_leads")).toEqual([]);
  });

  it("alguém ganhou o negócio entre a nossa leitura e o fecho: `ja_esta_la`, nada reescrito", async () => {
    m.statusNoFecho = "won";
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r.ok && r.efeito === "pago" && r.movido).toEqual({ moveu: false, motivo: "ja_esta_la" });
    expect(escritas("crm_leads")).toEqual([]);
  });

  it("⭐ humano PERDEU o negócio entre a nossa leitura e o fecho: `conflito_humano`, e o desfecho dele vence", async () => {
    m.statusNoFecho = "lost";
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r.ok && r.efeito === "pago" && r.movido).toEqual({ moveu: false, motivo: "conflito_humano" });
    expect(escritas("crm_leads")).toEqual([]);
    expect(h.auditorias.filter((a) => a.action === "lead.won")).toEqual([]);
  });

  it("⭐ humano mexeu no card entre a leitura e a escrita: `conflito_humano`, e a decisão dele vence", async () => {
    m.moveu = { data: [] };
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r.ok && r.efeito === "pago" && r.movido).toEqual({ moveu: false, motivo: "conflito_humano" });
    // O update leva o estado LIDO no filtro — é a trava otimista: etapa de origem e negócio aberto.
    const upd = cadeias("crm_leads").find((c) => operacao(c) === "update")!;
    const eqs = upd.passos.filter((p) => p.metodo === "eq").map((p) => p.args);
    expect(eqs).toContainEqual(["stage_id", ETAPA_ATUAL]);
    expect(eqs).toContainEqual(["status", "open"]);
    expect(h.auditorias.filter((a) => a.action === "lead.won")).toEqual([]);
  });

  it("funil SEM etapa de ganho: não move (estado legítimo, não erro)", async () => {
    m.etapa = null;
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r.ok && r.efeito === "pago" && r.movido).toEqual({ moveu: false, motivo: "sem_etapa_de_ganho" });
    expect(escritas("crm_leads")).toEqual([]);
  });

  it("negócio já encerrado (ganho ou perdido): não reescreve o desfecho", async () => {
    m.lead!.status = "lost";
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r.ok && r.efeito === "pago" && r.movido).toEqual({ moveu: false, motivo: "negocio_encerrado" });
    expect(escritas("crm_leads")).toEqual([]);
  });

  it("sem negócio vinculado: marca pago e não escreve timeline (não há negócio onde escrever)", async () => {
    m.linhas = [pendente({ lead_id: null })];
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r.ok && r.efeito === "pago" && r.movido).toEqual({ moveu: false, motivo: "sem_negocio" });
    expect(cadeias("crm_leads")).toEqual([]);
    expect(cadeias("crm_lead_activities")).toEqual([]);
  });

  it("falha ao gravar o ganho: `falha_de_escrita`, e o pagamento continua pago", async () => {
    m.moveu = { error: { code: "XX000", message: "queda" } };
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r.ok && r.efeito === "pago" && r.movido).toEqual({ moveu: false, motivo: "falha_de_escrita" });
    expect(h.aviso).toHaveBeenCalled();
  });

  it("falha ao marcar o pagamento: 500 (o provedor reentrega) e nada mais é escrito", async () => {
    m.cas = { error: { code: "42501", message: "rls" } };
    const r = await confirmarPagamento(banco.cliente as never, pedido);
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(escritas("messages")).toEqual([]);
    expect(cadeias("crm_lead_activities")).toEqual([]);
  });

  it("metadata da mensagem de OUTRO recebimento não é reescrito (ponteiro trocado à mão)", async () => {
    m.mensagem!.metadata = {
      pagamento: { provedor: "infinitepay", id: "pay_123", valor: 15000, moeda: "BRL", status: "pendente", recebimento_id: "outro" },
    };
    await confirmarPagamento(banco.cliente as never, pedido);
    expect(escritas("messages")).toEqual([]);
  });
});
