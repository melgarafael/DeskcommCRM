/**
 * O PREENCHIMENTO DE RESPOSTA PRONTA DURANTE UM TURNO — o texto montado é do
 * contato desta conversa, e de mais ninguém.
 *
 * `crm_render_message_template` lê o contato e o negócio para trocar as
 * marcações (`{{nome}}`, `{{contact.phone_number}}`, `{{lead.title}}`). Com o
 * contato do turno na mão (`ctx.contatoDoTurno`, contexto de confiança), o que
 * vale:
 *
 * - `contact_id` de outro contato → `fora_da_conversa`;
 * - `lead_id` cujo `crm_leads.contact_id` não é o do turno → a MESMA recusa,
 *   inclusive para negócio inexistente (resposta idêntica, sem distinguir);
 * - nada informado → o contato do turno;
 * - fora do turno (integrador, pessoa) → como antes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { McpContext } from "@/lib/mcp/types";
import { crmRenderMessageTemplate } from "@/lib/mcp/tools/operacao";
import { ORG_ID, makeDb, negocio } from "@/tests/helpers/stages-db-double";

const MODELO = "66666666-6666-4666-8666-666666666666";
const DO_TURNO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEGOCIO_DO_TURNO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEGOCIO_DO_OUTRO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NEGOCIO_SEM_CONTATO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEGOCIO_INEXISTENTE = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function banco() {
  const db = makeDb({
    leads: [
      negocio(NEGOCIO_DO_TURNO, "s1", { contact_id: DO_TURNO }),
      negocio(NEGOCIO_DO_OUTRO, "s1", { contact_id: OUTRO }),
      negocio(NEGOCIO_SEM_CONTATO, "s1", { contact_id: null }),
    ],
    contacts: [
      { id: DO_TURNO, organization_id: ORG_ID, name: "Ana", phone_number: "+5511900000001", email: null },
      { id: OUTRO, organization_id: ORG_ID, name: "Bruno", phone_number: "+5511900000002", email: null },
    ],
  });
  (db.tabelas as unknown as Record<string, unknown[]>).message_templates = [
    {
      id: MODELO,
      organization_id: ORG_ID,
      owner_user_id: null,
      title: "Saudação",
      body: "Olá {{nome}}, seu telefone é {{contact.phone_number}}",
    },
  ];
  return db;
}

function ctx(db: ReturnType<typeof makeDb>, contatoDoTurno?: string): McpContext {
  return {
    organizationId: ORG_ID,
    role: "ai_operator",
    actor: { type: "api_token", id: "tok-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: db.client as unknown as SupabaseClient,
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  };
}

type Pedido = Parameters<typeof crmRenderMessageTemplate.handler>[0];

async function preencher(pedido: Omit<Pedido, "template_id">, contatoDoTurno?: string) {
  return (await crmRenderMessageTemplate.handler(
    { template_id: MODELO, ...pedido } as Pedido,
    ctx(banco(), contatoDoTurno),
  )) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("crm_render_message_template com contato do turno", () => {
  it("⭐ contact_id de outro contato é recusado, e nada dele sai", async () => {
    const r = await preencher({ contact_id: OUTRO }, DO_TURNO);

    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(JSON.stringify(r)).not.toContain("Bruno");
    expect(JSON.stringify(r)).not.toContain("+5511900000002");
  });

  it("⭐ lead_id de negócio de outro contato é recusado", async () => {
    const r = await preencher({ lead_id: NEGOCIO_DO_OUTRO }, DO_TURNO);

    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(JSON.stringify(r)).not.toContain("Bruno");
  });

  it("⭐ contact_id do turno com lead_id de outro contato também é recusado", async () => {
    const r = await preencher({ contact_id: DO_TURNO, lead_id: NEGOCIO_DO_OUTRO }, DO_TURNO);

    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
  });

  it("negócio inexistente e negócio sem contato dão a MESMA recusa do negócio alheio", async () => {
    const alheio = await preencher({ lead_id: NEGOCIO_DO_OUTRO }, DO_TURNO);
    const inexistente = await preencher({ lead_id: NEGOCIO_INEXISTENTE }, DO_TURNO);
    const semContato = await preencher({ lead_id: NEGOCIO_SEM_CONTATO }, DO_TURNO);

    expect(inexistente).toEqual(alheio);
    expect(semContato).toEqual(alheio);
  });

  it("sem contact_id nem lead_id, preenche com o contato do turno", async () => {
    const r = await preencher({}, DO_TURNO);

    expect(r.texto).toBe("Olá Ana, seu telefone é +5511900000001");
  });

  it("contact_id do turno preenche normalmente", async () => {
    const r = await preencher({ contact_id: DO_TURNO }, DO_TURNO);

    expect(r.texto).toBe("Olá Ana, seu telefone é +5511900000001");
  });

  it("lead_id igual ao contato do turno é a confusão contato × negócio: preenche com o contato", async () => {
    const r = await preencher({ lead_id: DO_TURNO }, DO_TURNO);

    expect(r.texto).toBe("Olá Ana, seu telefone é +5511900000001");
  });

  it("lead_id de negócio do turno preenche com o contato dele", async () => {
    const r = await preencher({ lead_id: NEGOCIO_DO_TURNO }, DO_TURNO);

    expect(r.texto).toBe("Olá Ana, seu telefone é +5511900000001");
  });
});

describe("crm_render_message_template fora do turno — nada muda", () => {
  it("o integrador preenche com qualquer contato da organização", async () => {
    const r = await preencher({ contact_id: OUTRO });

    expect(r.texto).toBe("Olá Bruno, seu telefone é +5511900000002");
  });

  it("e com qualquer negócio da organização", async () => {
    const r = await preencher({ lead_id: NEGOCIO_DO_OUTRO });

    expect(r.texto).toBe("Olá Bruno, seu telefone é +5511900000002");
  });
});
