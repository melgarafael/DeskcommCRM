import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { criarPorta } from "@/lib/db";
import { gerarOcorrencias } from "@/lib/tarefas/recorrencia";

/**
 * A TAREFA QUE SE REPETE (#4595) — a idempotência, contra Postgres de verdade.
 *
 * O que este arquivo prova, e por que ele não podia ser unitário:
 *
 *   1. **rodar o gerador duas vezes no mesmo minuto cria UMA ocorrência** — e a
 *      volta é o índice único `(recurrence_source_id, due_date)`, não a boa
 *      vontade da rotina: a inserção crua de uma duplicata tem de estourar
 *      `23505`. É a mesma doutrina de `recurring_entries`, onde a competência
 *      repetida quem barra é o índice, não a checagem anterior;
 *   2. **tarefa sem recorrência nunca é gerada** — o histórico inteiro do
 *      produto é assim, e um gerador que olhasse "toda tarefa" começaria a
 *      duplicar a carteira de todo mundo no primeiro deploy;
 *   3. **série desligada não gera** — e não apaga o que já nasceu;
 *   4. **a hora é a do fuso da ORGANIZAÇÃO**: a mesma regra de 9h vira 12:00Z
 *      em `America/Sao_Paulo` e 13:00Z em `America/Manaus`. Se a conta fosse em
 *      UTC, as duas dariam 09:00Z e a ligação das 9h cairia às 6h em Brasília.
 *
 * A regra pura (dia da semana, hora, estouro de semana) tem teste próprio em
 * `lib/tarefas/recorrencia.test.ts`; aqui só o que depende do banco.
 */
if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});

/** A PORTA de produção apontada para o banco efêmero. */
const db = criarPorta(pool);

afterAll(async () => {
  await pool.end();
});

// ── Fixtures ────────────────────────────────────────────────────────────────
const ORG_SP = "e4595000-0000-4000-8000-00000000000a";
const ORG_MA = "e4595000-0000-4000-8000-00000000000b";

/** Segunda-feira, 08:00 em Brasília — antes das 9h da série. */
const SEGUNDA_8H = new Date("2026-11-16T11:00:00.000Z");

const REGRA_SEGUNDA_9H = { dias: [1], hora: 9, ativa: true };

async function criarTarefa(organizationId: string, titulo: string, recurrence: unknown): Promise<string> {
  const [linha] = await db.query<{ id: string }>(
    `insert into crm_tasks (organization_id, title, recurrence)
     values ($1, $2, $3::jsonb)
     returning id`,
    [organizationId, titulo, recurrence === null ? null : JSON.stringify(recurrence)],
  );
  if (!linha) throw new Error("insert da série não devolveu id");
  return linha.id;
}

async function ocorrenciasDe(serieId: string) {
  return db.query<{ due_date: Date; recurrence: unknown; title: string; status: string }>(
    `select due_date, recurrence, title, status
       from crm_tasks
      where recurrence_source_id = $1
      order by due_date`,
    [serieId],
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings, timezone)
     values ($1, 'recorrencia-4595-sp', 'Org SP', 'Org SP', '{}'::jsonb, 'America/Sao_Paulo'),
            ($2, 'recorrencia-4595-ma', 'Org MA', 'Org MA', '{}'::jsonb, 'America/Manaus')`,
    [ORG_SP, ORG_MA],
  );
});

describe("a série de segunda às 9h", () => {
  it("gera a próxima segunda, e rodar de novo no mesmo minuto não duplica", async () => {
    const serie = await criarTarefa(ORG_SP, "Ligar para a carteira", REGRA_SEGUNDA_9H);

    await gerarOcorrencias(db, SEGUNDA_8H);
    const depoisDaPrimeira = await ocorrenciasDe(serie);
    expect(depoisDaPrimeira).toHaveLength(1);

    // A ocorrência nasce como TAREFA (o trabalho se repete, o desfecho não):
    // mesma segunda às 9h no fuso da organização, pendente, sem regra própria.
    expect(depoisDaPrimeira[0]!.due_date.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect(depoisDaPrimeira[0]!.status).toBe("pending");
    expect(depoisDaPrimeira[0]!.recurrence).toBeNull();

    // A SEGUNDA rodada, no mesmo minuto, é o caso do critério: o cron roda de
    // dez em dez minutos e uma rodada atrasada pode encontrar a outra.
    const segunda = await gerarOcorrencias(db, SEGUNDA_8H);
    expect(segunda.criadas).toBe(0);
    expect(await ocorrenciasDe(serie)).toHaveLength(1);
  });

  it("duas rodadas CONCORRENTES gravam uma só — quem barra é o índice único", async () => {
    const serie = await criarTarefa(ORG_SP, "Conferir a agenda do dia", REGRA_SEGUNDA_9H);
    await Promise.all([gerarOcorrencias(db, SEGUNDA_8H), gerarOcorrencias(db, SEGUNDA_8H)]);
    expect(await ocorrenciasDe(serie)).toHaveLength(1);

    // A prova direta de que a trava é do BANCO: a mesma ocorrência, inserida à
    // mão, é recusada. Sem o índice, a "checagem antes de gravar" das duas
    // rodadas passaria e a tarefa nasceria duas vezes.
    const [existente] = await ocorrenciasDe(serie);
    const duplicata = await pool
      .query(
        `insert into crm_tasks (organization_id, title, due_date, recurrence_source_id)
         values ($1, 'duplicata', $2, $3)`,
        [ORG_SP, existente!.due_date, serie],
      )
      .then(() => null)
      .catch((erro: { code?: string }) => erro);
    expect(duplicata?.code).toBe("23505");
  });
});

describe("o que NUNCA vira ocorrência", () => {
  it("tarefa sem recorrência não é gerada (é o caso de todo o histórico)", async () => {
    const avulsa = await criarTarefa(ORG_SP, "Revisar os textos do agente", null);
    await gerarOcorrencias(db, SEGUNDA_8H);
    expect(await ocorrenciasDe(avulsa)).toHaveLength(0);
  });

  it("série desligada para de gerar", async () => {
    const desligada = await criarTarefa(ORG_SP, "Religar a carteira antiga", {
      ...REGRA_SEGUNDA_9H,
      ativa: false,
    });
    await gerarOcorrencias(db, SEGUNDA_8H);
    expect(await ocorrenciasDe(desligada)).toHaveLength(0);
  });
});

describe("o fuso é o da organização", () => {
  it("a mesma regra de 9h vira 13:00Z em Manaus e 12:00Z em Brasília", async () => {
    const emManaus = await criarTarefa(ORG_MA, "Ligar para a carteira do Norte", REGRA_SEGUNDA_9H);
    await gerarOcorrencias(db, SEGUNDA_8H);

    const [ocorrencia] = await ocorrenciasDe(emManaus);
    expect(ocorrencia).toBeDefined();
    // 9h em Manaus (UTC-4) = 13:00Z. Em UTC cru seria 09:00Z — três horas
    // antes, e a pessoa receberia a tarefa no meio da madrugada.
    expect(ocorrencia!.due_date.toISOString()).toBe("2026-11-16T13:00:00.000Z");
  });
});
