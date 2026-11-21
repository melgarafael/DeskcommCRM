import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { audit } from "@/lib/audit";
import { criarPorta } from "@/lib/db";
import { criarProximaDaSerie, gerarOcorrencias, TAMANHO_DO_LOTE } from "@/lib/tarefas/recorrencia";
import type { RegraDeRecorrencia } from "@/lib/tarefas/tipos";

/**
 * A TAREFA QUE SE REPETE (#4595) — a próxima nasce ao CONCLUIR, contra Postgres
 * de verdade.
 *
 * O que este arquivo prova, e por que ele não podia ser unitário:
 *
 *   1. **concluir cria UMA próxima**, na data e hora do fuso da organização,
 *      com o mesmo dono, prioridade e vínculos — e a concluída continua
 *      concluída (a nova é outra linha, não a mesma reaproveitada);
 *   2. **concluir duas vezes não cria duas** — e quem barra é o índice único
 *      `(recurrence_source_id, due_date)`, não a boa vontade da rotina: a
 *      inserção crua da duplicata tem de estourar `23505`;
 *   3. **tarefa sem série nunca gera nada** — o histórico inteiro do produto é
 *      assim, e um gerador que olhasse "toda tarefa concluída" começaria a
 *      duplicar a carteira de todo mundo;
 *   4. **a hora é a do fuso da ORGANIZAÇÃO**: a mesma regra de 9h vira 12:00Z
 *      em `America/Sao_Paulo` e 13:00Z em `America/Manaus`;
 *   5. **conclusão atrasada** devolve a próxima ocorrência FUTURA, uma só — não
 *      um lote das que passaram enquanto ninguém cumpria o trabalho;
 *   6. **o agendador continua** (doc 374 = A): a rodada do `cron/task-recurrence`
 *      cria a próxima da série sem ocorrência futura, pelo MESMO caminho da
 *      conclusão, respeita organização parada e, junto com a conclusão, grava
 *      uma só.
 *
 * A regra pura (dia da semana, dia do mês, estouro de semana) tem teste próprio
 * em `lib/tarefas/recorrencia.test.ts`; aqui só o que depende do banco.
 *
 * `audit` e o push são mockados de propósito: são efeitos EXTERNOS ao caminho
 * sob teste (fila de eventos e web push), e batê-los de verdade faria o teste
 * medir a rede em vez do SQL — a mesma escolha de `tarefas-piloto-pg.test.ts`.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushAoUsuario: vi.fn(async () => undefined),
}));

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

const DONO = "e4595000-0000-4000-8000-000000000101";
const CONTATO = "e4595000-0000-4000-8000-000000000401";
const FUNIL = "e4595000-0000-4000-8000-000000000301";
const ETAPA = "e4595000-0000-4000-8000-000000000302";
const LEAD = "e4595000-0000-4000-8000-000000000501";

/** Segunda-feira, 08:00 em Brasília — antes das 9h da série. */
const SEGUNDA_8H = new Date("2026-11-16T11:00:00.000Z");

const REGRA_SEGUNDA_9H: RegraDeRecorrencia = {
  tipo: "semanal",
  dias: [1],
  dia_do_mes: null,
  hora: 9,
  ativa: true,
};

const regraJson = (regra: RegraDeRecorrencia) =>
  JSON.stringify({
    tipo: regra.tipo,
    dias: regra.dias,
    dia_do_mes: regra.dia_do_mes,
    hora: regra.hora,
    ativa: regra.ativa,
  });

interface LinhaDaSerie {
  title: string;
  organizationId?: string;
  recurrence?: RegraDeRecorrencia | null;
  dueDate?: Date | null;
  assignedTo?: string | null;
  priority?: string;
  withLead?: boolean;
}

async function criarSerie(opcoes: LinhaDaSerie): Promise<string> {
  const organizationId = opcoes.organizationId ?? ORG_SP;
  const [linha] = await db.query<{ id: string }>(
    `insert into crm_tasks
       (organization_id, title, due_date, priority, status, lead_id, contact_id, assigned_to, recurrence)
     values ($1, $2, $3, $4, 'done', $5, $6, $7, $8::jsonb)
     returning id`,
    [
      organizationId,
      opcoes.title,
      (opcoes.dueDate ?? SEGUNDA_8H).toISOString(),
      opcoes.priority ?? "high",
      opcoes.withLead === false ? null : LEAD,
      opcoes.withLead === false ? null : CONTATO,
      opcoes.assignedTo === undefined ? DONO : opcoes.assignedTo,
      opcoes.recurrence === null ? null : regraJson(opcoes.recurrence ?? REGRA_SEGUNDA_9H),
    ],
  );
  if (!linha) throw new Error("insert da série não devolveu id");
  return linha.id;
}

interface Ocorrencia {
  id: string;
  title: string;
  due_date: Date;
  status: string;
  priority: string;
  lead_id: string | null;
  contact_id: string | null;
  assigned_to: string | null;
  recurrence: unknown;
  recurrence_source_id: string | null;
}

async function ocorrenciasDe(serieId: string): Promise<Ocorrencia[]> {
  return db.query<Ocorrencia>(
    `select id, title, due_date, status, priority, lead_id, contact_id, assigned_to,
            recurrence, recurrence_source_id
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

  await pool.query(`insert into auth.users (id, email) values ($1, 'recorrencia-4595@invariant.test')`, [
    DONO,
  ]);

  // O dono do negócio tem de ser ATENDENTE ATIVO da organização — é a régua que
  // `crm_leads.owner_user_id` confere no INSERT.
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
     values ($1, $2, 'agent', now(), null)`,
    [DONO, ORG_SP],
  );

  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values ($1, $2, 'Funil', 'recorrencia-4595')`,
    [FUNIL, ORG_SP],
  );

  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
     values ($1, $2, $3, 'Entrada', 'entrada-recorrencia', 1000)`,
    [ETAPA, ORG_SP, FUNIL],
  );

  await pool.query(
    `insert into contacts (id, organization_id, name, display_name) values ($1, $2, 'Ana Souza', null)`,
    [CONTATO, ORG_SP],
  );

  await pool.query(
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, owner_user_id)
     values ($1, $2, $3, $4, $5, 'Renovação do contrato', $6)`,
    [LEAD, ORG_SP, FUNIL, ETAPA, CONTATO, DONO],
  );
});

describe("concluir a série", () => {
  it("cria UMA próxima na data e hora do fuso, com dono, prioridade e vínculos", async () => {
    const serie = await criarSerie({ title: "Ligar para a carteira" });

    const resultado = await criarProximaDaSerie(
      db,
      { id: serie, organization_id: ORG_SP, recurrence_source_id: null, due_date: SEGUNDA_8H },
      SEGUNDA_8H,
    );

    expect(resultado.criada).toBe(true);

    const ocorrencias = await ocorrenciasDe(serie);
    expect(ocorrencias).toHaveLength(1);
    const proxima = ocorrencias[0]!;

    // 9h em Brasília = 12:00Z. Em UTC cru a ligação das 9h cairia às 6h.
    expect(proxima.due_date.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect(proxima.status).toBe("pending");
    // O que se repete é o TRABALHO, não a regra nem o desfecho: a ocorrência
    // nasce sem regra própria e apontando para a série.
    expect(proxima.recurrence).toBeNull();
    expect(proxima.recurrence_source_id).toBe(serie);
    expect(proxima).toMatchObject({
      title: "Ligar para a carteira",
      priority: "high",
      lead_id: LEAD,
      contact_id: CONTATO,
      assigned_to: DONO,
    });
  });

  it("a concluída continua concluída — a próxima é OUTRA linha", async () => {
    const serie = await criarSerie({ title: "Conferir a agenda do dia" });

    await criarProximaDaSerie(
      db,
      { id: serie, organization_id: ORG_SP, recurrence_source_id: null, due_date: SEGUNDA_8H },
      SEGUNDA_8H,
    );

    const { rows } = await pool.query<{ status: string; due_date: Date }>(
      `select status, due_date from crm_tasks where id = $1`,
      [serie],
    );
    // A série não foi reaberta nem teve o prazo empurrado: o histórico fica.
    expect(rows[0]!.status).toBe("done");
    expect(rows[0]!.due_date.toISOString()).toBe(SEGUNDA_8H.toISOString());
  });

  it("concluir uma OCORRÊNCIA gera a próxima da MESMA série", async () => {
    const serie = await criarSerie({ title: "Religar a carteira" });
    await criarProximaDaSerie(
      db,
      { id: serie, organization_id: ORG_SP, recurrence_source_id: null, due_date: SEGUNDA_8H },
      SEGUNDA_8H,
    );
    const [primeira] = await ocorrenciasDe(serie);

    const resultado = await criarProximaDaSerie(
      db,
      {
        id: primeira!.id,
        organization_id: ORG_SP,
        recurrence_source_id: serie,
        due_date: primeira!.due_date,
      },
      primeira!.due_date,
    );

    expect(resultado.criada).toBe(true);
    const todas = await ocorrenciasDe(serie);
    expect(todas).toHaveLength(2);
    expect(todas[1]!.due_date.toISOString()).toBe("2026-11-23T12:00:00.000Z");
    expect(todas[1]!.recurrence_source_id).toBe(serie);
  });
});

describe("concluir duas vezes NÃO cria duas", () => {
  it("a segunda conclusão devolve `ja_existe`, e a série fica com UMA ocorrência", async () => {
    const serie = await criarSerie({ title: "Fechar o caixa da semana" });
    const concluida = {
      id: serie,
      organization_id: ORG_SP,
      recurrence_source_id: null,
      due_date: SEGUNDA_8H,
    };

    const primeira = await criarProximaDaSerie(db, concluida, SEGUNDA_8H);
    // O mesmo pedido outra vez — é o que acontece quando a tela reenvia o PATCH
    // (duplo clique, retry da rede, duas abas).
    const segunda = await criarProximaDaSerie(db, concluida, SEGUNDA_8H);

    expect(primeira.criada).toBe(true);
    expect(segunda).toMatchObject({ criada: false, motivo: "ja_existe" });
    expect(await ocorrenciasDe(serie)).toHaveLength(1);
  });

  it("duas conclusões CONCORRENTES gravam uma só — quem barra é o índice único", async () => {
    const serie = await criarSerie({ title: "Duas abas abertas" });
    const concluida = {
      id: serie,
      organization_id: ORG_SP,
      recurrence_source_id: null,
      due_date: SEGUNDA_8H,
    };

    const resultados = await Promise.all([
      criarProximaDaSerie(db, concluida, SEGUNDA_8H),
      criarProximaDaSerie(db, concluida, SEGUNDA_8H),
    ]);

    expect(resultados.filter((r) => r.criada)).toHaveLength(1);
    expect(await ocorrenciasDe(serie)).toHaveLength(1);

    // A prova direta de que a trava é do BANCO: a mesma ocorrência, inserida à
    // mão, é recusada. Sem o índice, a "checagem antes de gravar" das duas
    // conclusões passaria e a tarefa nasceria duas vezes.
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

describe("o que NUNCA gera próxima", () => {
  it("tarefa sem série (avulsa) não gera nada — é o caso de todo o histórico", async () => {
    const avulsa = await criarSerie({ title: "Revisar os textos do agente", recurrence: null });
    const resultado = await criarProximaDaSerie(
      db,
      { id: avulsa, organization_id: ORG_SP, recurrence_source_id: null, due_date: SEGUNDA_8H },
      SEGUNDA_8H,
    );
    expect(resultado).toMatchObject({ criada: false, motivo: "desligada" });
    expect(await ocorrenciasDe(avulsa)).toHaveLength(0);
  });

  it("série desligada para de gerar e não apaga o que já nasceu", async () => {
    const desligada = await criarSerie({
      title: "Religar a carteira antiga",
      recurrence: { ...REGRA_SEGUNDA_9H, ativa: false },
    });
    const resultado = await criarProximaDaSerie(
      db,
      { id: desligada, organization_id: ORG_SP, recurrence_source_id: null, due_date: SEGUNDA_8H },
      SEGUNDA_8H,
    );
    expect(resultado).toMatchObject({ criada: false, motivo: "desligada" });
    expect(await ocorrenciasDe(desligada)).toHaveLength(0);
  });

  it("série sem negócio, sem contato e SEM dono continua gerando — tarefa solta é caso real", async () => {
    // O `exato: null` e o `alvoOpcional` do caminho de criação existem para
    // isto: recusar por `sem_dono`/`sem_alvo` deixaria a série solta sem gerar
    // para sempre.
    const solta = await criarSerie({
      title: "Conferir o e-mail da equipe",
      withLead: false,
      assignedTo: null,
    });
    const resultado = await criarProximaDaSerie(
      db,
      { id: solta, organization_id: ORG_SP, recurrence_source_id: null, due_date: SEGUNDA_8H },
      SEGUNDA_8H,
    );

    expect(resultado.criada).toBe(true);
    const [proxima] = await ocorrenciasDe(solta);
    expect(proxima).toMatchObject({ lead_id: null, contact_id: null, assigned_to: null });
  });
});

describe("o fuso é o da organização", () => {
  it("a mesma regra de 9h vira 13:00Z em Manaus e 12:00Z em Brasília", async () => {
    const emManaus = await criarSerie({
      title: "Ligar para a carteira do Norte",
      organizationId: ORG_MA,
      withLead: false,
    });

    await criarProximaDaSerie(
      db,
      { id: emManaus, organization_id: ORG_MA, recurrence_source_id: null, due_date: SEGUNDA_8H },
      SEGUNDA_8H,
    );

    const [ocorrencia] = await ocorrenciasDe(emManaus);
    expect(ocorrencia).toBeDefined();
    // 9h em Manaus (UTC-4) = 13:00Z. Em UTC cru seria 09:00Z — três horas
    // antes, e a pessoa receberia a tarefa no meio da madrugada.
    expect(ocorrencia!.due_date.toISOString()).toBe("2026-11-16T13:00:00.000Z");
  });
});

describe("a conclusão fora do dia da série", () => {
  it("concluída ADIANTADA (sexta, a tarefa de segunda) mantém o ritmo da série", async () => {
    const proximaSegunda = new Date("2026-11-23T12:00:00.000Z");
    const serie = await criarSerie({ title: "Ligar segunda", dueDate: proximaSegunda });
    const sexta = new Date("2026-11-20T15:00:00.000Z");

    await criarProximaDaSerie(
      db,
      { id: serie, organization_id: ORG_SP, recurrence_source_id: null, due_date: proximaSegunda },
      sexta,
    );

    const [proxima] = await ocorrenciasDe(serie);
    // Não pula a segunda seguinte: o prazo da concluída é a referência quando
    // ele está no futuro.
    expect(proxima!.due_date.toISOString()).toBe("2026-11-30T12:00:00.000Z");
  });

  it("concluída ATRASADA devolve a próxima ocorrência FUTURA — uma só, nunca um lote", async () => {
    const tresSemanasAtras = new Date("2026-10-26T12:00:00.000Z");
    const serie = await criarSerie({ title: "Ligar segunda (atrasada)", dueDate: tresSemanasAtras });

    const resultado = await criarProximaDaSerie(
      db,
      {
        id: serie,
        organization_id: ORG_SP,
        recurrence_source_id: null,
        due_date: tresSemanasAtras,
      },
      SEGUNDA_8H,
    );

    expect(resultado.criada).toBe(true);
    const ocorrencias = await ocorrenciasDe(serie);
    // UMA, e no futuro: as três segundas que passaram sem ninguém cumprir o
    // trabalho não viram três tarefas atrasadas na lista.
    expect(ocorrencias).toHaveLength(1);
    expect(ocorrencias[0]!.due_date.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect(ocorrencias[0]!.due_date.getTime()).toBeGreaterThan(SEGUNDA_8H.getTime());
  });

  it("sem prazo na concluída, a referência é AGORA", async () => {
    const serie = await criarSerie({ title: "Ligar sem prazo", dueDate: null });
    await criarProximaDaSerie(
      db,
      { id: serie, organization_id: ORG_SP, recurrence_source_id: null, due_date: null },
      SEGUNDA_8H,
    );
    const [proxima] = await ocorrenciasDe(serie);
    expect(proxima!.due_date.toISOString()).toBe("2026-11-16T12:00:00.000Z");
  });
});

describe("o agendador continua gerando (doc 374 = A)", () => {
  /** Segunda anterior, 9h em Brasília: a série cujo prazo já passou. */
  const SEGUNDA_PASSADA = new Date("2026-11-09T12:00:00.000Z");

  it("gera a próxima da série sem ocorrência futura, e rodar de novo não duplica", async () => {
    const serie = await criarSerie({ title: "Agendador: carteira", dueDate: SEGUNDA_PASSADA });

    await gerarOcorrencias(db, SEGUNDA_8H);
    await gerarOcorrencias(db, SEGUNDA_8H);

    const ocorrencias = await ocorrenciasDe(serie);
    expect(ocorrencias).toHaveLength(1);
    expect(ocorrencias[0]!.due_date.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect(ocorrencias[0]!.status).toBe("pending");
  });

  it("passa pelo caminho único: a ocorrência do agendador é auditada", async () => {
    const serie = await criarSerie({ title: "Agendador: auditada", dueDate: SEGUNDA_PASSADA });
    vi.mocked(audit).mockClear();

    await gerarOcorrencias(db, SEGUNDA_8H);

    const [ocorrencia] = await ocorrenciasDe(serie);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "crm_task.created",
        resourceId: ocorrencia!.id,
        metadata: expect.objectContaining({ origem: "tarefa:recorrencia" }),
      }),
    );
  });

  it("agendador e conclusão JUNTOS gravam uma só", async () => {
    const serie = await criarSerie({ title: "Agendador: corrida", dueDate: SEGUNDA_PASSADA });

    await Promise.all([
      gerarOcorrencias(db, SEGUNDA_8H),
      criarProximaDaSerie(
        db,
        { id: serie, organization_id: ORG_SP, recurrence_source_id: null, due_date: SEGUNDA_PASSADA },
        SEGUNDA_8H,
      ),
    ]);

    expect(await ocorrenciasDe(serie)).toHaveLength(1);
  });

  it("diária e mensal também: o dia 31 cai no último dia de novembro", async () => {
    const diaria = await criarSerie({
      title: "Agendador: diária",
      dueDate: SEGUNDA_PASSADA,
      recurrence: { tipo: "diaria", dias: [], dia_do_mes: null, hora: 9, ativa: true },
    });
    const mensal = await criarSerie({
      title: "Agendador: mensal",
      dueDate: SEGUNDA_PASSADA,
      recurrence: { tipo: "mensal", dias: [], dia_do_mes: 31, hora: 9, ativa: true },
    });

    await gerarOcorrencias(db, SEGUNDA_8H);

    expect((await ocorrenciasDe(diaria))[0]!.due_date.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect((await ocorrenciasDe(mensal))[0]!.due_date.toISOString()).toBe("2026-11-30T12:00:00.000Z");
  });

  it("série desligada não gera", async () => {
    const desligada = await criarSerie({
      title: "Agendador: desligada",
      dueDate: SEGUNDA_PASSADA,
      recurrence: { ...REGRA_SEGUNDA_9H, ativa: false },
    });
    await gerarOcorrencias(db, SEGUNDA_8H);
    expect(await ocorrenciasDe(desligada)).toHaveLength(0);
  });

  it("generates active organizations' tasks even when older suspended series could fill the batch", async () => {
    const orgParada = "e4595000-0000-4000-8000-00000000000c";
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name, status)
       values ($1, 'recorrencia-4595-suspensa', 'Org suspensa', 'Org suspensa', 'suspended')`,
      [orgParada],
    );
    await pool.query(
      `insert into crm_tasks (organization_id, title, due_date, created_at, status, recurrence)
       select $1, 'Paused series ' || n, $2::timestamptz, $2::timestamptz, 'done', $3::jsonb
         from generate_series(1, $4::integer) as n`,
      [orgParada, SEGUNDA_PASSADA.toISOString(), regraJson(REGRA_SEGUNDA_9H), TAMANHO_DO_LOTE],
    );
    const ativa = await criarSerie({
      title: "Agendador: org ativa",
      dueDate: SEGUNDA_PASSADA,
    });

    await gerarOcorrencias(db, SEGUNDA_8H);

    expect(await ocorrenciasDe(ativa)).toHaveLength(1);
    const criadasNaOrgParada = await db.query(
      "select id from crm_tasks where organization_id = $1 and recurrence_source_id is not null",
      [orgParada],
    );
    expect(criadasNaOrgParada).toHaveLength(0);
  });
});
