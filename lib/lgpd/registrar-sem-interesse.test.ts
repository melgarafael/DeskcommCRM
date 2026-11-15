/**
 * O REGISTRADOR DO "NÃO TEM INTERESSE" FORA DO CAMINHO FELIZ (decisão D3).
 *
 * A rota faz mock deste módulo e o teste da entrada não confere os filtros de
 * `contacts`; aqui o banco é um dublê que REGISTRA cada operação, por tabela, com os
 * filtros aplicados. Mede: a cerca de organização em toda leitura e escrita (admin
 * client, anti-pattern 10), o contato anonimizado, a idempotência que volta a fechar
 * o negócio, o follow-up da prospecção encerrado (e o de atendimento poupado), a
 * gravação que não atropela escrita concorrente, e o desfazer com a auditoria.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar o `if (contato.is_anonymized)`: "anonimizado" fica vermelho.
 * - Tirar o `.eq("organization_id")` de `lerContato`: os 10 ficam vermelhos (medido) — o dublê
 *   só devolve a linha com a cerca inteira, então o contato "some" e nada é gravado.
 * - Tirar o `await audit` do desfazer: "desfazer" fica vermelho.
 * - Voltar o ramo `ja_recusado` a sair sem fechar: "repetir a frase" fica vermelho.
 * - Tirar a chamada de `encerrarFollowupsDaProspeccao`: "follow-up" e "a cerca" ficam
 *   vermelhos (2 de 10, medido; a cerca também confere as operações nas tabelas do follow-up).
 * - Tirar o `.eq("updated_at")`: "escrita concorrente" fica vermelho.
 * - Tirar do dicionário a frase da linha do tempo: "tem tradução em es e en" fica
 *   vermelho (1 de 10, medido).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditSpy, encerraDemandaSpy } = vi.hoisted(() => ({
  auditSpy: vi.fn(async (_e: { metadata?: Record<string, unknown> }) => undefined),
  encerraDemandaSpy: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("@/lib/audit", () => ({ audit: auditSpy }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda: encerraDemandaSpy }));

import { desfazerSemInteresse, registrarSemInteresse } from "@/lib/lgpd/registrar-sem-interesse";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { consentComSemInteresse } from "@/lib/lgpd/sem-interesse";

const ORG = "org-1";
const CONTATO = "contato-1";

type Filtro = [metodo: string, coluna: string, valor: unknown];
interface Op {
  tabela: string;
  tipo: "select" | "update" | "insert";
  payload?: Record<string, unknown>;
  filtros: Filtro[];
}

interface Estado {
  contato: { id: string; consent: unknown; is_anonymized: boolean; updated_at: string } | null;
  leads: Array<{ id: string; pipeline_id: string }>;
  inscricoes: Array<{ id: string; status: string; current_node_id: string; conversation_id: string | null }>;
  conversas: Array<{ id: string; metadata: unknown }>;
  /** Uma escrita concorrente que chega entre a 1ª leitura e a 1ª gravação do contato. */
  concorrente?: (consent: Record<string, unknown>) => Record<string, unknown>;
  chavesDeEvento: Set<string>;
  /** Quantas vezes o UPDATE da inscrição falha antes de passar (erro passageiro). */
  falhasNoUpdateDaInscricao?: number;
  /** Outro caminho (o PARAR, o fim do roteiro) encerra a inscrição entre a leitura e o UPDATE. */
  outroEncerraAntesDoUpdate?: boolean;
}

let estado: Estado;
let ops: Op[];

function valorDo(op: Op, coluna: string): unknown {
  return op.filtros.find(([m, c]) => m === "eq" && c === coluna)?.[2];
}

function responder(op: Op): { data: unknown; error: unknown } {
  if (op.tabela === "contacts" && op.tipo === "select") {
    if (valorDo(op, "organization_id") !== ORG) return { data: null, error: null };
    return { data: estado.contato ? { ...estado.contato } : null, error: null };
  }
  if (op.tabela === "contacts" && op.tipo === "update") {
    const c = estado.contato;
    if (!c || valorDo(op, "organization_id") !== ORG || valorDo(op, "id") !== c.id) return { data: [], error: null };
    if (estado.concorrente) {
      c.consent = estado.concorrente(c.consent as Record<string, unknown>);
      c.updated_at = "2026-11-14T12:00:09.000Z";
      estado.concorrente = undefined;
    }
    const exigido = valorDo(op, "updated_at");
    if (exigido !== undefined && exigido !== c.updated_at) return { data: [], error: null };
    c.consent = op.payload?.consent;
    c.updated_at = `2026-11-14T12:01:${String(ops.length).padStart(2, "0")}.000Z`;
    return { data: [{ id: c.id }], error: null };
  }
  if (op.tabela === "crm_leads") return { data: estado.leads, error: null };
  if (op.tabela === "crm_pipelines") return { data: [{ id: "funil-1", settings: {} }], error: null };
  if (op.tabela === "followup_enrollments" && op.tipo === "select") return { data: estado.inscricoes, error: null };
  if (op.tabela === "followup_enrollments" && op.tipo === "update") {
    if (estado.falhasNoUpdateDaInscricao) {
      estado.falhasNoUpdateDaInscricao -= 1;
      return { data: null, error: { code: "57014", message: "statement timeout" } };
    }
    const i = estado.inscricoes.find((x) => x.id === valorDo(op, "id"));
    if (i && estado.outroEncerraAntesDoUpdate) i.status = "cancelled";
    if (!i || !["active", "waiting_reply", "paused_handoff", "dormente", "coletando", "paused_manual"].includes(i.status))
      return { data: [], error: null };
    i.status = String(op.payload?.status);
    return { data: [{ id: i.id }], error: null };
  }
  if (op.tabela === "conversations") return { data: estado.conversas, error: null };
  if (op.tabela === "followup_enrollment_events") {
    const chave = String(op.payload?.idempotency_key);
    if (estado.chavesDeEvento.has(chave)) return { data: null, error: { code: "23505", message: "dup" } };
    estado.chavesDeEvento.add(chave);
    return { data: null, error: null };
  }
  return { data: null, error: null };
}

function bancoFalso(): never {
  return {
    from(tabela: string) {
      const op: Op = { tabela, tipo: "select", filtros: [] };
      let registrado = false;
      const registra = () => {
        if (!registrado) {
          ops.push(op);
          registrado = true;
        }
        return Promise.resolve(responder(op));
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          op.tipo = "update";
          op.payload = p;
          return chain;
        },
        insert: (p: Record<string, unknown>) => {
          op.tipo = "insert";
          op.payload = p;
          return registra();
        },
        eq: (c: string, v: unknown) => {
          op.filtros.push(["eq", c, v]);
          return chain;
        },
        in: (c: string, v: unknown) => {
          op.filtros.push(["in", c, v]);
          return chain;
        },
        maybeSingle: () => registra(),
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => registra().then(ok, erro),
      };
      return chain;
    },
  } as never;
}

const PEDIDO = {
  organizationId: ORG,
  contactId: CONTATO,
  origem: "conversa_de_prospeccao" as const,
  actor: { type: "webhook_source" as const, id: "canal-inbound" },
  requestId: "req-1",
  conversationId: "conv-prosp",
  campanhaId: "campanha-1",
};

const opsDe = (tabela: string, tipo?: Op["tipo"]) =>
  ops.filter((o) => o.tabela === tabela && (!tipo || o.tipo === tipo));

beforeEach(() => {
  vi.clearAllMocks();
  ops = [];
  estado = {
    contato: {
      id: CONTATO,
      consent: { marketing: { granted: true, granted_at: "2026-01-01T00:00:00.000Z" } },
      is_anonymized: false,
      updated_at: "2026-11-14T12:00:00.000Z",
    },
    leads: [{ id: "lead-prosp", pipeline_id: "funil-1" }],
    inscricoes: [],
    conversas: [],
    chavesDeEvento: new Set(),
  };
});

describe("registrarSemInteresse", () => {
  it("grava, audita e fecha o negócio da prospecção", async () => {
    const r = await registrarSemInteresse(bancoFalso(), PEDIDO);
    expect(r).toMatchObject({ gravado: true, negociosFechados: 1 });
    const marketing = (estado.contato?.consent as Record<string, Record<string, unknown>>).marketing;
    expect(marketing).toMatchObject({ granted: false, motivo: "sem_interesse", origem: "conversa_de_prospeccao" });
    expect(marketing?.anterior).toEqual({ granted: true, granted_at: "2026-01-01T00:00:00.000Z" });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]?.[0]?.metadata).toMatchObject({ consentimento: "recusado", origem: "conversa_de_prospeccao" });
    expect(encerraDemandaSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * A frase vai gravada como `reason` da atividade e a linha do tempo a traduz só na
   * leitura, com `t(item.reason)`. Sem a chave no dicionário e no catálogo em inglês,
   * quem usa o CRM em espanhol ou em inglês lê o texto em português, e nenhum teste de
   * idioma pega, porque a frase não passa por um `t()` estático.
   */
  it("a frase que a linha do tempo mostra no negócio fechado tem tradução em es e en", async () => {
    await registrarSemInteresse(bancoFalso(), PEDIDO);
    const razao = (encerraDemandaSpy.mock.calls[0]?.[2] as { razaoNaTimeline?: string } | undefined)
      ?.razaoNaTimeline;
    expect(razao).toBe("O cliente disse que não tem interesse");
    const en = JSON.parse(readFileSync("lib/i18n/traducoes/en.json", "utf8")) as Record<string, string>;
    expect(DICIONARIO[razao ?? ""]?.es).toBe("El cliente dijo que no tiene interés");
    expect(en[razao ?? ""]).toBe("The client said they are not interested");
  });

  it("a cerca: toda leitura e escrita leva organization_id (e o id do contato em contacts)", async () => {
    estado.inscricoes = [{ id: "insc-1", status: "waiting_reply", current_node_id: "n1", conversation_id: "conv-x" }];
    estado.conversas = [{ id: "conv-x", metadata: { prospecting_campaign_id: "campanha-0" } }];
    await registrarSemInteresse(bancoFalso(), PEDIDO);
    const comCerca = ops.filter((o) => o.tipo !== "insert");
    expect(comCerca.length).toBeGreaterThan(4);
    for (const op of comCerca) expect([op.tabela, valorDo(op, "organization_id")]).toEqual([op.tabela, ORG]);
    for (const op of opsDe("contacts")) expect(valorDo(op, "id")).toBe(CONTATO);
    for (const op of opsDe("followup_enrollment_events", "insert"))
      expect(op.payload?.organization_id).toBe(ORG);
  });

  it("contato anonimizado: nada é gravado, auditado nem fechado", async () => {
    if (estado.contato) estado.contato.is_anonymized = true;
    const r = await registrarSemInteresse(bancoFalso(), PEDIDO);
    expect(r).toEqual({ gravado: false, motivo: "anonimizado" });
    expect(opsDe("contacts", "update")).toHaveLength(0);
    expect(auditSpy).not.toHaveBeenCalled();
    expect(encerraDemandaSpy).not.toHaveBeenCalled();
  });

  it("repetir a frase não grava nem audita de novo, mas volta a fechar o negócio aberto", async () => {
    if (estado.contato)
      estado.contato.consent = consentComSemInteresse({}, { agora: "2026-11-14T11:00:00.000Z", origem: "ficha" });
    const r = await registrarSemInteresse(bancoFalso(), PEDIDO);
    expect(r).toMatchObject({ gravado: false, motivo: "ja_recusado", negociosFechados: 1 });
    expect(opsDe("contacts", "update")).toHaveLength(0);
    expect(auditSpy).not.toHaveBeenCalled();
    expect(encerraDemandaSpy).toHaveBeenCalledTimes(1);
  });

  it("a recusa que veio da captação não é desta régua: não fecha negócio", async () => {
    if (estado.contato) estado.contato.consent = { marketing: { granted: false, declined_at: "2026-10-01T00:00:00.000Z" } };
    const r = await registrarSemInteresse(bancoFalso(), PEDIDO);
    expect(r).toMatchObject({ gravado: false, motivo: "ja_recusado", negociosFechados: 0 });
    expect(encerraDemandaSpy).not.toHaveBeenCalled();
  });

  it("UPDATE da inscrição que falhou: a frase repetida termina o serviço (o evento não trava a chave)", async () => {
    estado.inscricoes = [{ id: "insc-da-frase", status: "waiting_reply", current_node_id: "n1", conversation_id: "conv-prosp" }];
    estado.falhasNoUpdateDaInscricao = 1;
    const primeira = await registrarSemInteresse(bancoFalso(), PEDIDO);
    expect(primeira).toMatchObject({ gravado: true, followupsEncerrados: 0 });
    expect(opsDe("followup_enrollment_events", "insert")).toHaveLength(0);

    const segunda = await registrarSemInteresse(bancoFalso(), PEDIDO);
    expect(segunda).toMatchObject({ gravado: false, motivo: "ja_recusado", followupsEncerrados: 1 });
    expect(estado.inscricoes[0]?.status).toBe("cancelled");
    expect(opsDe("followup_enrollment_events", "insert")).toHaveLength(1);
  });

  it("inscrição que outro caminho já encerrou: nenhum 'encerrado' falso na timeline", async () => {
    estado.inscricoes = [{ id: "insc-da-frase", status: "waiting_reply", current_node_id: "n1", conversation_id: "conv-prosp" }];
    estado.outroEncerraAntesDoUpdate = true;
    const r = await registrarSemInteresse(bancoFalso(), PEDIDO);
    expect(r).toMatchObject({ gravado: true, followupsEncerrados: 0 });
    expect(opsDe("followup_enrollment_events", "insert")).toHaveLength(0);
  });

  it("follow-up: a inscrição da prospecção morre; a de atendimento e a sem conversa ficam", async () => {
    estado.inscricoes = [
      { id: "insc-da-frase", status: "waiting_reply", current_node_id: "n1", conversation_id: "conv-prosp" },
      { id: "insc-outra-campanha", status: "dormente", current_node_id: "n2", conversation_id: "conv-x" },
      { id: "insc-atendimento", status: "active", current_node_id: "n3", conversation_id: "conv-atend" },
      { id: "insc-sem-conversa", status: "active", current_node_id: "n4", conversation_id: null },
    ];
    estado.conversas = [
      { id: "conv-x", metadata: { prospecting_campaign_id: "campanha-0" } },
      { id: "conv-atend", metadata: { origem: "inbox" } },
    ];
    const r = await registrarSemInteresse(bancoFalso(), PEDIDO);
    expect(r).toMatchObject({ gravado: true, followupsEncerrados: 2 });
    const canceladas = opsDe("followup_enrollments", "update").map((o) => valorDo(o, "id"));
    expect(canceladas.sort()).toEqual(["insc-da-frase", "insc-outra-campanha"]);
    for (const o of opsDe("followup_enrollments", "update"))
      expect(o.payload).toMatchObject({ status: "cancelled", outcome: "opted_out", cancel_reason: "sem_interesse" });
    expect(opsDe("followup_enrollment_events", "insert").map((o) => o.payload?.event_type)).toEqual([
      "cancelled_sem_interesse",
      "cancelled_sem_interesse",
    ]);
  });

  it("escrita concorrente entre a leitura e a gravação não é apagada: relê e grava por cima dela", async () => {
    estado.concorrente = (consent) => ({ ...consent, profiling: { granted: true } });
    const r = await registrarSemInteresse(bancoFalso(), PEDIDO);
    expect(r).toMatchObject({ gravado: true });
    const consent = estado.contato?.consent as Record<string, Record<string, unknown>>;
    expect(consent.profiling).toEqual({ granted: true });
    expect(consent.marketing).toMatchObject({ motivo: "sem_interesse" });
    expect(opsDe("contacts", "update")).toHaveLength(2);
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });
});

describe("desfazerSemInteresse", () => {
  it("devolve o consentimento de antes e audita 'recusa_desfeita', com a cerca", async () => {
    if (estado.contato)
      estado.contato.consent = consentComSemInteresse(
        { marketing: { granted: true, granted_at: "2026-01-01T00:00:00.000Z" }, transactional: { granted: true } },
        { agora: "2026-11-14T11:00:00.000Z", origem: "ficha" },
      );
    const r = await desfazerSemInteresse(bancoFalso(), {
      organizationId: ORG,
      contactId: CONTATO,
      actor: { type: "user", id: "admin-1" },
      requestId: "req-2",
    });
    expect(r).toEqual({ desfeito: true });
    expect(estado.contato?.consent).toEqual({
      marketing: { granted: true, granted_at: "2026-01-01T00:00:00.000Z" },
      transactional: { granted: true },
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]?.[0].metadata).toMatchObject({ consentimento: "recusa_desfeita" });
    for (const op of opsDe("contacts")) {
      expect(valorDo(op, "organization_id")).toBe(ORG);
      expect(valorDo(op, "id")).toBe(CONTATO);
    }
  });

  it("a recusa da captação não se desfaz por aqui", async () => {
    if (estado.contato) estado.contato.consent = { marketing: { granted: false, declined_at: "2026-10-01T00:00:00.000Z" } };
    const r = await desfazerSemInteresse(bancoFalso(), {
      organizationId: ORG,
      contactId: CONTATO,
      actor: { type: "user", id: "admin-1" },
      requestId: "req-3",
    });
    expect(r).toEqual({ desfeito: false, motivo: "sem_recusa" });
    expect(opsDe("contacts", "update")).toHaveLength(0);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
