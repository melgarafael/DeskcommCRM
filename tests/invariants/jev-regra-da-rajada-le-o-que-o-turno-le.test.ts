import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { inboundsNaoRespondidos } from "@/lib/agent-engine/agent/inbound-turn";
import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { mensagensDoClienteSemResposta } from "@/workers/ai-sentiment-worker.pedidos";

/**
 * A REGRA DE HOJE, NO WORKER DO JEV, LÊ AS MESMAS MENSAGENS QUE O TURNO (2º
 * conserto da onda 3, G3).
 *
 * O turno roda a regra de hoje sobre TODAS as mensagens do cliente ainda sem
 * resposta (`inboundsNaoRespondidos` sobre o histórico de `getLeadContext`),
 * porque o dreno junta a rajada num turno só: "quero falar com um atendente"
 * seguido de "por favor, alguém de verdade" é um pedido que a regra PEGOU. O
 * worker do Jev olhava só a mensagem dele, e contava a 2ª como um pedido que a
 * regra deixou passar.
 *
 * O worker lê o conjunto por outra consulta (`mensagensDoClienteSemResposta`,
 * sem a janela do agente — ler mais só faz a regra pegar mais). Aqui, cada
 * conversa é lida pelas DUAS, no mesmo banco, e elas têm de devolver o mesmo:
 * o corte na última resposta, a mensagem vazia fora, a transcrição de um áudio
 * no lugar do corpo vazio, o que o cliente disse num atendimento já encerrado
 * fora.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "cca20426-0000-4000-8000-000000000001";
const SESSION = "cca20426-0000-4000-8000-000000000002";

let seq = 10;
function proximoId(): string {
  seq += 1;
  return `cca20426-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

type Passo =
  | {
      direcao: "inbound" | "outbound";
      corpo: string | null;
      /** Um áudio com a transcrição já gravada. */
      transcricao?: string;
    }
  /** Encerra o atendimento: a próxima mensagem do cliente abre outro. */
  | { encerrar: true };

/**
 * Uma conversa nova, de um contato novo, com os passos em ordem. Cada mensagem
 * sai no relógio do banco (`clock_timestamp()`), como a entrada de verdade: é
 * o que faz a mensagem depois de um encerramento reabrir o atendimento.
 */
async function conversaCom(passos: readonly Passo[]): Promise<{ contato: string; conversa: string }> {
  const contato = proximoId();
  const conversa = proximoId();
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Cliente Rajada', $3)`,
    [contato, ORG, `+55119${String(seq).padStart(8, "0")}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false)`,
    [conversa, ORG, contato, SESSION],
  );
  for (const [i, m] of passos.entries()) {
    if ("encerrar" in m) {
      const { rows } = await pool.query<{ service_revision: string }>(
        "select service_revision from conversations where organization_id = $1 and id = $2",
        [ORG, conversa],
      );
      await pool.query("select * from fn_service_status($1, $2, 'closed', $3)", [ORG, conversa, rows[0]!.service_revision]);
      continue;
    }
    const audio = m.transcricao !== undefined;
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction,
                             status, body, sent_via, sent_at, media_storage_path, media_derived_text)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp(), $11, $12)`,
      [
        proximoId(),
        ORG,
        conversa,
        SESSION,
        contato,
        audio ? "audio" : "text",
        m.direcao,
        m.direcao === "inbound" ? "delivered" : "sent",
        m.corpo,
        m.direcao === "inbound" ? "external_device" : "ai",
        audio ? `${ORG}/audio-${i}.ogg` : null,
        m.transcricao ?? null,
      ],
    );
  }
  return { contato, conversa };
}

/** As duas leituras da mesma conversa: a do turno e a do worker do Jev. */
async function asDuas(c: { contato: string; conversa: string }): Promise<{ doTurno: string[]; doJev: string[] }> {
  const contexto = await getLeadContext(
    pool,
    {} as never,
    { tenantId: ORG, leadId: c.contato, conversationId: c.conversa, fuso: "America/Sao_Paulo" },
    { historyLimit: 20, maxTokens: 100_000 },
  );
  if (!contexto.ok) throw new Error(`o contexto do turno não foi lido: ${contexto.error.code}`);
  return {
    doTurno: inboundsNaoRespondidos(contexto.context.messages),
    doJev: await mensagensDoClienteSemResposta(pool, ORG, c.conversa),
  };
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'jev-regra-da-rajada', 'Jev Rajada', 'Jev Rajada') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'jev-rajada', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("as mensagens do cliente ainda sem resposta: o worker do Jev lê o que o turno lê", () => {
  it("a rajada depois de uma resposta: as duas leem só o que veio depois dela", async () => {
    const c = await conversaCom([
      { direcao: "inbound", corpo: "oi" },
      { direcao: "outbound", corpo: "Olá! Como posso ajudar?" },
      { direcao: "inbound", corpo: "quero falar com um atendente" },
      { direcao: "inbound", corpo: "por favor, alguém de verdade" },
    ]);
    const { doTurno, doJev } = await asDuas(c);
    expect(doTurno, "o conjunto do turno (controle: não é vazio)").toEqual(["quero falar com um atendente", "por favor, alguém de verdade"]);
    expect(doJev).toEqual(doTurno);
  });

  it("sem resposta nenhuma: as duas leem tudo o que o cliente escreveu", async () => {
    const c = await conversaCom([
      { direcao: "inbound", corpo: "bom dia" },
      { direcao: "inbound", corpo: "chama o dono" },
    ]);
    const { doTurno, doJev } = await asDuas(c);
    expect(doTurno).toEqual(["bom dia", "chama o dono"]);
    expect(doJev).toEqual(doTurno);
  });

  it("o áudio transcrito entra com o corpo que o turno lê; a mensagem vazia fica de fora", async () => {
    const c = await conversaCom([
      { direcao: "outbound", corpo: "Olá!" },
      { direcao: "inbound", corpo: null, transcricao: "quero falar com uma pessoa" },
      { direcao: "inbound", corpo: "" },
      { direcao: "inbound", corpo: "e aí?" },
    ]);
    const { doTurno, doJev } = await asDuas(c);
    expect(doTurno).toHaveLength(2);
    expect(doTurno[0], "o corpo do áudio é a transcrição enquadrada (controle)").toContain("quero falar com uma pessoa");
    expect(doJev).toEqual(doTurno);
  });

  it("o atendimento encerrado e reaberto: o que o cliente disse no anterior fica de fora, nas duas", async () => {
    const c = await conversaCom([
      { direcao: "inbound", corpo: "quero falar com um atendente" },
      { encerrar: true },
      { direcao: "inbound", corpo: "voltei, tenho outra dúvida" },
    ]);
    const { doTurno, doJev } = await asDuas(c);
    expect(doTurno, "só o do atendimento em vigor (controle)").toEqual(["voltei, tenho outra dúvida"]);
    expect(doJev).toEqual(doTurno);
  });

  it("a última palavra é nossa: nada sem resposta, nas duas", async () => {
    const c = await conversaCom([
      { direcao: "inbound", corpo: "quero falar com um atendente" },
      { direcao: "outbound", corpo: "Já te passo para a equipe." },
    ]);
    const { doTurno, doJev } = await asDuas(c);
    expect(doTurno).toEqual([]);
    expect(doJev).toEqual([]);
  });
});
