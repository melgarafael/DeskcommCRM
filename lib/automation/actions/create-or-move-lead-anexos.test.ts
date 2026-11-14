/**
 * #4544 — O CARD CRIADO EM OUTRO FUNIL LEVA OS ANEXOS.
 *
 * O caso da issue, medido: os documentos da venda (voucher, apólice, bilhete)
 * são anexados no card de **Vendas**; quando o negócio é ganho, a automação cria
 * a continuação no funil **Experiência do Cliente** com `montaPayloadDoClone`, e
 * o card novo nascia sem nenhum deles. O anexo mora em
 * `crm_lead_attachments.lead_id`, e o `lead_id` do destino é OUTRO — ninguém
 * reinseria as linhas nem copiava o objeto do Storage.
 *
 * Estes casos rodam o caminho REAL da automação: `getAction("create_or_move_lead")`
 * → `createLeadHandler` (o mesmo da rota) → cópia dos anexos. O cliente do
 * Storage é o de serviço (`createAdminClient`), como em produção — a cópia não
 * é injetada pelo teste, justamente para prender o caminho que roda de verdade.
 *
 * Sabotagem verificada ao escrever: trocando a chamada de `criarCloneNoFunil` de
 * volta por `createLeadHandler(...montaPayloadDoClone(...))` em
 * `create-or-move-lead.ts` (a linha de base da `main`), os três casos reprovam —
 * os dois primeiros porque nenhuma linha nasce em `crm_lead_attachments`, e o
 * controle porque o recibo não traz `anexos`; e desligando só a cópia dentro de
 * `criarCloneNoFunil`, reprovam os casos 1 e 3 e o controle segue verde.
 * Sabotagens revertidas antes do commit.
 */
import { describe, expect, it, vi } from "vitest";

/** O que o bucket recebeu — e o botão para fazê-lo falhar. */
const storage = vi.hoisted(() => ({
  copias: [] as Array<[string, string]>,
  falhar: false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: null, error: null }),
    storage: {
      from: () => ({
        copy: async (de: string, para: string) => {
          storage.copias.push([de, para]);
          return storage.falhar
            ? { data: null, error: { message: "storage: objeto não encontrado" } }
            : { data: { path: para }, error: null };
        },
      }),
    },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/create-or-move-lead";
import type { ActionCtx } from "@/lib/automation/types";
import { ORG_ID, PIPE, etapa, funilRow, makeDb, type StageRow } from "@/tests/helpers/stages-db-double";

const FUNIL_DE_POS_VENDA = "66666666-4444-4444-8866-666666666666";

const ETAPA_DE_GANHO = etapa({
  id: "pago",
  slug: "pago",
  name: "Pago",
  pipeline_id: PIPE,
  position: 3000,
  is_won: true,
});
const ETAPA_DE_POS_VENDA = etapa({
  id: "pos_venda",
  slug: "pos_venda",
  name: "Pós-venda",
  pipeline_id: FUNIL_DE_POS_VENDA,
  position: 7000,
});

const NEGOCIO_GANHO = {
  id: "lead-ganho-1",
  pipeline_id: PIPE,
  stage_id: "pago",
  organization_id: ORG_ID,
  contact_id: "contato-1",
  status: "won",
  title: "Pacote Cancún — 7 noites",
  description: "Seguro e voucher emitidos",
  value_cents: 1250000,
  recurring_value_cents: null,
  recurring_period: null,
  recurring_months: null,
  currency: "BRL",
  owner_user_id: null,
  owner_agent_id: null,
  expected_close_date: null,
  tags: ["venda-fechada"],
  source: "whatsapp",
  custom_fields: { destino: "Cancún" },
  source_metadata: {},
};

const APOLICE = {
  id: "anexo-apolice",
  organization_id: ORG_ID,
  lead_id: NEGOCIO_GANHO.id,
  field_key: "voucher",
  file_name: "apolice.pdf",
  file_size: 184320,
  mime_type: "application/pdf",
  storage_path: `${ORG_ID}/leads/${NEGOCIO_GANHO.id}/voucher/anexo-apolice.pdf`,
  created_by: null,
};

type Linha = Record<string, unknown>;

function dbDoGanho(anexos: Linha[] = [APOLICE], extrasDeEtapa: StageRow[] = []) {
  const db = makeDb({
    contacts: [{ id: "contato-1", organization_id: ORG_ID }],
    pipelines: [
      funilRow({ id: PIPE, name: "Vendas" }),
      funilRow({ id: FUNIL_DE_POS_VENDA, name: "Experiência do Cliente" }),
    ],
    stages: [ETAPA_DE_GANHO, ETAPA_DE_POS_VENDA, ...extrasDeEtapa],
    leads: [{ ...NEGOCIO_GANHO }] as never,
  });
  // O dublê não conhece `crm_lead_attachments` (não é tabela das rotas de
  // etapa); a tabela é criada aqui, como o banco a tem, e é isso que o INSERT
  // do conserto precisa encontrar.
  (db.tabelas as unknown as Record<string, Linha[]>).crm_lead_attachments = anexos.map((a) => ({
    ...a,
  }));
  return db;
}

function ctxDoGanho(db: ReturnType<typeof makeDb>): ActionCtx {
  return {
    admin: db.client as unknown as ActionCtx["admin"],
    organizationId: ORG_ID,
    ruleId: "rule-pos-venda",
    ruleName: "Ganho → pós-venda",
    event: {
      id: "ev-ganho-1",
      organization_id: ORG_ID,
      event_type: "lead.won",
      entity_kind: "crm_lead",
      entity_id: NEGOCIO_GANHO.id,
      payload: { lead_id: NEGOCIO_GANHO.id },
      metadata: {},
    } as unknown as ActionCtx["event"],
    context: {
      lead: { ...NEGOCIO_GANHO },
      contact: { id: "contato-1", name: "Fulano", phone_number: "+5511999990001" },
    },
    requestId: "req-1",
  };
}

const CONFIG_POS_VENDA = { pipeline_id: FUNIL_DE_POS_VENDA, stage_id: "pos_venda" };

function anexosDoDb(db: ReturnType<typeof makeDb>): Linha[] {
  return ((db.tabelas as unknown as Record<string, Linha[]>).crm_lead_attachments ??= []) as Linha[];
}

describe("create_or_move_lead — lead.won leva os anexos do card de Vendas (#4544)", () => {
  it("o card do pós-venda nasce COM o anexo: linha nova, caminho novo no Storage, mesmo arquivo", async () => {
    storage.copias = [];
    storage.falhar = false;
    const db = dbDoGanho();

    const resultado = await getAction("create_or_move_lead")!.execute(ctxDoGanho(db), CONFIG_POS_VENDA);

    expect(resultado).toMatchObject({ type: "create_or_move_lead", status: "success" });
    const criado = db.tabelas.crm_leads.find((l) => l.id !== NEGOCIO_GANHO.id);
    expect(criado, "o card novo no funil de pós-venda").toBeDefined();
    expect((resultado.detail as Record<string, unknown>).anexos).toBe(1);

    const linhas = anexosDoDb(db);
    expect(linhas, "a linha da origem + a linha do destino").toHaveLength(2);

    const doDestino = linhas.find((linha) => linha.lead_id === criado?.id);
    expect(doDestino, "o anexo aponta para o card NOVO").toBeDefined();
    expect(doDestino).toMatchObject({
      organization_id: ORG_ID,
      field_key: "voucher",
      file_name: "apolice.pdf",
      file_size: 184320,
      mime_type: "application/pdf",
    });
    // O `storage_path` é preso ao negócio pelo check do banco: o caminho do
    // destino tem de carregar o id do card novo, não o da origem.
    expect(String(doDestino?.storage_path)).toMatch(
      new RegExp(`^${ORG_ID}/leads/${criado?.id}/voucher/[0-9a-f-]+\\.pdf$`),
    );
    expect(doDestino?.storage_path).not.toBe(APOLICE.storage_path);

    // O arquivo foi COPIADO no bucket (origem → caminho novo), não apontado.
    expect(storage.copias).toEqual([[APOLICE.storage_path, String(doDestino?.storage_path)]]);

    // A origem continua com o anexo dela, intocada.
    const daOrigem = linhas.find((linha) => linha.lead_id === NEGOCIO_GANHO.id);
    expect(daOrigem).toMatchObject({ id: APOLICE.id, storage_path: APOLICE.storage_path });
  });

  it("CONTROLE: card de origem sem anexo continua nascendo, sem cópia nenhuma", async () => {
    storage.copias = [];
    storage.falhar = false;
    const db = dbDoGanho([]);

    const resultado = await getAction("create_or_move_lead")!.execute(ctxDoGanho(db), CONFIG_POS_VENDA);

    expect(resultado).toMatchObject({ status: "success", detail: { anexos: 0 } });
    expect(storage.copias).toEqual([]);
    expect(anexosDoDb(db)).toEqual([]);
    expect(db.tabelas.crm_leads.filter((l) => l.pipeline_id === FUNIL_DE_POS_VENDA)).toHaveLength(1);
  });

  it("falha ao copiar o arquivo NÃO derruba a troca de funil — e o recibo conta a falha", async () => {
    storage.copias = [];
    storage.falhar = true;
    const db = dbDoGanho();

    const resultado = await getAction("create_or_move_lead")!.execute(ctxDoGanho(db), CONFIG_POS_VENDA);

    expect(resultado).toMatchObject({
      status: "success",
      detail: { anexos: 0, anexos_com_falha: 1 },
    });
    // Nenhuma linha órfã: sem o arquivo copiado, o INSERT não sai.
    expect(anexosDoDb(db)).toHaveLength(1);
    expect(anexosDoDb(db)[0]).toMatchObject({ lead_id: NEGOCIO_GANHO.id });
    storage.falhar = false;
  });
});
