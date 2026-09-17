import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// O dublê de funil importa `requireRole`/`createClient` de verdade; sem estes
// mocks a importação real valida env no boot (mesmo padrão de
// `lib/automation/actions/create-or-move-lead.test.ts`).
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { listaAgendamentos } from "@/lib/agenda/consulta";
import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/create-or-move-lead";
import type { ActionCtx } from "@/lib/automation/types";
import { ORG_ID, PIPE, etapa, funilRow, makeDb } from "@/tests/helpers/stages-db-double";

/**
 * DOIS PONTOS QUE MONTAVAM O NOME DO CONTATO À MÃO, E QUE A GUARDA DE TEXTO
 * SOZINHA NÃO SEGURA.
 *
 * A revisão do #907 achou mais cópias da cadeia `name ?? display_name` fora da
 * função central, todas SEM a guarda de identificador técnico. Elas foram
 * convertidas, e `tests/unit/rotulo-do-contato.test.ts` reprova quem remontar a
 * cadeia por TEXTO. Texto não é comportamento: um `contact.phone_number ??
 * "Lead da automação"` que largasse o nome inteiro passaria por qualquer regex
 * sobre `display_name`. Este arquivo assere o que sai.
 *
 *  - **o título do negócio que a automação cria.** É o único dos pontos em que
 *    o nome é GRAVADO (`crm_leads.title`), e título de negócio não se reescreve
 *    sozinho depois — um `Contato 543134@lid` ali fica no quadro para sempre.
 *  - **o nome do contato na listagem da agenda** (`listaAgendamentos`), que a
 *    grade mostra e que o AGENTE lê para dizer "você já tem consulta marcada".
 *    O embed do PostgREST chega objeto OU array conforme o gerador de tipos; as
 *    duas formas têm caso.
 */

const ETAPA = etapa({ id: "novo", name: "Novo", position: 1000 });

async function tituloCriadoPara(contato: {
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
}): Promise<unknown> {
  const db = makeDb({ pipelines: [funilRow({ id: PIPE, name: "Funil" })], stages: [ETAPA], leads: [] });
  const ctx: ActionCtx = {
    admin: db.client as unknown as ActionCtx["admin"],
    organizationId: ORG_ID,
    ruleId: "rule-1",
    ruleName: "Primeiro contato",
    event: {} as ActionCtx["event"],
    requestId: "req-1",
    context: { contact: { id: "contato-1", ...contato } },
  };
  const resultado = await getAction("create_or_move_lead")!.execute(ctx, { pipeline_id: PIPE, stage_id: "novo" });
  expect(resultado.status).toBe("success");
  expect(db.tabelas.crm_leads).toHaveLength(1);
  return db.tabelas.crm_leads[0]?.title;
}

describe("a automação titula o negócio pelo nome escolhido", () => {
  it("o nome da ficha vence o do perfil do WhatsApp", async () => {
    expect(await tituloCriadoPara({ name: "Kaio Gomes", display_name: "🌸 Kaio", phone_number: "+5531988887777" })).toBe(
      "Kaio Gomes",
    );
  });

  it("identificador técnico não vira título: cai no telefone", async () => {
    // O fallback de quem GRAVA o título é o telefone — melhor que um código
    // interno do WhatsApp e melhor que o genérico "Lead da automação".
    expect(
      await tituloCriadoPara({ name: null, display_name: "Contato 543134@lid", phone_number: "+5531988887777" }),
    ).toBe("+5531988887777");
  });
});

/** O banco como `listaAgendamentos` o lê: uma consulta a `calendar_appointments`, encadeada. */
function agendaCom(contacts: unknown): SupabaseClient {
  const linha = {
    id: "ag-1",
    title: "Consulta",
    starts_at: "2026-09-20T13:00:00.000Z",
    ends_at: "2026-09-20T13:30:00.000Z",
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    revision: 1,
    meeting_state: "none",
    meeting_url: null,
    owner_user_id: null,
    contact_id: "contato-1",
    contacts,
  };
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    in: () => chain,
    gte: () => chain,
    lt: () => chain,
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [linha], error: null }).then(res),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

async function nomeNaAgenda(contacts: unknown): Promise<string | null> {
  const r = await listaAgendamentos(agendaCom(contacts), ORG_ID, { contactId: "contato-1", limite: 20 });
  if (!r.ok) throw new Error(`a listagem recusou: ${r.codigo}`);
  expect(r.agendamentos).toHaveLength(1);
  return r.agendamentos[0]!.contatoNome;
}

describe("a agenda chama o contato pelo nome escolhido", () => {
  it("embed como OBJETO: o nome da ficha vence o do perfil do WhatsApp", async () => {
    expect(await nomeNaAgenda({ name: "Kaio Gomes", display_name: "🌸 Kaio" })).toBe("Kaio Gomes");
  });

  it("embed como ARRAY: identificador técnico não vira nome de gente", async () => {
    expect(await nomeNaAgenda([{ name: null, display_name: "Contato 543134@lid" }])).toBeNull();
  });

  it("sem nome na ficha, o do perfil do WhatsApp aparece — não some", async () => {
    expect(await nomeNaAgenda([{ name: null, display_name: "Kaio" }])).toBe("Kaio");
  });
});
