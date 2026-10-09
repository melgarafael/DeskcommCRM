/**
 * O ANTES-DEPOIS SÓ DOS CAMPOS TIPADOS SEM PII chega ao `api_audit_log` (issue
 * #1755, saída (b)) — e a prova é COMPORTAMENTAL: chama o `updateLeadHandler`
 * verdadeiro com banco falso e lê o que `audit()` recebeu.
 *
 * ─── Por que um teste de comportamento, e não o de texto ao lado ────────────
 * `lead-audit-comentario-nao-promete-valor.test.ts` vigia a FRASE do comentário
 * (o que a promessa diz). Aqui se vigia o FATO: o que a linha de audit carrega.
 * Um não substitui outro — a frase pode dizer a verdade enquanto o código não
 * faz, e o código pode fazer enquanto alguém reescreve a frase mentindo.
 *
 * ─── Os três casos, e o que cada um provaria se falhasse ────────────────────
 * 1. o par `{ antes, depois }` dos campos tipados que mudaram (controle
 *    positivo: `fields` completo, senão a asserção passaria por vazio);
 * 2. PII não vaza: título (É O NOME DO CLIENTE), descrição, tags e
 *    `custom_fields` não aparecem em nenhum byte do payload de audit;
 * 3. edição só de texto não ganha par nenhum — a linha continua igual à de
 *    antes, porque omitir o vazio é o comportamento declarado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(() => Promise.resolve({ error: null })),
  })),
}));

import { audit } from "@/lib/audit";
import { updateLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

/** O estado ANTES da edição: PII de sobra nos campos de texto. */
const ANTES = {
  id: LEAD,
  organization_id: ORG,
  contact_id: null,
  title: "Carlos — Clínica Vida Odonto",
  description: "Pediu orçamento pelo WhatsApp",
  value_cents: 1000,
  currency: "BRL",
  expected_close_date: "2026-11-30",
  owner_user_id: null,
  owner_agent_id: null,
  tags: ["vip"],
  custom_fields: { cpf: "123.456.789-00" },
  updated_at: "2026-09-15T12:00:00.000Z",
};

const PATCH_CHEIO = {
  value_cents: 2500,
  currency: "USD",
  expected_close_date: "2027-01-15",
  title: "Outro título — aqui não tem cliente nenhum",
  description: "Texto novo digitado por alguém",
  custom_fields: { cpf: "999.888.777-66" },
};

/** Banco falso: ler devolve o estado, gravar nele o atualiza. */
function bancoFalso() {
  const banco: Record<string, unknown> = { ...ANTES };

  const from = (tabela: string) => {
    if (tabela !== "crm_leads") throw new Error(`tabela inesperada: ${tabela}`);
    return {
      select: () => {
        const leitura: Record<string, unknown> = {};
        leitura.eq = () => leitura;
        leitura.maybeSingle = async () => ({ data: { ...banco }, error: null });
        return leitura;
      },
      update: (valores: Record<string, unknown>) => {
        const escrita: Record<string, unknown> = {};
        escrita.eq = () => escrita;
        escrita.select = () => escrita;
        escrita.maybeSingle = async () => {
          Object.assign(banco, valores);
          return { data: { ...banco }, error: null };
        };
        return escrita;
      },
    };
  };

  return {
    from,
    rpc: () => ({
      then: (fn: (r: { error: null }) => void) => Promise.resolve(fn({ error: null })),
    }),
  };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
  requestId: "req-1755",
  idioma: "pt-BR",
};

function chamadaLeadUpdated(): { metadata: Record<string, unknown> } {
  const chamadas = vi.mocked(audit).mock.calls.filter(([entrada]) => entrada.action === "lead.updated");
  expect(chamadas.length, "o handler não gravou lead.updated (controle)").toBe(1);
  return { metadata: chamadas[0]![0].metadata ?? {} };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("o antes-e-depois que a auditoria de lead.updated guarda", () => {
  it("carrega o par antes/depois dos campos tipados que mudaram", async () => {
    await updateLeadHandler(bancoFalso() as never, ctx, LEAD, PATCH_CHEIO);

    const { metadata } = chamadaLeadUpdated();
    const valores = metadata.valores as Record<string, { antes: unknown; depois: unknown }>;

    expect(valores).toEqual({
      value_cents: { antes: 1000, depois: 2500 },
      currency: { antes: "BRL", depois: "USD" },
      expected_close_date: { antes: "2026-11-30", depois: "2027-01-15" },
    });

    // CONTROLE POSITIVO: a edição foi registrada por inteiro. Sem esta perna,
    // uma gravação que não registrasse nada deixaria a asserção acima vermelha
    // pelo motivo errado (e o caso 2 passaria por vazio).
    expect(metadata.fields).toEqual(
      expect.arrayContaining([
        "value_cents",
        "currency",
        "expected_close_date",
        "title",
        "description",
        "custom_fields",
      ]),
    );
    // O responsável e a etapa não mudaram: não podem aparecer inventados.
    expect(valores).not.toHaveProperty("owner_user_id");
    expect(valores).not.toHaveProperty("owner_agent_id");
  });

  it("não deixa PII vazar para o audit", async () => {
    await updateLeadHandler(bancoFalso() as never, ctx, LEAD, PATCH_CHEIO);

    const { metadata } = chamadaLeadUpdated();
    const tudo = JSON.stringify(metadata);

    // CONTROLE: o payload existe e carrega valores — senão os `not.toContain`
    // abaixo passariam por não haver nada para vazar.
    expect(tudo).toContain("value_cents");

    // O título É O NOME DO CLIENTE; a descrição, o CPF em `custom_fields` e
    // as tags são dado do titular/tenant. Nenhum byte deles pode aparecer.
    expect(tudo).not.toContain("Carlos");
    expect(tudo).not.toContain("Outro título");
    expect(tudo).not.toContain("Pediu orçamento");
    expect(tudo).not.toContain("123.456.789-00");
    expect(tudo).not.toContain("999.888.777-66");
    expect(tudo).not.toContain("vip");

    const valores = metadata.valores as Record<string, unknown>;
    for (const colunaDeTexto of ["title", "description", "tags", "custom_fields"]) {
      expect(valores, `a coluna de texto "${colunaDeTexto}" entrou no par antes/depois`).not.toHaveProperty(
        colunaDeTexto,
      );
    }
  });

  it("edição só de texto não ganha par nenhum", async () => {
    await updateLeadHandler(bancoFalso() as never, ctx, LEAD, {
      title: "Título novo sem nada tipado junto",
    });

    const { metadata } = chamadaLeadUpdated();
    expect(metadata.fields).toEqual(["title"]);
    expect(metadata).not.toHaveProperty("valores");
  });
});
