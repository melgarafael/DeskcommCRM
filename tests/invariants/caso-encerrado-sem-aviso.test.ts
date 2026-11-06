/**
 * #3810 — ENCERRAR SEM AVISAR O CLIENTE, CONTRA POSTGRES DE VERDADE.
 *
 * O unitário (`tests/unit/caso-encerrado-sem-aviso.test.ts`) prova a ROTA: que
 * ela não chama `enqueueJob`/handoff/aviso e que manda a nota certa. O que só o
 * banco de verdade responde é o resto, e é onde o defeito mora:
 *
 *   1. `agent_cases.status` vira `cancelled` — e não `resolved`, que fingiria
 *      que alguém concluiu algo.
 *   2. A NOTA existe em `agent_case_events`, com `actor_kind='human'` e o
 *      `actor_user_id` de quem decidiu. `'user'` (o vocabulário do issue) NÃO
 *      passa no CHECK de `actor_kind` — aqui isso é medido no banco, não
 *      deduzido do texto da migration.
 *   3. **ZERO job**: nada em `job_queue` para a conversa. É o ponto do issue —
 *      um `case_reply_turn` enfileirado faria a IA falar com o cliente que a
 *      pessoa decidiu não avisar.
 *   4. Os avisos do sino do caso (`agent_inbox_items.ref_id`) saem de `open` — e
 *      os de OUTRO caso não são tocados (controle positivo do instrumento).
 *
 * A função chamada é a MESMA que a rota usa (`encerrarChamadoPelaPessoa`), sobre
 * um `pg.Pool` apontado ao container efêmero — não uma cópia do SQL escrita aqui,
 * que mediria o teste contra ele mesmo.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encerrarChamadoPelaPessoa } from "@/lib/agent-engine/agent/human-cases";

import { GOV_AGENT_A, GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

/** Fixtures PRÓPRIAS: este arquivo mexe em `agent_inbox_items` e em `job_queue`. */
const SEM_AVISO_CONTATO = "cccccccc-3333-4000-8000-0000000000b1";
const SEM_AVISO_CONVERSA = "cccccccc-4444-4000-8000-0000000000b1";
/**
 * O caso VIZINHO mora em outra conversa DE OUTRO CONTATO: `abrirChamadoLimpo`
 * apaga os casos da conversa principal (o vizinho não pode morar nela) e
 * `conversations_unique_per_contact_session` (baseline.sql:2203) impede uma
 * segunda conversa do mesmo contato no mesmo canal.
 */
const SEM_AVISO_CONTATO_VIZINHO = "cccccccc-3333-4000-8000-0000000000b2";
const SEM_AVISO_CONVERSA_VIZINHA = "cccccccc-4444-4000-8000-0000000000b2";
const SEM_AVISO_CASO_VIZINHO = "cccccccc-7777-4000-8000-0000000000b1";
const SEM_AVISO_AVISO = "cccccccc-8888-4000-8000-0000000000b1";
const SEM_AVISO_AVISO_VIZINHO = "cccccccc-8888-4000-8000-0000000000b2";

/** O container publica em 127.0.0.1:${TEST_DB_PORT:-54329} (scripts/test-db.sh). */
const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({
  connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`,
  max: 2,
});

beforeAll(async () => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name)
      values ('${SEM_AVISO_CONTATO}', '${GOV_ORG}', 'Sem Aviso Invariant Contact'),
             ('${SEM_AVISO_CONTATO_VIZINHO}', '${GOV_ORG}', 'Sem Aviso Vizinha')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${SEM_AVISO_CONVERSA}', '${GOV_ORG}', '${SEM_AVISO_CONTATO}', '${GOV_SESSION}', 'ai_handling'),
             ('${SEM_AVISO_CONVERSA_VIZINHA}', '${GOV_ORG}', '${SEM_AVISO_CONTATO_VIZINHO}', '${GOV_SESSION}', 'ai_handling')
      on conflict do nothing;
    -- Um caso VIZINHO (em OUTRA conversa) existe só para provar que o sino do
    -- outro caso não é tocado.
    insert into public.agent_cases (id, organization_id, conversation_id, title, summary, blocker, status)
      values ('${SEM_AVISO_CASO_VIZINHO}', '${GOV_ORG}', '${SEM_AVISO_CONVERSA_VIZINHA}',
              'Caso vizinho do sino', 'resumo', 'bloqueio', 'awaiting_human')
      on conflict (id) do update set status = 'awaiting_human', closed_at = null;
  `);
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from public.organizations where id = $1`,
    [GOV_ORG],
  );
  if (rows[0]?.n !== "1") {
    throw new Error(
      `o pool não está no mesmo banco que o helper psql (org de seed não encontrada na porta ${PORTA})`,
    );
  }
});

afterAll(async () => {
  await pool.end();
});

/** Um caso aberto novo por teste — o dedup só permite um por conversa. */
async function abrirChamadoLimpo(titulo: string): Promise<string> {
  await pool.query(
    `delete from agent_cases where organization_id = $1 and conversation_id = $2`,
    [GOV_ORG, SEM_AVISO_CONVERSA],
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into agent_cases (organization_id, conversation_id, title, summary, blocker)
       values ($1, $2, $3, 'resumo', 'bloqueio') returning id`,
    [GOV_ORG, SEM_AVISO_CONVERSA, titulo],
  );
  return rows[0]!.id;
}

/** O aviso do sino apontando para o caso — como o `caso-na-central` o grava. */
async function abrirAviso(id: string, caseId: string, kind = "other"): Promise<void> {
  await pool.query(
    `insert into agent_inbox_items (id, organization_id, kind, severity, title, body, ref_kind, ref_id, status)
       values ($1, $2, $3, 'warn', 'A IA pediu ajuda à equipe', 'corpo', 'agent_case', $4, 'open')
     on conflict (id) do update set status = 'open', ref_id = excluded.ref_id`,
    [id, GOV_ORG, kind, caseId],
  );
}

async function statusDoAviso(id: string): Promise<{ status: string; resolved_at: string | null }> {
  const { rows } = await pool.query<{ status: string; resolved_at: string | null }>(
    `select status, resolved_at from agent_inbox_items where id = $1`,
    [id],
  );
  return rows[0] ?? { status: "(sumiu)", resolved_at: null };
}

async function jobsDaConversa(): Promise<Array<{ kind: string }>> {
  const { rows } = await pool.query<{ kind: string }>(
    `select kind from job_queue where organization_id = $1 and contact_id = $2`,
    [GOV_ORG, SEM_AVISO_CONTATO],
  );
  return rows;
}

describe("encerrar pela pessoa: cancelled, nota, sino limpo e NENHUM job", () => {
  it("cancela, grava a nota com ator humano e deixa a fila vazia", async () => {
    const caseId = await abrirChamadoLimpo("Cliente comprou em outra loja");
    const NOTA = "o cliente comprou em outra loja e pediu para encerrar";

    expect(await encerrarChamadoPelaPessoa(pool, GOV_ORG, caseId, GOV_AGENT_A, NOTA)).toBe(true);

    const { rows: caso } = await pool.query<{ status: string; closed_at: string | null }>(
      `select status, closed_at from agent_cases where id = $1`,
      [caseId],
    );
    expect(caso[0]?.status).toBe("cancelled");
    expect(caso[0]?.closed_at).not.toBeNull();

    const { rows: eventos } = await pool.query<{
      kind: string;
      actor_kind: string;
      actor_user_id: string | null;
      human_action: string | null;
      body: string | null;
    }>(
      `select kind, actor_kind, actor_user_id, human_action, body
         from agent_case_events where case_id = $1 order by created_at, kind`,
      [caseId],
    );
    // A NOTA está na linha do tempo, assinada por quem decidiu — não pela IA.
    const encerramento = eventos.find((e) => e.kind === "cancelled");
    expect(encerramento, "não há evento 'cancelled' no caso").toBeDefined();
    expect(encerramento?.actor_kind).toBe("human");
    expect(encerramento?.actor_user_id).toBe(GOV_AGENT_A);
    expect(encerramento?.body).toBe(NOTA);
    // Nenhum evento diz que a IA agiu neste encerramento.
    expect(eventos.filter((e) => e.actor_kind === "agent")).toEqual([]);

    // O PONTO DO ISSUE: nada enfileirado. Um `case_reply_turn` aqui faria a IA
    // falar com o cliente que a pessoa decidiu não avisar.
    expect(await jobsDaConversa()).toEqual([]);
  });

  it("resolve os avisos do sino DO CASO e não toca no de outro caso", async () => {
    const caseId = await abrirChamadoLimpo("Sino do caso");
    await abrirAviso(SEM_AVISO_AVISO, caseId);
    await abrirAviso(SEM_AVISO_AVISO_VIZINHO, SEM_AVISO_CASO_VIZINHO, "case_stale");

    expect(await encerrarChamadoPelaPessoa(pool, GOV_ORG, caseId, GOV_AGENT_A, "não precisa mais")).toBe(
      true,
    );

    const doCaso = await statusDoAviso(SEM_AVISO_AVISO);
    expect(doCaso.status).toBe("resolved");
    expect(doCaso.resolved_at).not.toBeNull();

    // Controle: o aviso do vizinho continua aberto (a casa é por `ref_id`).
    const doVizinho = await statusDoAviso(SEM_AVISO_AVISO_VIZINHO);
    expect(doVizinho.status).toBe("open");
    expect(doVizinho.resolved_at).toBeNull();

    // E o vizinho continua aberto como caso — fechar o meu não fechou o dele.
    const { rows } = await pool.query<{ status: string }>(
      `select status from agent_cases where id = $1`,
      [SEM_AVISO_CASO_VIZINHO],
    );
    expect(rows[0]?.status).toBe("awaiting_human");
  });

  it("recusa caso já fechado sem reescrever o desfecho", async () => {
    const caseId = await abrirChamadoLimpo("Duas vezes");
    await pool.query(`update agent_cases set status = 'resolved', closed_at = now() where id = $1`, [
      caseId,
    ]);

    expect(await encerrarChamadoPelaPessoa(pool, GOV_ORG, caseId, GOV_AGENT_A, "tarde demais")).toBe(
      false,
    );
    const { rows } = await pool.query<{ status: string }>(
      `select status from agent_cases where id = $1`,
      [caseId],
    );
    expect(rows[0]?.status).toBe("resolved");
    const { rows: eventos } = await pool.query<{ kind: string }>(
      `select kind from agent_case_events where case_id = $1 and kind = 'cancelled'`,
      [caseId],
    );
    expect(eventos).toEqual([]);
  });

  it("caso de OUTRA organização não mexe em nada", async () => {
    const caseId = await abrirChamadoLimpo("Cross-org");
    const OUTRA_ORG = "cccccccc-0000-4000-8000-0000000000f2";
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${OUTRA_ORG}', 'gov-inv-sem-aviso', 'Org Vizinha', 'Vizinha')
        on conflict do nothing;
    `);

    expect(await encerrarChamadoPelaPessoa(pool, OUTRA_ORG, caseId, GOV_AGENT_A, "vizinho")).toBe(
      false,
    );
    const { rows } = await pool.query<{ status: string }>(
      `select status from agent_cases where id = $1`,
      [caseId],
    );
    expect(rows[0]?.status).toBe("awaiting_human");
  });
});
