/**
 * #4580, item 1 — AS MENSAGENS ENVIADAS DO HISTÓRICO DIZEM QUEM AS ESCREVEU.
 *
 * O defeito medido: `LeadContextMessage.sender` só existia nas recebidas de grupo
 * (#2729). A resposta do agente de vendas, a do agente de suporte e a de uma
 * pessoa da equipe chegavam ao modelo como a MESMA voz ("nós"), e o agente lia o
 * que outro escreveu como se fosse dele.
 *
 * O que este arquivo prende, pela função que o turno usa (`getLeadContext`):
 *
 *   1. Três enviadas de autores diferentes (agente A, agente B, pessoa da equipe)
 *      chegam com TRÊS autores distintos, no MESMO campo `sender` do grupo e com
 *      o mesmo shape `{ name, phone }` — nada de segundo campo.
 *   2. O vocabulário é o da tela (`MessageBubble.senderLabel`): `IA · {nome}`,
 *      `Atendente · {primeiro nome}`, e o rótulo que `sent_via` garante quando não
 *      é gente nem agente.
 *   3. Recebida 1:1 continua sem `sender` (o autor é o contato da ficha), e a
 *      recebida de grupo continua com o participante — o conserto não mexe nisso.
 *   4. Registro antigo sem autor não derruba a montagem: sem o nome do agente o
 *      rótulo é `IA`; sem a coluna do autor, o campo fica ausente. Nada inventado.
 *   5. O nome da pessoa custa UMA consulta por contexto, com ids DISTINTOS — e
 *      nenhuma quando não há enviada de gente.
 */
import { describe, expect, it } from "vitest";

import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

const PESSOA = "11111111-1111-4111-8111-111111111111";
const OUTRA_PESSOA = "22222222-2222-4222-8222-222222222222";
// `phone` nulo: o schema do participante aceita nome sem telefone, e este
// arquivo não precisa de número nenhum para provar quem falou.
const GRUPO = { name: "Dona", phone: null, lid: null };

type Linha = Record<string, unknown>;

/** Uma linha de `messages` como a consulta do histórico a devolve. */
function linha(extra: Linha): Linha {
  return {
    direction: "outbound",
    type: "text",
    body: "texto",
    media_url: null,
    media_storage_path: null,
    media_mime: null,
    media_derived_text: null,
    sent_at: new Date("2026-11-10T12:00:00Z"),
    metadata: {},
    sent_via: "crm",
    sent_by_user_id: null,
    ...extra,
  };
}

interface Consulta {
  sql: string;
  params: unknown[];
}

function dbFalso(
  mensagens: Linha[],
  nomes: Array<{ user_id: string; full_name: string | null }> = [],
) {
  const consultas: Consulta[] = [];
  return {
    consultas,
    db: {
      query: async (sql: string, params: unknown[]) => {
        consultas.push({ sql, params });
        if (sql.includes("from contacts")) {
          return {
            rows: [
              {
                name: "Carlos",
                display_name: null,
                email: null,
                phone_number: "+551****0000",
                tags: [],
                is_blocked: false,
                is_personal: false,
                source: "whatsapp",
                consent: null,
                is_anonymized: false,
              },
            ],
          };
        }
        // A consulta do histórico tem um `exists (select 1 from conversations ...)`
        // dentro: casar por "from conversations" antes de "from messages"
        // devolveria a conversa como se fosse mensagem.
        if (sql.includes("from messages")) return { rows: mensagens };
        if (sql.includes("select id from conversations")) return { rows: [{ id: "conv-1" }] };
        if (sql.includes("fn_nomes_dos_membros")) return { rows: nomes };
        return { rows: [] };
      },
    },
  };
}

const KNOBS = { historyLimit: 20, maxTokens: 100_000 };
const ENTRADA = { tenantId: "org-1", leadId: "contato-1", fuso: "America/Sao_Paulo" };

async function contexto(
  mensagens: Linha[],
  nomes: Array<{ user_id: string; full_name: string | null }> = [],
) {
  const { db, consultas } = dbFalso(mensagens, nomes);
  const r = await getLeadContext(db as never, {} as never, ENTRADA, KNOBS);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { ctx: r.context, consultas };
}

describe("#4580 — o histórico diz quem escreveu cada mensagem enviada", () => {
  it("agente A, agente B e uma pessoa da equipe chegam como TRÊS autores", async () => {
    // A consulta devolve da mais nova para a mais antiga; o contexto inverte.
    const { ctx } = await contexto(
      [
        linha({ id: "m4", direction: "inbound", sent_via: "external_device" }),
        linha({ id: "m3", sent_via: "user", sent_by_user_id: PESSOA }),
        linha({ id: "m2", sent_via: "ai", metadata: { ai_actor_id: "run-2", ai_actor_name: "Bia" } }),
        linha({ id: "m1", sent_via: "ai", metadata: { ai_actor_id: "run-1", ai_actor_name: "Clara" } }),
      ],
      [{ user_id: PESSOA, full_name: "Andreia Cristina de Souza" }],
    );

    expect(ctx.messages.map((m) => m.sender)).toEqual([
      { name: "IA · Clara", phone: null },
      { name: "IA · Bia", phone: null },
      { name: "Atendente · Andreia", phone: null },
      undefined,
    ]);

    const autores = ctx.messages.map((m) => m.sender?.name);
    expect(new Set(autores.filter((n) => n !== undefined)).size).toBe(3);
  });

  it("o autor viaja no MESMO campo e shape do grupo — nada de segundo campo", async () => {
    const { ctx } = await contexto([
      linha({ id: "m1", sent_via: "ai", metadata: { ai_actor_name: "Clara" } }),
    ]);
    expect(Object.keys(ctx.messages[0]!.sender!)).toEqual(["name", "phone"]);
    expect(ctx.messages[0]!.sender).toEqual({ name: "IA · Clara", phone: null });
  });

  it("recebida 1:1 continua sem autor, e a de grupo continua com o participante", async () => {
    const { ctx } = await contexto([
      linha({ id: "m3", direction: "inbound", metadata: { group_sender: GRUPO } }),
      linha({ id: "m2", direction: "inbound", metadata: { raw_type: "chat" } }),
      linha({ id: "m1", sent_via: "ai", metadata: { ai_actor_name: "Clara" } }),
    ]);
    const recebidas = ctx.messages.filter((m) => m.direction === "inbound");
    expect(recebidas[0]).not.toHaveProperty("sender");
    expect(recebidas[1]!.sender).toEqual({ name: GRUPO.name, phone: GRUPO.phone });
  });

  it("registro antigo sem autor não derruba a montagem nem inventa nome", async () => {
    const { ctx } = await contexto([
      linha({ id: "m4" }),
      linha({ id: "m3", sent_via: "crm", sent_by_user_id: null }),
      linha({ id: "m2", sent_via: "ai", metadata: null }),
      linha({ id: "m1", sent_via: null, metadata: null }),
    ]);
    expect(ctx.messages.map((m) => m.sender)).toEqual([
      undefined, // sem a coluna do autor: não há o que afirmar
      { name: "IA", phone: null }, // IA anterior ao nome gravado (#3649)
      { name: "Atendente", phone: null }, // crm sem id: o default da coluna
      { name: "Atendente", phone: null },
    ]);
  });

  it("quem enviou pela tela sai com o nome resolvido em UMA consulta de ids distintos", async () => {
    const { consultas } = await contexto(
      [
        linha({ id: "m3", sent_via: "user", sent_by_user_id: PESSOA }),
        linha({ id: "m2", sent_via: "crm", sent_by_user_id: PESSOA }),
        linha({ id: "m1", sent_via: "user", sent_by_user_id: OUTRA_PESSOA }),
      ],
      [
        { user_id: PESSOA, full_name: "Andreia Cristina" },
        { user_id: OUTRA_PESSOA, full_name: "Thamyres" },
      ],
    );
    const deNomes = consultas.filter((c) => c.sql.includes("fn_nomes_dos_membros"));
    expect(deNomes).toHaveLength(1);
    expect(deNomes[0]!.params).toEqual(["org-1", [OUTRA_PESSOA, PESSOA]]);
  });

  it("a consulta do histórico lê a coluna de quem enviou nas DUAS janelas", async () => {
    const { consultas } = await contexto([linha({ id: "m1", sent_via: "ai" })]);
    const historico = consultas.find((c) => c.sql.includes("from messages"));
    expect(historico).toBeDefined();
    // Duas janelas (últimas N mensagens e o modelo fixado): sem a coluna em UMA
    // delas, metade do histórico volta a não dizer quem escreveu — em silêncio.
    expect(historico!.sql.split("sent_via, sent_by_user_id, sent_on_behalf_of_user_id").length - 1).toBe(2);
  });

  it("'em nome de' só vale com a coluna gravada pelo servidor, a mesma guarda do balão", async () => {
    const { ctx } = await contexto([
      linha({
        id: "m2",
        sent_via: "ai",
        sent_on_behalf_of_user_id: null,
        metadata: { ai_actor_name: "Clara", sent_on_behalf: { user_name: "Outro Nome" } },
      }),
      linha({
        id: "m1",
        sent_via: "system",
        sent_on_behalf_of_user_id: PESSOA,
        metadata: { sent_on_behalf: { user_name: "Andreia Cristina de Souza", token_name: "ERP" } },
      }),
    ]);
    expect(ctx.messages.map((m) => m.sender)).toEqual([
      // coluna preenchida: a pessoa, e só o primeiro nome, como nos outros ramos
      { name: "Atendente · Andreia", phone: null },
      // coluna nula: o metadata não decide o autor
      { name: "IA · Clara", phone: null },
    ]);
  });

  it("conversa sem enviada de gente não paga a consulta de nomes", async () => {
    const { consultas } = await contexto([
      linha({ id: "m2", direction: "inbound" }),
      linha({ id: "m1", sent_via: "ai", metadata: { ai_actor_name: "Clara" } }),
    ]);
    expect(consultas.some((c) => c.sql.includes("fn_nomes_dos_membros"))).toBe(false);
  });
});
