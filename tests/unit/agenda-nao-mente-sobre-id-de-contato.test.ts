/**
 * A AGENDA NÃO DEVOLVE "NADA MARCADO" PARA UM ID QUE NÃO É LEAD (issue #509).
 *
 * ─── A cadeia, medida em c5b45b24 ───────────────────────────────────────────
 *
 * No motor, `leadId` É o `contact_id` — e o próprio arquivo declara isso:
 *
 *     lib/agent-engine/agent/inbound-turn.ts:1121
 *         const leadIdDoJob = job.contact_id;
 *     lib/agent-engine/edge/crm/get-lead-context.ts:193
 *         // Filtra por `contact_id` porque deste lado da casa `leadId` é o CONTATO
 *
 * Só que o campo publicado no contexto do turno chama-se `lead_id`
 * (get-lead-context.ts:236). O modelo lê "lead_id" e passa esse valor ao
 * parâmetro `lead_id` de `crm_list_appointments` — que espera o id de um
 * NEGÓCIO do funil.
 *
 * A consulta então procura vínculos em `crm_lead_links` para um id que não é
 * lead, não acha nenhum, e devolve `{ ok: true, agendamentos: [] }`
 * (consulta.ts:431). O agente conclui que o cliente não tem nada marcado —
 * e NEGA ao cliente um compromisso que ele mesmo acabou de marcar.
 *
 * Nada reclama: a consulta é válida, lista vazia é resposta legítima, e o
 * modelo não tem como suspeitar.
 *
 * ─── E os dois parâmetros não se distinguem ─────────────────────────────────
 *
 *     lib/mcp/tools/agendamento.ts:274-275
 *         contact_id: z.string().uuid().optional(),
 *         lead_id: z.string().uuid().optional(),
 *
 * Nenhum dos dois tem `.describe()`. O modelo escolhe entre eles sem nada que
 * os separe — e a única pista que ele tem é o nome do campo no contexto, que
 * está errado.
 */
import { describe, expect, it } from "vitest";

import { listaAgendamentos } from "@/lib/agenda/consulta";
import { crmListAppointments } from "@/lib/mcp/tools/agendamento";

const ORG = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

/**
 * Dublê que distingue as tabelas: `crm_lead_links` sem vínculo, e `crm_leads`
 * respondendo se aquele id É um lead. Sem a segunda, o teste não conseguiria
 * separar "lead sem nada marcado" de "isto nem é um lead" — que é a distinção
 * inteira desta issue.
 */
function db(opts: { ehLead: boolean; vinculos?: string[] }) {
  const consultas: string[] = [];
  const q = (tabela: string) => {
    const enc: Record<string, unknown> = {};
    const passa = () => enc;
    for (const m of ["select", "eq", "in", "order", "limit", "gte", "lt", "lte", "is", "not"]) {
      enc[m] = passa;
    }
    enc.maybeSingle = async () => ({
      data: tabela === "crm_leads" && opts.ehLead ? { id: ID } : null,
      error: null,
    });
    enc.then = (ok: (v: unknown) => unknown) => {
      consultas.push(tabela);
      if (tabela === "crm_lead_links") {
        return Promise.resolve(
          ok({ data: (opts.vinculos ?? []).map((t) => ({ target_id: t })), error: null }),
        );
      }
      if (tabela === "crm_leads") {
        return Promise.resolve(ok({ data: opts.ehLead ? [{ id: ID }] : [], error: null }));
      }
      return Promise.resolve(ok({ data: [], error: null }));
    };
    return enc;
  };
  return { consultas, supabase: { from: (t: string) => q(t) } as never };
}

describe("listaAgendamentos — id que não é lead não vira 'nada marcado'", () => {
  it("⭐ id de CONTATO passado como lead_id vira recusa que ensina, não lista vazia", async () => {
    const { supabase } = db({ ehLead: false, vinculos: [] });

    const r = await listaAgendamentos(supabase, ORG, { leadId: ID, limite: 10 } as never);

    expect(
      r.ok,
      "devolveu lista vazia para um id que não é lead — o agente conclui que o cliente não tem nada marcado e nega um compromisso que ele mesmo criou",
    ).toBe(false);
    if (r.ok) return;
    // A recusa tem de NOMEAR o caminho certo: sem isso o modelo repete o erro.
    expect(String(r.motivoParaOperador ?? "") + String(r.motivoParaCliente ?? "")).toContain(
      "contact_id",
    );
  });

  it("⭐ lead REAL sem nada marcado continua devolvendo lista vazia — e deve", async () => {
    // Controle na direção oposta. Sem ele, um conserto que recusasse todo lead
    // sem vínculo passaria — e quebraria a resposta certa para "este negócio
    // não tem nada marcado", que é diferente de "não sei".
    const { supabase } = db({ ehLead: true, vinculos: [] });

    const r = await listaAgendamentos(supabase, ORG, { leadId: ID, limite: 10 } as never);

    expect(r.ok, "recusou um lead legítimo que simplesmente não tem compromissos").toBe(true);
    if (!r.ok) return;
    expect(r.agendamentos).toEqual([]);
  });

  it("a checagem extra só roda no ramo que ia devolver vazio", async () => {
    // Custo: nenhum lead com vínculos paga a consulta a mais.
    const { supabase, consultas } = db({ ehLead: true, vinculos: ["ag-1"] });

    await listaAgendamentos(supabase, ORG, { leadId: ID, limite: 10 } as never);

    expect(consultas.filter((t) => t === "crm_leads")).toEqual([]);
  });

  it("busca por contact_id não é tocada pelo conserto", async () => {
    const { supabase } = db({ ehLead: false });

    const r = await listaAgendamentos(supabase, ORG, { contactId: ID, limite: 10 } as never);

    expect(r.ok).toBe(true);
  });
});

describe("a ferramenta distingue os dois parâmetros", () => {
  const shape = (crmListAppointments as { inputSchema: Record<string, { description?: string }> })
    .inputSchema;

  it("controle positivo: o instrumento enxerga descrições onde elas já existem", () => {
    // `dia` já tinha `.describe()`. Sem esta cerca, um recorte que parasse de
    // ler as descrições faria as asserções abaixo passarem por vacuidade.
    expect(shape.dia?.description ?? "").not.toBe("");
  });

  it("⭐ contact_id diz que é a PESSOA, e cita o campo do contexto do turno", () => {
    const d = shape.contact_id?.description ?? "";
    expect(d, "contact_id não tem descrição: o modelo escolhe entre os dois no escuro").not.toBe("");
    expect(/pessoa|contato/i.test(d)).toBe(true);
  });

  it("⭐ lead_id diz que é o NEGÓCIO do funil, não a pessoa", () => {
    const d = shape.lead_id?.description ?? "";
    expect(d, "lead_id não tem descrição").not.toBe("");
    expect(/negóci|funil|oportunidade/i.test(d)).toBe(true);
  });
});
