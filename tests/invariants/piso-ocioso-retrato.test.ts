/**
 * O RETRATO DO PISO OCIOSO RODA CONTRA O BASELINE — e não fecha o portão com
 * trabalho na fila (#3731).
 *
 * `SQL_DO_RETRATO` (`lib/cron/piso-ocioso.ts`) é uma consulta só, com um
 * `exists` por recurso. Os testes unitários semeiam o retrato e nunca executam
 * a consulta, e a regra de falha do portão ("não sei" = roda) torna um erro
 * nela INVISÍVEL: uma coluna com o nome errado não reprova nada, apenas abre
 * todos os portões para sempre e devolve o piso ocioso inteiro. Este arquivo
 * roda a consulta de verdade e cobra os dois lados:
 *
 * 1. banco recém-instalado → as filas saem `false` (a consulta EXECUTOU — o
 *    erro daria `true` em todas);
 * 2. o trabalho que a rodada faz e o predicado da fila não enxergava → `true`.
 *    São os dois casos em que a rodada faz MAIS do que o `select` principal:
 *    - `agenda-reminder` chama `fn_resolver_avisos_de_lembrete_expirados`, que
 *      resolve o aviso de remetente cujo compromisso já passou. Sem compromisso
 *      futuro o portão fechava e o aviso ficava aberto na Central;
 *    - `mcp-oauth-revogacao` poda os pedidos de autorização vencidos há mais de
 *      um dia. Sem credencial vencida o portão fechava e a poda não rodava.
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { CANAIS_QUE_RESPONDEM_ANTES } from "@/lib/channels/capabilities";
import { esquecerRetrato, recursoTemTrabalho, type RecursoDoCron } from "@/lib/cron/piso-ocioso";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
beforeEach(() => esquecerRetrato());

const FILAS: RecursoDoCron[] = [
  "fila_de_soneca",
  "mensagem_presa",
  "ligacao_presa",
  "redacao_de_storage",
  "devolucao_de_handoff",
  "devolucao_ao_rodizio",
  "canal_vigiado",
  "mcp_a_revogar",
  "lembrete_de_tarefa",
  "lembrete_de_agenda",
  "roteamento",
];

async function leitura(recurso: RecursoDoCron): Promise<boolean> {
  esquecerRetrato();
  return recursoTemTrabalho(recurso, Date.now(), pool);
}

/** Insere sem montar a árvore de FKs: o que se mede é o predicado, não o vínculo. */
async function semFk(sql: string, params: unknown[]): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("set session_replication_role = replica");
    await c.query(sql, params);
  } finally {
    await c.query("set session_replication_role = origin");
    c.release();
  }
}

describe("retrato do piso ocioso contra o baseline", () => {
  it("banco recém-instalado: a consulta executa e as filas saem vazias", async () => {
    for (const recurso of FILAS) {
      expect({ recurso, emUso: await leitura(recurso) }).toEqual({ recurso, emUso: false });
    }
  });

  it("aviso de remetente aberto sem compromisso futuro mantém a agenda acordada", async () => {
    const org = randomUUID();
    const aviso = randomUUID();
    await semFk(
      `insert into agent_inbox_items (id, organization_id, kind, title, ref_kind, ref_id, status)
       values ($1, $2, 'other', 'remetente', 'agenda_reminder_sender', $3, 'open')`,
      [aviso, org, randomUUID()],
    );
    try {
      expect(await leitura("lembrete_de_agenda")).toBe(true);
      // controle: é trabalho de verdade — a limpeza da rodada resolve o aviso
      await pool.query("select public.fn_resolver_avisos_de_lembrete_expirados()");
      expect(await leitura("lembrete_de_agenda")).toBe(false);
    } finally {
      await pool.query("delete from agent_inbox_items where id = $1", [aviso]);
    }
  });

  it("ligação em toque há mais de 3 min mantém o recover-stuck-calls acordado; a recente e a encerrada não", async () => {
    const presa = randomUUID();
    const recente = randomUUID();
    const org = randomUUID();
    const inserir = (id: string, status: string, idade: string) =>
      semFk(
        `insert into voice_calls (id, organization_id, channel_session_id, wacalls_call_id, direction, peer_phone, status, created_at)
         values ($1, $2, $3, $4, 'inbound', '5511999990000', $5, now() - $6::interval)`,
        [id, org, randomUUID(), id, status, idade],
      );
    try {
      await inserir(recente, "ringing", "1 minute");
      expect(await leitura("ligacao_presa")).toBe(false);
      await inserir(presa, "ringing", "4 minutes");
      expect(await leitura("ligacao_presa")).toBe(true);
      // controle: é o estado de toque que acorda o cron, não a linha velha
      await pool.query("update voice_calls set status = 'ended' where id = $1", [presa]);
      expect(await leitura("ligacao_presa")).toBe(false);
    } finally {
      await pool.query("delete from voice_calls where id = any($1::uuid[])", [[presa, recente]]);
    }
  });

  it("outbound `queued` entre 10 min e 25 h mantém o recover-stuck-messages acordado; a recente, a velha e a inbound não", async () => {
    // O aviso da espera esquecida roda DEPOIS do portão: se ele só olhasse `sending`,
    // o caso comum (nada travado, mensagem esperando) nunca chegaria à rota.
    const id = randomUUID();
    const org = randomUUID();
    const inserir = (direction: string, idade: string) =>
      semFk(
        `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id, direction, type, status, created_at)
         values ($1, $2, $3, $4, $5, $6, 'text', 'queued', now() - $7::interval)`,
        [id, org, randomUUID(), randomUUID(), randomUUID(), direction, idade],
      );
    const apagar = () => pool.query("delete from messages where id = $1", [id]);
    try {
      await inserir("outbound", "5 minutes");
      expect(await leitura("mensagem_presa")).toBe(false);
      await apagar();

      await inserir("outbound", "26 hours");
      expect(await leitura("mensagem_presa")).toBe(false);
      await apagar();

      await inserir("inbound", "1 hour");
      expect(await leitura("mensagem_presa")).toBe(false);
      await apagar();

      await inserir("outbound", "1 hour");
      expect(await leitura("mensagem_presa")).toBe(true);
    } finally {
      await apagar();
    }
  });

  it("entrada aceita sem desfecho mantém o webhook-replay acordado; a da captação e a fora da janela não", async () => {
    // O 200 já saiu quando esta linha fica `received`: se o portão não a enxergar,
    // o provedor não reentrega e a mensagem para no arquivo. O filtro de canal vem
    // por parâmetro, que só um Postgres de verdade prova que casa.
    const canal = String(CANAIS_QUE_RESPONDEM_ANTES[0]);
    const aceita = randomUUID();
    const captacao = randomUUID();
    const velha = randomUUID();
    const inserir = (id: string, provider: string, idade: string) =>
      semFk(
        `insert into webhook_events_log (id, organization_id, provider, raw_body, valid_signature, status, received_at)
         values ($1, $2, $3, '{}', true, 'received', now() - $4::interval)`,
        [id, randomUUID(), provider, idade],
      );
    try {
      await inserir(captacao, "generic", "1 minute");
      expect(await leitura("webhook_replay")).toBe(false);
      await inserir(aceita, canal, "1 minute");
      expect(await leitura("webhook_replay")).toBe(true);
      // controle: é a linha sem desfecho que acorda o cron
      await pool.query("update webhook_events_log set status = 'processed' where id = $1", [aceita]);
      expect(await leitura("webhook_replay")).toBe(false);
      // a que passou da janela também acorda: é o cron que a marca `dead` e avisa
      await inserir(velha, canal, "7 hours");
      expect(await leitura("webhook_replay")).toBe(true);
    } finally {
      await pool.query("delete from webhook_events_log where id = any($1::uuid[])", [[aceita, captacao, velha]]);
    }
  });

  it("evento de roteamento na fila mantém o routing-worker acordado — o recente em `processing` não", async () => {
    // #3878: a rota fazia DUAS leituras de `event_log` por minuto, ociosas, só
    // para descobrir que não havia `conversation.routing_requested` a drenar.
    // O portão tem de enxergar exatamente as duas coisas que a rodada enxerga:
    // o `pending` vencido e o `processing` acima da janela de 5 min — e NÃO o
    // `processing` recente, que é um handler rodando (reclamá-lo seria tirar a
    // linha de quem está com ela).
    const inserir = async (status: string, idade: string): Promise<string> => {
      const id = randomUUID();
      await semFk(
        `insert into event_log (id, organization_id, event_type, entity_kind, status, created_at, updated_at)
         values ($1, $2, 'conversation.routing_requested', 'conversation', $3, now() - $4::interval, now() - $4::interval)`,
        [id, randomUUID(), status, idade],
      );
      return id;
    };
    const apagar = (id: string) => pool.query("delete from event_log where id = $1", [id]);

    const concluido = await inserir("done", "1 minute");
    try {
      expect(await leitura("roteamento")).toBe(false);
    } finally {
      await apagar(concluido);
    }

    const naFila = await inserir("pending", "1 minute");
    try {
      expect(await leitura("roteamento")).toBe(true);
    } finally {
      await apagar(naFila);
    }

    const processandoAgora = await inserir("processing", "1 minute");
    try {
      expect(await leitura("roteamento")).toBe(false);
    } finally {
      await apagar(processandoAgora);
    }

    const processandoPreso = await inserir("processing", "6 minutes");
    try {
      expect(await leitura("roteamento")).toBe(true);
    } finally {
      await apagar(processandoPreso);
    }
  });

  it("pedido de autorização MCP vencido há mais de um dia mantém a revogação acordada", async () => {
    const id = "a".repeat(43);
    await semFk(
      `insert into mcp_oauth_pedidos
         (id, organization_id, servidor_id, contact_id, code_verifier_encrypted, code_verifier_iv, code_verifier_tag, expira_em)
       values ($1, $2, $3, $4, '\\x00', '\\x00', '\\x00', now() - interval '2 days')`,
      [id, randomUUID(), randomUUID(), randomUUID()],
    );
    try {
      expect(await leitura("mcp_a_revogar")).toBe(true);
    } finally {
      await pool.query("delete from mcp_oauth_pedidos where id = $1", [id]);
    }
    expect(await leitura("mcp_a_revogar")).toBe(false);
  });
});
