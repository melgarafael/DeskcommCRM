/**
 * O CICLO AGENTE ↔ PESSOA, CONTRA POSTGRES DE VERDADE.
 *
 * Duas classes de defeito só aparecem aqui, e nenhuma delas vermelha no
 * `test:unit`:
 *
 * 1. **A trava da volta.** `performHumanHandoff` liga TRÊS travas
 *    (`contacts.force_human`, `bot_silenced_until`, o dono humano) e o botão de
 *    devolver o atendimento soltava só uma. O teste roda a função REAL de guarda
 *    (`isLeadInHandoff`) e mostra que soltar só o silêncio deixa o agente morto —
 *    que era exatamente o comportamento em produção, com a rota respondendo
 *    `{ reactivated: true }`.
 *
 * 2. **O CHECK do banco.** `agent_case_events.kind` ganhou `agent_noted` na 0100.
 *    Escrever um kind fora da lista é `23514` num caminho fire-and-forget — o
 *    perfil de bug que passa em typecheck, lint e unitário.
 *
 * As transições rodam pelas FUNÇÕES REAIS sobre um `pg.Pool` apontado ao
 * container efêmero, não por uma cópia do SQL escrita no teste: SQL transcrito
 * aqui mediria o teste contra ele mesmo.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  encerrarChamadoPeloAgente,
  openCase,
  registrarNotaDoAgente,
  resolveCaseFromHuman,
} from "@/lib/agent-engine/agent/human-cases";
import { isLeadInHandoff, performHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";

import {
  GOV_AGENT_A,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_SESSION,
  GOV_STAGE,
  seedGov,
  sql,
} from "./gov-helpers";

/** Org vizinha: prova que as transições recusam alvo de outro tenant. */
const OUTRA_ORG = "cccccccc-0000-4000-8000-0000000000f1";

/**
 * Fixtures PRÓPRIAS, não as do `seedGov`.
 *
 * Este arquivo liga `contacts.force_human`, mexe em `bot_silenced_until` e em
 * `assignee_kind`, e apaga chamados da conversa — reusar as linhas compartilhadas
 * faria os outros 62 arquivos da suíte lerem um estado que este aqui deixou. Com
 * `fileParallelism: false` o container é o MESMO entre arquivos, então "passou
 * quando rodei sozinho" não é evidência de nada; a interferência aparece como um
 * vermelho intermitente em arquivo alheio, que é o pior sinal possível.
 */
const ESC_CONTATO = "cccccccc-3333-4000-8000-0000000000e1";
const ESC_CONVERSA = "cccccccc-4444-4000-8000-0000000000e1";
const ESC_NEGOCIO = "cccccccc-6666-4000-8000-0000000000e1";

/** O container publica em 127.0.0.1:${TEST_DB_PORT:-54329} (scripts/test-db.sh). */
const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({
  connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`,
  max: 2,
});

/** Logger mudo: performHumanHandoff exige um, e PII não entra em log de teste. */
const logMudo = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Parameters<typeof performHumanHandoff>[2]["log"];

beforeAll(async () => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OUTRA_ORG}', 'gov-inv-vizinha', 'Org Vizinha', 'Vizinha')
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${ESC_CONTATO}', '${GOV_ORG}', 'Escalacao Invariant Contact')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${ESC_CONVERSA}', '${GOV_ORG}', '${ESC_CONTATO}', '${GOV_SESSION}', 'ai_handling')
      on conflict do nothing;
    -- Um negócio ABERTO ligado a este contato: sem ele a atividade da passagem
    -- não tem onde pousar e o teste da timeline passaria por vacuidade.
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status)
      values ('${ESC_NEGOCIO}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${ESC_CONTATO}', 'Negocio da escalacao', 'open')
      on conflict do nothing;
  `);
  // Controle positivo do instrumento: sem isto, um pool que não conecta faria
  // TODA asserção abaixo estourar — mas um pool que conecta no banco ERRADO
  // passaria com contagens zeradas e pareceria medição.
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

/** Um chamado aberto novo por teste — o dedup só permite um por conversa. */
async function abrirChamadoLimpo(titulo: string): Promise<string> {
  await pool.query(
    `delete from agent_cases where organization_id = $1 and conversation_id = $2`,
    [GOV_ORG, ESC_CONVERSA],
  );
  const res = await openCase(
    pool,
    { tenantId: GOV_ORG, conversationId: ESC_CONVERSA },
    { title: titulo, summary: "resumo", blocker: "bloqueio" },
  );
  if (!res.ok) throw new Error(`openCase falhou: ${res.error.code}`);
  return res.caseId;
}

async function estadoDoChamado(caseId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    `select status from agent_cases where id = $1`,
    [caseId],
  );
  return rows[0]?.status ?? "(sumiu)";
}

async function eventosDoChamado(
  caseId: string,
): Promise<Array<{ kind: string; actor_kind: string; body: string | null }>> {
  const { rows } = await pool.query<{ kind: string; actor_kind: string; body: string | null }>(
    `select kind, actor_kind, body from agent_case_events where case_id = $1 order by created_at, kind`,
    [caseId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// 1 — a trava da volta
// ---------------------------------------------------------------------------

describe("devolver o atendimento: as três travas", () => {
  async function estadoDaConversa() {
    const { rows } = await pool.query<{
      force_human: boolean;
      bot_silenced_until: string | null;
      assignee_kind: string | null;
    }>(
      `select c.force_human, v.bot_silenced_until, v.assignee_kind
         from conversations v join contacts c on c.id = v.contact_id
        where v.id = $1`,
      [ESC_CONVERSA],
    );
    return rows[0]!;
  }

  it("a passagem para humano liga force_human e o silêncio — e o guarda real acusa", async () => {
    await performHumanHandoff(
      pool,
      { tenantId: GOV_ORG, leadId: ESC_CONTATO, conversationId: ESC_CONVERSA },
      { reason: "requested_human", conversationSummary: "resumo da conversa", log: logMudo },
    );

    const antes = await estadoDaConversa();
    expect(antes.force_human).toBe(true);
    expect(antes.bot_silenced_until).not.toBeNull();
    expect(await isLeadInHandoff(pool, GOV_ORG, ESC_CONTATO)).toBe(true);
  });

  it("a IDA também aparece na linha do tempo — não só o caminho do CRM", async () => {
    // `triggerHandoff` (orquestrador do CRM) sempre gravou `handoff_triggered`;
    // `performHumanHandoff` (harness e o "Assumir eu" dos casos) não gravava
    // nada. Metade das passagens era invisível no dossiê, e a timeline mostrava
    // a volta sem a ida.
    const { rows } = await pool.query<{ reason: string; actor_kind: string }>(
      `select a.reason, a.actor_kind
         from crm_lead_activities a
         join crm_leads l on l.id = a.lead_id
        where a.organization_id = $1 and l.contact_id = $2 and a.type = 'handoff_triggered'`,
      [GOV_ORG, ESC_CONTATO],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.reason).toBe("Atendimento passado para uma pessoa");
    // O texto que o atendente escreveu ao escalar NÃO entra aqui: esta linha
    // aparece na tela e no export de LGPD.
    expect(rows[0]!.reason).not.toContain("requested_human");
  });

  it("soltar SÓ o silêncio deixa o agente morto — o defeito que a rota tinha", async () => {
    // Isto é literalmente o que `reactivate-bot` fazia antes: um UPDATE só.
    await pool.query(
      `update conversations set bot_silenced_until = null where organization_id = $1 and id = $2`,
      [GOV_ORG, ESC_CONVERSA],
    );
    expect(
      await isLeadInHandoff(pool, GOV_ORG, ESC_CONTATO),
      "com force_human ainda ligado o turno é NO-OP e todo envio é vetado — a rota respondia sucesso mesmo assim",
    ).toBe(true);
  });

  it("soltar force_human junto devolve o atendimento de verdade", async () => {
    await pool.query(`update contacts set force_human = false where organization_id = $1 and id = $2`, [
      GOV_ORG,
      ESC_CONTATO,
    ]);
    expect(await isLeadInHandoff(pool, GOV_ORG, ESC_CONTATO)).toBe(false);
  });

  it("o guarda do envio lê a mesma coluna — sem soltá-la, nada sai", async () => {
    // `before-send.ts`: select (is_blocked or force_human or is_personal) as stopped.
    const parado = async () => {
      const { rows } = await pool.query<{ stopped: boolean }>(
        "select (is_blocked or force_human or is_personal) as stopped from contacts where organization_id = $1 and id = $2",
        [GOV_ORG, ESC_CONTATO],
      );
      return rows[0]!.stopped;
    };
    expect(await parado()).toBe(false);
    await pool.query(`update contacts set force_human = true where id = $1`, [ESC_CONTATO]);
    expect(await parado()).toBe(true);
    await pool.query(`update contacts set force_human = false where id = $1`, [ESC_CONTATO]);
  });

  it("assignee_kind='ai' exige conversa sem dono humano (o CHECK protege a volta)", async () => {
    await expect(
      pool.query(
        `update conversations set assigned_to_user_id = $2, assignee_kind = 'ai' where id = $1`,
        [ESC_CONVERSA, GOV_AGENT_A],
      ),
    ).rejects.toThrow(/assignee_kind_coherence/);
    // E o par coerente passa — senão o teste acima estaria medindo outra coisa.
    await pool.query(
      `update conversations set assigned_to_user_id = null, assignee_kind = 'ai' where id = $1`,
      [ESC_CONVERSA],
    );
    expect((await estadoDaConversa()).assignee_kind).toBe("ai");
  });

  it("o checkpoint da retomada aceita job_id nulo — ele não nasce de um turno", async () => {
    // Se a coluna fosse NOT NULL, a continuidade morreria num log e o agente
    // voltaria cego sem ninguém perceber (a gravação é best-effort de propósito).
    const { rowCount } = await pool.query(
      `insert into lead_checkpoints (organization_id, contact_id, job_id, rolling_summary)
       values ($1, $2, null, 'resumo da retomada')`,
      [GOV_ORG, ESC_CONTATO],
    );
    expect(rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2 — o agente participando do chamado
// ---------------------------------------------------------------------------

describe("o agente registrando e encerrando um chamado", () => {
  it("o CHECK do banco aceita 'agent_noted' (migration 0100)", () => {
    const def = sql(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'agent_case_events_kind_check';`,
    );
    expect(def).toContain("agent_noted");
  });

  it("registra no chamado ABERTO, como agente — nunca como pessoa", async () => {
    const caseId = await abrirChamadoLimpo("Registrar no aberto");
    expect(await registrarNotaDoAgente(pool, GOV_ORG, caseId, "o cliente aceitou 12%")).toBe(true);

    const eventos = await eventosDoChamado(caseId);
    const nota = eventos.find((e) => e.kind === "agent_noted");
    expect(nota).toBeDefined();
    expect(nota?.actor_kind).toBe("agent");
    expect(nota?.body).toBe("o cliente aceitou 12%");
    // A afirmação que importa: nada foi gravado como decisão humana.
    expect(eventos.filter((e) => e.actor_kind === "human")).toEqual([]);
  });

  it("chamado FECHADO recusa o registro em vez de aceitar em silêncio", async () => {
    const caseId = await abrirChamadoLimpo("Registrar no fechado");
    expect(await resolveCaseFromHuman(pool, GOV_ORG, caseId, GOV_AGENT_A, "resolvido")).toBe(true);

    expect(await registrarNotaDoAgente(pool, GOV_ORG, caseId, "tarde demais")).toBe(false);
    expect(await eventosDoChamado(caseId)).not.toContainEqual(
      expect.objectContaining({ body: "tarde demais" }),
    );
  });

  it("chamado de OUTRA organização é invisível para o registro", async () => {
    const caseId = await abrirChamadoLimpo("Registrar cross-org");
    expect(await registrarNotaDoAgente(pool, OUTRA_ORG, caseId, "vizinho bisbilhotando")).toBe(
      false,
    );
  });

  it("encerrar como 'resolvido' fecha o chamado e deixa o desfecho escrito", async () => {
    const caseId = await abrirChamadoLimpo("Encerrar resolvido");
    expect(
      await encerrarChamadoPeloAgente(pool, GOV_ORG, caseId, {
        desfecho: "resolvido",
        nota: "desconto aprovado e comunicado",
      }),
    ).toBe(true);

    expect(await estadoDoChamado(caseId)).toBe("resolved");
    const eventos = await eventosDoChamado(caseId);
    expect(eventos.map((e) => e.kind).sort()).toEqual(["agent_noted", "opened", "resolved"]);
    expect(eventos.find((e) => e.kind === "resolved")?.actor_kind).toBe("agent");
    expect(eventos.find((e) => e.kind === "agent_noted")?.body).toBe(
      "desconto aprovado e comunicado",
    );
  });

  it("encerrar como 'sem_necessidade' cancela — não finge que alguém resolveu", async () => {
    const caseId = await abrirChamadoLimpo("Encerrar sem necessidade");
    expect(
      await encerrarChamadoPeloAgente(pool, GOV_ORG, caseId, {
        desfecho: "sem_necessidade",
        nota: "o cliente desistiu",
      }),
    ).toBe(true);
    expect(await estadoDoChamado(caseId)).toBe("cancelled");
  });

  it("fecha também o que estava esperando o cliente — senão o chamado fica imortal", async () => {
    const caseId = await abrirChamadoLimpo("Encerrar awaiting_lead");
    await pool.query(`update agent_cases set status = 'awaiting_lead' where id = $1`, [caseId]);
    expect(
      await encerrarChamadoPeloAgente(pool, GOV_ORG, caseId, {
        desfecho: "resolvido",
        nota: "o lead respondeu sozinho",
      }),
    ).toBe(true);
    expect(await estadoDoChamado(caseId)).toBe("resolved");
  });

  it("encerrar duas vezes não reescreve o desfecho", async () => {
    const caseId = await abrirChamadoLimpo("Encerrar duas vezes");
    await encerrarChamadoPeloAgente(pool, GOV_ORG, caseId, {
      desfecho: "resolvido",
      nota: "primeira",
    });
    expect(
      await encerrarChamadoPeloAgente(pool, GOV_ORG, caseId, {
        desfecho: "sem_necessidade",
        nota: "segunda",
      }),
    ).toBe(false);
    expect(await estadoDoChamado(caseId)).toBe("resolved");
  });

  it("encerrar chamado de OUTRA organização não mexe em nada", async () => {
    const caseId = await abrirChamadoLimpo("Encerrar cross-org");
    expect(
      await encerrarChamadoPeloAgente(pool, OUTRA_ORG, caseId, {
        desfecho: "resolvido",
        nota: "vizinho fechando o que não é dele",
      }),
    ).toBe(false);
    expect(await estadoDoChamado(caseId)).toBe("awaiting_human");
  });
});
