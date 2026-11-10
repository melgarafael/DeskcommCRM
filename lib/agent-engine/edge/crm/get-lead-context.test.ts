/**
 * `last_proposal` (N7) — o desfecho da última proposta com desfecho real no
 * contexto do turno, para o agente não oferecer de novo o que já foi recusado.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getLeadContext } from './get-lead-context';

// ─── last_proposal (N7) ─────────────────────────────────────────────────────

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";

interface MundoOpts {
  /** Linhas que a query de crm_proposals devolve. `undefined` = a query lança. */
  propostas?: Array<Record<string, unknown>>;
  /** Linhas que a query do histórico devolve (#2729). */
  historico?: Array<Record<string, unknown>>;
}

function montarDb(opts: MundoOpts = {}) {
  const consultas: string[] = [];
  const db = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: vi.fn(async (sql: string, _params: any[]) => {
      consultas.push(sql);
      if (sql.includes("from contacts")) {
        return {
          rows: [{
            name: "Cliente", display_name: null, email: null, phone_number: "5511",
            tags: [], is_blocked: false, source: "whatsapp", consent: null, is_anonymized: false,
          }],
        };
      }
      if (sql.includes("crm_lead_activities")) return { rows: [] };
      if (sql.includes("from messages")) return { rows: opts.historico ?? [] };
      if (sql.includes("from demandas")) return { rows: [] };
      if (sql.includes("from crm_proposals")) {
        if (opts.propostas === undefined) throw new Error("relation crm_proposals does not exist");
        return { rows: opts.propostas };
      }
      // O contexto também pode consultar `crm_leads` — sem negócio aberto,
      // o que estes casos não medem.
      if (sql.includes("from crm_leads")) return { rows: [] };
      throw new Error(`query não mockada: ${sql.slice(0, 60)}`);
    }),
  };
  return { db, consultas };
}

const INPUT = { tenantId: TENANT_ID, leadId: CONTACT_ID, conversationId: "conv-1", fuso: "America/Sao_Paulo" };
const KNOBS = { historyLimit: 20, maxTokens: 1000 };

describe("getLeadContext — last_proposal (N7)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("negócio com proposta RECUSADA: last_proposal reflete status e motivo (N7)", async () => {
    const { db } = montarDb({
      propostas: [{ status: "recusada", total_cents: 50000, decision_reason: "Preço acima do orçamento", numero: 1, ano: 2026 }],
    });
    const r = await getLeadContext(db as never, {} as never, INPUT, KNOBS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.context.last_proposal).toEqual({
        status: "recusada", total_cents: 50000, decision_reason: "Preço acima do orçamento", numero: 1, ano: 2026,
      });
    }
  });

  it("negócio SEM nenhuma proposta com desfecho: last_proposal é null", async () => {
    const { db, consultas } = montarDb({ propostas: [] });
    const r = await getLeadContext(db as never, {} as never, INPUT, KNOBS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.context.last_proposal).toBeNull();
    // rascunho nunca é desfecho: a query só admite os 4 status com desfecho
    // real, no SQL (allowlist, não blocklist — status futuro não vaza).
    const sqlPropostas = consultas.find((s) => s.includes("from crm_proposals")) ?? "";
    expect(sqlPropostas).toMatch(/status in \('enviada', 'aceita', 'recusada', 'vencida'\)/);
  });

  it("query de crm_proposals falha: last_proposal null, o resto do contexto SEGUE montando (falha aberta)", async () => {
    const { db } = montarDb();
    const r = await getLeadContext(db as never, {} as never, INPUT, KNOBS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.context.last_proposal).toBeNull();
      expect(r.context.contact).toBeDefined();
    }
  });
});

// ─── #2729 — quem escreveu cada mensagem do grupo ────────────────────────────
//
// O dado mora em `messages.metadata.group_sender` desde a entrada dos grupos, e
// o turno simplesmente não o lia: num grupo de três pessoas o modelo recebia
// todas as falas sem autor. Aqui a régua é o MAPEAMENTO (metadata → `sender`);
// a consulta de verdade é medida contra o banco em
// `tests/invariants/historico-do-grupo-no-atendimento.test.ts`.
describe("getLeadContext — remetente do grupo (#2729)", () => {
  const linha = (o: Record<string, unknown>): Record<string, unknown> => ({
    type: "text",
    body: "oi",
    media_url: null,
    media_storage_path: null,
    media_mime: null,
    media_derived_text: null,
    sent_at: new Date("2026-10-20T12:00:00Z"),
    metadata: null,
    ...o,
  });

  it("recebida com group_sender chega com `sender` (nome e telefone, sem lid)", async () => {
    const { db } = montarDb({
      propostas: [],
      historico: [
        linha({
          direction: "inbound",
          body: "bom dia",
          metadata: {
            raw_type: "chat",
            group_sender: { name: "Dona", phone: "+5511999990000", lid: "123456789012345" },
          },
        }),
        linha({ direction: "outbound", body: "bom dia!", metadata: { raw_type: "chat" } }),
      ],
    });
    const r = await getLeadContext(db as never, {} as never, INPUT, KNOBS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A ordem é a da consulta (mais nova primeiro, o chamador inverte); o que
    // este caso mede é o MAPEAMENTO, então procura por direção.
    const recebida = r.context.messages.find((m) => m.direction === "inbound");
    expect(recebida).toMatchObject({ sender: { name: "Dona", phone: "+5511999990000" } });
    // `lid` é identificador interno do WhatsApp: não vai ao prompt.
    expect(JSON.stringify(r.context)).not.toContain("123456789012345");
    // A enviada é nossa — não tem autor participante para nomear.
    expect(r.context.messages.find((m) => m.direction === "outbound")).not.toHaveProperty("sender");
  });

  it("controle 1:1: sem group_sender, nenhuma mensagem ganha `sender`", async () => {
    const { db } = montarDb({
      propostas: [],
      historico: [linha({ direction: "inbound", body: "bom dia" })],
    });
    const r = await getLeadContext(db as never, {} as never, INPUT, KNOBS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.messages[0]).not.toHaveProperty("sender");
  });

  it("group_sender fora do formato não derruba o turno: a mensagem entra sem autor", async () => {
    const { db } = montarDb({
      propostas: [],
      historico: [
        linha({ direction: "inbound", metadata: { group_sender: { name: "", phone: "not-a-phone" } } }),
      ],
    });
    const r = await getLeadContext(db as never, {} as never, INPUT, KNOBS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.messages[0]).not.toHaveProperty("sender");
  });
});
