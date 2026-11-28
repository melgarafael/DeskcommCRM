/**
 * #5281 — UMA SÓ CÓPIA ABERTA POR NEGÓCIO DE ORIGEM E FUNIL DE DESTINO.
 *
 * O índice único `crm_leads_clone_aberto_no_funil_uidx` faz a regra valer no
 * banco, e os dois escritores de cópia que ficam FORA da transação da rota
 * (`fn_levar_negocio_para_funil`) passam a receber `23505` onde antes gravavam a
 * segunda cópia. A decisão é a mesma da rota para quem repete: reaproveitar a
 * cópia aberta que já existe, nunca devolver o erro cru.
 *
 * O dublê não tem índice, então ele é simulado em `writeError`: o INSERT em
 * `crm_leads` de uma cópia cujo par (funil, origem) já tem cópia aberta recebe o
 * `23505` que o Postgres devolveria. O resto é o caminho real: a ação de
 * automação e `transfereParaOFunil` → `criarCloneNoFunil` → `createLeadHandler`.
 *
 * Sabotagem: sem o tratamento do `23505` em `criarCloneNoFunil`, os dois casos
 * ficam vermelhos — a automação devolve `failed` e a transferência lança o 500
 * `internal_error` do `createLeadHandler`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ copy: async (_de: string, para: string) => ({ data: { path: para }, error: null }) }) },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/create-or-move-lead";
import type { ActionCtx } from "@/lib/automation/types";
import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { ehCopiaAbertaRepetida, recusaDeCopiaAbertaPeloBanco } from "@/lib/leads/copia-aberta-no-funil";
import { transfereParaOFunil } from "@/lib/leads/transfere-para-o-funil";
import { ORG_ID, PIPE, etapa, funilRow, makeDb, type LeadRow } from "@/tests/helpers/stages-db-double";

type Linha = Record<string, unknown>;

const DESTINO = "66666666-4444-4444-8866-666666666666";
const ORIGEM = "lead-origem-5281";

const ETAPAS = [
  etapa({ id: "aberta", name: "Aberta", pipeline_id: PIPE, position: 1000 }),
  etapa({ id: "ganho", name: "Ganho", pipeline_id: PIPE, position: 2000, is_won: true }),
  etapa({ id: "perda", name: "Perda", pipeline_id: PIPE, position: 3000, is_lost: true }),
  etapa({ id: "entrada", name: "Entrada", pipeline_id: DESTINO, position: 1000 }),
];

function origem(status: "open" | "won") {
  return {
    id: ORIGEM,
    pipeline_id: PIPE,
    stage_id: status === "won" ? "ganho" : "aberta",
    organization_id: ORG_ID,
    contact_id: null,
    status,
    title: "Pacote Cancún",
    description: null,
    value_cents: 1000,
    currency: "BRL",
    owner_user_id: null,
    owner_agent_id: null,
    expected_close_date: null,
    tags: [],
    source: "manual",
    custom_fields: {},
    source_metadata: {},
  };
}

function copiaAberta(id: string): Linha {
  return {
    id,
    organization_id: ORG_ID,
    pipeline_id: DESTINO,
    stage_id: "entrada",
    status: "open",
    title: "Pacote Cancún",
    owner_user_id: null,
    contact_id: null,
    source_metadata: { clonado_de: { lead_id: ORIGEM, pipeline_id: PIPE } },
  };
}

const clonadoDe = (l: Linha) =>
  ((l.source_metadata as Linha | undefined)?.clonado_de as Linha | undefined)?.lead_id;

/**
 * O banco com o índice único simulado. `antesDoInsert` roda uma vez, no
 * primeiro INSERT de cópia: é a outra escrita que chega primeiro na corrida.
 */
function banco(lead: Linha, previas: Linha[] = [], antesDoInsert?: (leads: Linha[]) => void) {
  let corrida = antesDoInsert;
  const db = makeDb({
    pipelines: [funilRow({ id: PIPE, name: "Vendas" }), funilRow({ id: DESTINO, name: "Pós-venda" })],
    stages: ETAPAS,
    leads: [lead, ...previas] as unknown as LeadRow[],
    writeError: (_n, tabela) => {
      const escrita = db.escritas.at(-1);
      if (tabela !== "crm_leads" || escrita?.tipo !== "insert") return null;
      const nova = escrita.patch as Linha;
      if (!clonadoDe(nova)) return null;
      corrida?.(db.tabelas.crm_leads);
      corrida = undefined;
      const colide = db.tabelas.crm_leads.some((l) =>
        l.status === "open" && l.pipeline_id === nova.pipeline_id && clonadoDe(l) === clonadoDe(nova));
      return colide
        ? { code: "23505", message: 'duplicate key value violates unique constraint "crm_leads_clone_aberto_no_funil_uidx"' }
        : null;
    },
  });
  return db;
}

const copiasNoDestino = (db: ReturnType<typeof makeDb>) =>
  db.tabelas.crm_leads.filter((l) => l.pipeline_id === DESTINO);

describe("#5281 — o 23505 do índice único vira a cópia que já existe", () => {
  it("automação (lead.won): outra execução grava a continuação no meio — o recibo é 'já existia', sem segunda cópia", async () => {
    const lead = origem("won");
    const db = banco(lead, [], (leads) => leads.push(copiaAberta("copia-da-outra-execucao")));
    const ctx = {
      admin: db.client as unknown as ActionCtx["admin"],
      organizationId: ORG_ID,
      ruleId: "rule-pos-venda",
      ruleName: "Ganho → pós-venda",
      event: {
        id: "ev-1", organization_id: ORG_ID, event_type: "lead.won", entity_kind: "crm_lead",
        entity_id: ORIGEM, payload: { lead_id: ORIGEM }, metadata: {},
      } as unknown as ActionCtx["event"],
      context: { lead: { ...lead } },
      requestId: "req-1",
    } as ActionCtx;

    const resultado = await getAction("create_or_move_lead")!.execute(ctx, { pipeline_id: DESTINO, stage_id: "entrada" });

    expect(resultado).toMatchObject({
      status: "success",
      detail: { ja_existia: "copia-da-outra-execucao", origem: ORIGEM },
    });
    expect(copiasNoDestino(db).map((l) => l.id)).toEqual(["copia-da-outra-execucao"]);
    expect((ctx.context.lead as Linha).id).toBe("copia-da-outra-execucao");
  });

  it("transferência: a cópia aberta que sobrou de uma execução anterior é reaproveitada e a origem encerra", async () => {
    const lead = origem("open");
    const db = banco(lead, [copiaAberta("copia-que-sobrou")]);

    const r = await transfereParaOFunil(
      db.client as never,
      ORG_ID,
      { organization_id: ORG_ID, actor: { type: "user", id: "user-1" }, requestId: "req-1" },
      lead,
      DESTINO,
      null,
      "Levado para outro funil pela automação",
    );

    expect(r).toMatchObject({ ok: true, clone: { id: "copia-que-sobrou" } });
    expect(copiasNoDestino(db).map((l) => l.id)).toEqual(["copia-que-sobrou"]);
    expect(db.tabelas.crm_leads.find((l) => l.id === ORIGEM)?.stage_id).toBe("perda");
  });
});

/**
 * O MESMO índice, do outro lado: mover ou reabrir um card que viraria a segunda
 * cópia aberta. A recusa do banco vira 409 `copia_aberta_no_funil`, não 500.
 * Sabotagem: sem o mapeamento em `moveLeadHandler`, o caso cai no 500.
 */
describe("#5281 — reabrir a cópia quando já existe outra aberta no funil", () => {
  const RECUSA = {
    code: "23505",
    message: 'duplicate key value violates unique constraint "crm_leads_clone_aberto_no_funil_uidx"',
  };

  it("a régua reconhece SÓ este índice, e fala espanhol", () => {
    expect(ehCopiaAbertaRepetida(RECUSA)).toBe(true);
    expect(ehCopiaAbertaRepetida({
      code: "23505",
      message: 'duplicate key value violates unique constraint "uniq_crm_leads_org_source_external"',
    })).toBe(false);
    expect(ehCopiaAbertaRepetida({ code: "23514", message: RECUSA.message })).toBe(false);
    expect(recusaDeCopiaAbertaPeloBanco(RECUSA, "es")).toEqual({
      codigo: "copia_aberta_no_funil",
      mensagem: "Este negocio ya tiene una copia abierta en este embudo. Continúa la atención por ella.",
    });
  });

  it("moveLeadHandler (MCP, automação, IA): 409 copia_aberta_no_funil", async () => {
    const perdida = { ...copiaAberta("copia-perdida"), pipeline_id: PIPE, stage_id: "perda", status: "lost", lost_reason: "price" };
    const db = makeDb({
      pipelines: [funilRow({ id: PIPE, name: "Vendas" })],
      stages: ETAPAS,
      leads: [perdida] as unknown as LeadRow[],
      writeError: (_n, tabela) => (tabela === "crm_leads" && db.escritas.at(-1)?.tipo === "update" ? RECUSA : null),
    });

    const erro = await moveLeadHandler(
      db.client as never,
      { organization_id: ORG_ID, actor: { type: "user", id: "user-1" }, requestId: "req-1" },
      "copia-perdida",
      { to_stage_id: "aberta" },
    ).catch((e: unknown) => e);

    expect(erro).toMatchObject({ name: "ApiError", status: 409, code: "copia_aberta_no_funil" });
  });
});

