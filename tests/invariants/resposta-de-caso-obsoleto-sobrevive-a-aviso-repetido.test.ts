import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { registrarRespostaDeCasoObsoleto } from "@/lib/atendimento/aviso-caso-obsoleto";
import { GOV_AGENT_A, GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * A RESPOSTA REGISTRADA NÃO SE PERDE QUANDO O AVISO JÁ ESTÁ ABERTO.
 *
 * `registrarRespostaDeCasoObsoleto` roda numa transação explícita: resolve o
 * caso e insere o aviso de conversa no MESMO commit. Desde a 0538 esse aviso
 * tem índice único parcial — e um `23505` DENTRO da transação a deixa em estado
 * abortado: o catch do `insertInboxItem` devolve `null`, mas o `commit` seguinte
 * viraria ROLLBACK silencioso, e a resposta que o humano acabou de registrar
 * sumiria. Quem impede é o savepoint em volta do aviso.
 *
 * Este arquivo reproduz a corrida de propósito, sem sorte de timing: um segundo
 * escritor (o worker, no caso real) insere o mesmo aviso e SEGURA o commit; a
 * rota chega no índice e espera (o `insert` não enxerga a linha não commitada,
 * então não é a guarda que a barra — é o índice); o commit do outro sai; a rota
 * recebe o `23505`. Sem o savepoint, o caso ficaria `awaiting_human` e o evento
 * humano não existiria; com ele, a resolução commita e sobra UM aviso aberto.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 5,
});

beforeAll(() => {
  seedGov();
});

afterAll(async () => {
  await pool.end();
});

describe("a resposta a caso obsoleto sobrevive ao aviso repetido", () => {
  it("com o índice segurado por outro escritor, o caso resolve e sobra UM aviso aberto", async () => {
    // Contato próprio: o seed já abre uma conversa para GOV_CONTACT_1 nesta sessão,
    // e `uniq_conversations_1to1_per_contact_session` recusaria a segunda.
    const contact = randomUUID();
    await pool.query(
      `insert into contacts(id, organization_id, display_name) values ($1, $2, 'Caso obsoleto')`,
      [contact, GOV_ORG],
    );
    const conversation = randomUUID();
    await pool.query(
      `insert into conversations(id, organization_id, contact_id, channel_session_id, status)
       values ($1, $2, $3, $4, 'open')`,
      [conversation, GOV_ORG, contact, GOV_SESSION],
    );
    const caseId = randomUUID();
    await pool.query(
      `insert into agent_cases(id, organization_id, conversation_id, title, summary, blocker)
       values ($1, $2, $3, 'Caso', 'Resumo', 'Humano')`,
      [caseId, GOV_ORG, conversation],
    );

    const blocker = await pool.connect();
    let resposta: Promise<boolean> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
         values ($1, 'job_dead', 'warn', 'Resposta registrada; atendimento mudou', 'Motivo: teste', 'conversation', $2)`,
        [GOV_ORG, conversation],
      );

      resposta = registrarRespostaDeCasoObsoleto(
        pool,
        GOV_ORG,
        caseId,
        GOV_AGENT_A,
        "Resposta registrada",
      );

      // A rota só chega no índice depois de resolver o caso; o que a prende é a
      // entrada NÃO COMMITADA do outro escritor (espera de transação, `Lock`).
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const { rows } = await pool.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query like '%insert into agent_inbox_items%'`,
        );
        if (rows[0]!.n > 0) {
          waiting = true;
          break;
        }
        await pool.query("select pg_sleep(0.01)");
      }
      expect(waiting, "a rota não parou no índice — sem a espera, não há corrida para medir").toBe(
        true,
      );

      await blocker.query("commit");

      const registered = await resposta;
      expect(registered, "a resposta registrada se perdeu: o commit virou rollback").toBe(true);
      expect(
        (await pool.query("select status from agent_cases where id=$1", [caseId])).rows[0].status,
        "o caso não ficou resolvido — o 23505 derrubou a transação inteira",
      ).toBe("resolved");
      expect(
        (
          await pool.query(
            `select count(*)::int as n from agent_inbox_items
              where organization_id = $1 and kind = 'job_dead' and ref_kind = 'conversation'
                and ref_id = $2 and status = 'open'`,
            [GOV_ORG, conversation],
          )
        ).rows[0].n,
        "sobra mais de um aviso aberto para a conversa",
      ).toBe(1);
    } catch (error) {
      await blocker.query("rollback").catch(() => {});
      await Promise.resolve(resposta).catch(() => {});
      throw error;
    } finally {
      blocker.release();
    }

    await pool.query("delete from agent_inbox_items where organization_id = $1 and ref_id = $2", [
      GOV_ORG,
      conversation,
    ]);
    await pool.query("delete from agent_cases where id = $1", [caseId]);
    await pool.query("delete from conversations where id = $1", [conversation]);
    await pool.query("delete from contacts where id = $1", [contact]);
  });
});
