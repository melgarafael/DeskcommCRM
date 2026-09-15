import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { TAG_DE_CLIENTE } from "@/lib/contacts/cliente";
import { funilDeEntrada, garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * O CONTATO VIRA CLIENTE QUANDO TEM HORA MARCADA (migration 0255).
 *
 * Invariante de banco, e não teste de unidade, porque o que se mede aqui É o
 * banco: um TRIGGER (`trg_agendamento_marca_cliente`), um índice único parcial e
 * a convivência com a cascata de LGPD. Nada disso existe fora do Postgres, e um
 * dublê de `supabase` provaria só que o dublê concorda comigo.
 *
 * Congela: (1) o agendamento carimba a coluna e a etiqueta; (2) a data só anda
 * para trás e a segunda marcação não move `updated_at`; (3) agendamento sem
 * contato não toca ninguém; (4) contato anonimizado não é re-etiquetado, e a
 * data sobrevive à cascata; (5) a marca de funil de clientes é exclusiva por
 * organização; (6) o trigger não atravessa organizações; (7) o lead de quem já é
 * cliente nasce no funil de clientes, e cai no padrão em toda falha.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG_A = "c11e0000-0000-4000-8000-000000000001";
/** Segunda organização: sem ela, "o trigger não atravessa tenant" não é provável. */
const ORG_B = "c11e0000-0000-4000-8000-000000000002";
const CONVERSA = "c11e0000-0000-4000-8000-00000000c001";

async function criarOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Cliente LTDA', 'Cliente') on conflict (id) do nothing`,
    [id, slug],
  );
}

async function criarContato(org: string, nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source) values ($1, $2, 'whatsapp') returning id`,
    [org, nome],
  );
  return rows[0]!.id;
}

/**
 * INSERT direto, e não pela rota: o que está sob teste é o TRIGGER. Passar pelo
 * handler traria junto disponibilidade, jornada e dono do tipo de atendimento —
 * e um vermelho ali não falaria desta feature.
 */
async function marcarAgendamento(
  org: string,
  contato: string | null,
  inicio: string,
): Promise<void> {
  await pool.query(
    `insert into calendar_appointments
       (organization_id, title, starts_at, ends_at, contact_id)
     values ($1, 'Atendimento', $2::timestamptz, $2::timestamptz + interval '1 hour', $3)`,
    [org, inicio, contato],
  );
}

async function lerContato(id: string): Promise<{
  first_service_at: Date | null;
  tags: string[];
  updated_at: Date;
}> {
  const { rows } = await pool.query(
    "select first_service_at, tags, updated_at from contacts where id = $1",
    [id],
  );
  return rows[0]!;
}

beforeAll(async () => {
  await criarOrg(ORG_A, "org-cliente-a");
  await criarOrg(ORG_B, "org-cliente-b");
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("o contato vira cliente", () => {
  it("o agendamento carimba a data e acrescenta a etiqueta", async () => {
    const contato = await criarContato(ORG_A, "Joana");
    const antes = await lerContato(contato);
    expect(antes.first_service_at, "contato novo não é cliente").toBeNull();

    await marcarAgendamento(ORG_A, contato, "2026-03-12T14:00:00Z");

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe("2026-03-12T14:00:00.000Z");
    expect(depois.tags).toContain(TAG_DE_CLIENTE);
  });

  it("a data anda para TRÁS, nunca para frente", async () => {
    // Um atendimento antigo cadastrado depois (importação, sync) corrige a data
    // em vez de ser ignorado — é isso que faz trigger e backfill conviverem sem
    // que a ordem de aplicação importe.
    const contato = await criarContato(ORG_A, "Marta");
    await marcarAgendamento(ORG_A, contato, "2026-03-12T14:00:00Z");

    await marcarAgendamento(ORG_A, contato, "2026-09-01T10:00:00Z"); // posterior
    expect((await lerContato(contato)).first_service_at?.toISOString()).toBe(
      "2026-03-12T14:00:00.000Z",
    );

    await marcarAgendamento(ORG_A, contato, "2021-01-05T09:00:00Z"); // anterior
    expect((await lerContato(contato)).first_service_at?.toISOString()).toBe(
      "2021-01-05T09:00:00.000Z",
    );
  });

  it("a enésima marcação não duplica a etiqueta NEM move updated_at", async () => {
    // É o predicado do trigger sob teste. Sem ele, todo agendamento reescreveria
    // a linha do contato: `updated_at` novo, evento de realtime, e a lista de
    // contatos saltando à toa numa operação que marca dezenas de horários por dia.
    const contato = await criarContato(ORG_A, "Rita");
    await marcarAgendamento(ORG_A, contato, "2026-03-12T14:00:00Z");
    const primeiro = await lerContato(contato);

    await marcarAgendamento(ORG_A, contato, "2026-04-20T15:00:00Z");
    const segundo = await lerContato(contato);

    expect(segundo.tags.filter((t) => t === TAG_DE_CLIENTE)).toHaveLength(1);
    expect(segundo.updated_at.toISOString()).toBe(primeiro.updated_at.toISOString());
  });

  it("agendamento sem contato não toca contato nenhum", async () => {
    const contato = await criarContato(ORG_A, "Ninguém");
    await marcarAgendamento(ORG_A, null, "2026-05-01T12:00:00Z");
    expect((await lerContato(contato)).first_service_at).toBeNull();
  });

  it("não atravessa organização: agendamento da A não marca contato da B", async () => {
    const naOutra = await criarContato(ORG_B, "Alheia");
    // O INSERT usa a org A com um contato da B. A FK não impede (é por id), e é
    // justamente a rede que o filtro de `organization_id` no trigger existe para
    // ser. Se o insert for recusado pelo banco, melhor ainda — o teste aceita as
    // duas formas de estar protegido, e reprova só se o contato for marcado.
    await marcarAgendamento(ORG_A, naOutra, "2026-06-01T12:00:00Z").catch(() => {});
    expect((await lerContato(naOutra)).first_service_at).toBeNull();
  });
});

describe("a LGPD", () => {
  it("contato anonimizado não é re-etiquetado, e a data sobrevive", async () => {
    // A cascata zera `tags` de propósito: `cliente` é etiqueta comercial sobre a
    // pessoa. Já a DATA fica — que houve atendimento e quando é registro de
    // operação, e a linha em `calendar_appointments` permanece de qualquer forma.
    // Sem a guarda `is_anonymized = false` no trigger, um agendamento posterior
    // devolveria a etiqueta a quem a LGPD mandou apagar.
    const contato = await criarContato(ORG_A, "Apagada");
    await marcarAgendamento(ORG_A, contato, "2026-03-12T14:00:00Z");

    await pool.query(
      "update contacts set is_anonymized = true, anonymized_at = now(), tags = '{}'::text[] where id = $1",
      [contato],
    );

    await marcarAgendamento(ORG_A, contato, "2026-07-01T09:00:00Z");

    const depois = await lerContato(contato);
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
    expect(depois.first_service_at?.toISOString()).toBe("2026-03-12T14:00:00.000Z");
  });
});

describe("o funil de clientes", () => {
  it("é exclusivo por organização, e independente entre organizações", async () => {
    const marcar = (org: string, slug: string) =>
      pool.query(
        `insert into crm_pipelines (organization_id, name, slug, position, is_client_pipeline)
         values ($1, 'Clientes', $2, 9000, true)`,
        [org, slug],
      );

    await marcar(ORG_A, "clientes-a");
    await expect(marcar(ORG_A, "clientes-a2")).rejects.toMatchObject({ code: "23505" });
    // Outra organização não disputa a marca — o índice é por `organization_id`.
    await expect(marcar(ORG_B, "clientes-b")).resolves.toBeDefined();
  });

  it("o lead de quem já é cliente nasce no funil de clientes", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "select id from crm_pipelines where organization_id = $1 and is_client_pipeline",
      [ORG_A],
    );
    const funilDeClientes = rows[0]!.id;
    await pool.query(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position)
       values ($1, $2, 'Voltou a falar', 'voltou-a-falar', 1000)`,
      [ORG_A, funilDeClientes],
    );

    const contato = await criarContato(ORG_A, "Antiga");
    await marcarAgendamento(ORG_A, contato, "2024-02-02T10:00:00Z");

    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_A,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Antiga",
    });

    expect(r.criado, `esperava criar, veio ${JSON.stringify(r)}`).toBe(true);
    if (!r.criado) return;
    expect(r.pipelineId).toBe(funilDeClientes);
  });

  it("quem NÃO é cliente continua no funil de entrada, mesmo havendo funil de clientes", async () => {
    // O caso que uma implementação apressada quebra: ligar o funil de clientes e
    // mandar todo mundo para lá.
    const contato = await criarContato(ORG_A, "Nova");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_A,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Nova",
    });

    expect(r.criado).toBe(true);
    if (!r.criado) return;
    const padrao = await funilDeEntrada(db, ORG_A);
    expect("erro" in padrao).toBe(false);
    if ("erro" in padrao) return;
    expect(r.pipelineId).toBe(padrao.pipelineId);
  });

  it("funil de clientes SEM etapa utilizável cai no padrão — o lead nasce de qualquer jeito", async () => {
    // A degradação é o ponto da feature: a classificação pode errar o funil, ela
    // não pode impedir o lead de nascer. Um clone que marcou o funil e ainda não
    // desenhou as etapas não pode perder ninguém.
    const { rows } = await pool.query<{ id: string }>(
      "select id from crm_pipelines where organization_id = $1 and is_client_pipeline",
      [ORG_B],
    );
    const semEtapaAberta = rows[0]!.id;
    await pool.query(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won)
       values ($1, $2, 'Ganho', 'ganho-clientes-b', 1000, true)`,
      [ORG_B, semEtapaAberta],
    );

    const contato = await criarContato(ORG_B, "Cliente da B");
    await marcarAgendamento(ORG_B, contato, "2024-05-05T10:00:00Z");

    const destino = await funilDeEntrada(db, ORG_B, true);
    expect("erro" in destino, `esperava destino, veio ${JSON.stringify(destino)}`).toBe(false);
    if ("erro" in destino) return;
    expect(destino.pipelineId).not.toBe(semEtapaAberta);
  });
});
