/**
 * #2729 — o histórico do GRUPO entra no atendimento, e cada fala chega com autor.
 *
 * Sonda do mantenedor (comentário do PR #2803, 16/10), trazida para a suíte com
 * o caso de controle 1:1 ao lado: mesma fixture, mesma função que o turno usa
 * (`getLeadContext`), só muda `is_group`.
 *
 * As duas causas medidas por ele, e o que cada caso vigia:
 *
 *   (a) a recebida de grupo ficava com `service_revision` nulo, porque
 *       `fn_service_inbound` saía cedo quando a conversa era de grupo — e a
 *       consulta do histórico exige `messages.service_revision =
 *       c.service_revision`. Sem carimbo, TODA recebida some.
 *   (b) a conversa de grupo nascia com `service_started_at` nulo
 *       (`criarConversaDoGrupo`), e `messages.sent_at >= NULL` nunca é verdade —
 *       TODA enviada some.
 *
 * Aqui os três registros (recebida, enviada, recebida) são gravados com as
 * colunas que `gravarMensagemDeGrupo` grava, DEPOIS se chama `getLeadContext`, e
 * o esperado é a lista inteira: um histórico vazio (o defeito) e um histórico
 * pela metade (só a recebida, ou só a enviada) reprovam.
 *
 * O controle 1:1 no mesmo arquivo é o que impede o teste de passar por acidente:
 * se um conserto quebrasse a conversa individual, o primeiro caso fica vermelho.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

import { seedGov, GOV_ORG, GOV_SESSION } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

const DONA = { name: "Dona", phone: "+5511999990000", lid: null };
const CLIENTE = { name: "Cliente", phone: "+5511888880000", lid: null };

/**
 * Uma conversa com o MESMO roteiro de mensagens, `is_group` parametrizado.
 * Devolve o histórico curado e o contexto cru (para ler o autor de cada linha).
 */
async function cenario(isGroup: boolean) {
  const ct = randomUUID();
  const conv = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [
    ct,
    GOV_ORG,
    "Sonda",
  ]);
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,channel,status,is_group,group_chat_id)
     values($1,$2,$3,$4,'whatsapp','open',$5,$6)`,
    [conv, GOV_ORG, ct, GOV_SESSION, isGroup, isGroup ? `${conv}@g.us` : null],
  );
  const msg = async (
    direction: "inbound" | "outbound",
    body: string,
    segundosAtras: number,
    remetente: typeof DONA | null,
  ) => {
    await pool.query(
      `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at,metadata)
       values($1,$2,$3,$4,'text',$5,$6,'external_device',$7,clock_timestamp() - make_interval(secs => $8),$9)`,
      [
        GOV_ORG,
        conv,
        GOV_SESSION,
        ct,
        direction,
        direction === "inbound" ? "delivered" : "sent",
        body,
        segundosAtras,
        // O ingest grava `group_sender` sob DUAS condições, e a fixture segue
        // as duas: conversa de GRUPO e mensagem RECEBIDA (o eco do celular é a
        // operação humana). Carimbar o campo numa 1:1 seria medir uma conversa
        // que o ingest nunca produz — e é justamente isso que o controle 1:1
        // reprova.
        {
          raw_type: "chat",
          ...(isGroup && direction === "inbound" && remetente !== null
            ? { group_sender: remetente }
            : {}),
        },
      ],
    );
  };
  await msg("inbound", "SONDA_PRIMEIRA", 120, DONA);
  await msg("outbound", "SONDA_RESPOSTA", 60, null);
  await msg("inbound", "SONDA_ATUAL", 0, CLIENTE);
  const r = await getLeadContext(
    pool,
    {} as never,
    { tenantId: GOV_ORG, leadId: ct, conversationId: conv, fuso: "America/Sao_Paulo" },
    { historyLimit: 20, maxTokens: 4000 },
  );
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.context;
}

beforeAll(() => seedGov());
afterAll(async () => {
  await pool.end();
});

describe("#2729 — histórico do grupo no atendimento", () => {
  it("controle 1:1: o turno vê as três mensagens", async () => {
    const ctx = await cenario(false);
    expect(ctx.messages.map((m) => m.body)).toEqual([
      "SONDA_PRIMEIRA",
      "SONDA_RESPOSTA",
      "SONDA_ATUAL",
    ]);
  });

  it("grupo liberado: o turno vê as três mensagens (as duas causas consertadas)", async () => {
    const ctx = await cenario(true);
    expect(ctx.messages.map((m) => m.body)).toEqual([
      "SONDA_PRIMEIRA",
      "SONDA_RESPOSTA",
      "SONDA_ATUAL",
    ]);
  });
});

describe("#2729 — cada recebida do grupo chega ao modelo com quem a escreveu", () => {
  it("grupo: as duas recebidas trazem o participante, e a enviada não inventa um", async () => {
    const ctx = await cenario(true);
    const recebidas = ctx.messages.filter((m) => m.direction === "inbound");
    expect(recebidas.map((m) => m.sender)).toEqual([
      { name: DONA.name, phone: DONA.phone },
      { name: CLIENTE.name, phone: CLIENTE.phone },
    ]);
    const enviada = ctx.messages.find((m) => m.direction === "outbound");
    expect(enviada).toBeDefined();
    expect(enviada).not.toHaveProperty("sender");
  });

  it("controle 1:1: nenhuma mensagem carrega participante — o autor é o contato da ficha", async () => {
    const ctx = await cenario(false);
    expect(ctx.messages.every((m) => !("sender" in m))).toBe(true);
  });
});
