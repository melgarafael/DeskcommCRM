import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEligibleAttendants, loadSectorWindow } from "@/lib/routing/eligibles";
import { routingPgSupabase } from "../support/routing-pg-supabase";
import { seedGov, GOV_AGENT_A as ana, GOV_AGENT_B as bruno, GOV_CONV_UNASSIGNED as conv, GOV_ORG as org, GOV_SESSION as canal } from "./gov-helpers";

/**
 * A FILA É DESTINO, NÃO ETIQUETA (migration 9062).
 *
 * ─── O que esta invariante protege ─────────────────────────────────────────
 *
 * Antes da 9062, "setor" agrupava e não distribuía: nenhuma coluna em
 * `conversations` apontava para um setor, e o roteamento só conhecia o número.
 * A partir dela, uma conversa pode ter FILA — e a partir daí três coisas
 * precisam ser verdade no BANCO, não só no código:
 *
 *   1. a fila é da MESMA organização da conversa (FK composta);
 *   2. apagar a fila SOLTA a conversa, sem apagar a conversa (o `on delete set
 *      null (sector_id)` com lista de colunas);
 *   3. a distribuição automática RECUSA quem não é da fila — o claim é o único
 *      ponto por onde passam o worker de rodízio e o handoff da IA.
 *
 * A quarta prova é o oposto das três: conversa SEM fila continua sendo
 * distribuída exatamente como antes. Se um dia alguém "endurecer" a guarda, é
 * esta linha que fica vermelha.
 *
 * ─── Por que no Postgres, e não num mock ───────────────────────────────────
 *
 * As três primeiras são propriedades do DDL e da função `security definer`.
 * Mock prova o que o mock quiser; aqui a régua é o banco que vai rodar na VPS
 * de quem instalar, montado a partir do `baseline.sql` — o mesmo arquivo que o
 * kit self-host aplica.
 */
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 5,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

/** Setor novo na org. Devolve o id. */
async function criarFila(organizacao: string, nome: string): Promise<string> {
  const r = await query(
    "insert into attendant_sectors (organization_id, name) values ($1,$2) returning id",
    [organizacao, nome],
  );
  return r.rows[0].id as string;
}

/** Deixa a conversa pronta para o claim: sem dono, aberta, na fila indicada. */
async function prepararConversa(sectorId: string | null): Promise<void> {
  await query(
    "update conversations set assigned_to_user_id=null, assignee_kind=null, status='open', sector_id=$3 where organization_id=$1 and id=$2",
    [org, conv, sectorId],
  );
  await query(
    "insert into attendant_availability (organization_id,user_id,is_available,capacity,schedule) values ($1,$2,true,5,'{}') on conflict (organization_id,user_id) do update set is_available=true, capacity=5, schedule='{}'",
    [org, ana],
  );
  await query(
    "insert into attendant_availability (organization_id,user_id,is_available,capacity,schedule) values ($1,$2,true,5,'{}') on conflict (organization_id,user_id) do update set is_available=true, capacity=5, schedule='{}'",
    [org, bruno],
  );
}

const claim = (userId: string) =>
  query("select fn_channel_routing_claim($1,$2,$3,$4) result", [org, conv, canal, userId]).then(
    (r) => r.rows[0].result as string,
  );

beforeAll(() => seedGov());
afterAll(() => pool.end());
beforeEach(async () => {
  await query("delete from attendant_sector_members where organization_id=$1", [org]);
  await query("delete from attendant_sectors where organization_id=$1", [org]);
  await query("delete from channel_routing_policies where organization_id=$1", [org]);
  await query(
    "update user_organizations set revoked_at=null, role='agent' where organization_id=$1 and user_id=any($2)",
    [org, [ana, bruno]],
  );
});

describe("fila de atendimento: o destino e o horário (9062)", () => {
  it("a mesma pessoa atende DUAS filas (o vínculo deixou de ser único por pessoa)", async () => {
    const comercial = await criarFila(org, "Comercial");
    const financeiro = await criarFila(org, "Financeiro");

    await query(
      "insert into attendant_sector_members (organization_id,user_id,sector_id) values ($1,$2,$3),($1,$2,$4)",
      [org, ana, comercial, financeiro],
    );

    const r = await query(
      "select count(*)::int n from attendant_sector_members where organization_id=$1 and user_id=$2",
      [org, ana],
    );
    expect(r.rows[0].n).toBe(2);
  });

  it("recusa conversa apontando para fila de OUTRA organização", async () => {
    const outra = await query(
      "insert into organizations (id,slug,legal_name,display_name) values (gen_random_uuid(),'fila-outra-'||gen_random_uuid(),'Empresa Sintética','Empresa Sintética') returning id",
    ).then((r) => r.rows[0].id as string);
    const filaAlheia = await criarFila(outra, "Comercial da outra");

    await expect(
      query("update conversations set sector_id=$3 where organization_id=$1 and id=$2", [
        org,
        conv,
        filaAlheia,
      ]),
    ).rejects.toThrow(/conversations_sector_fk/);

    // E a conversa continua sem fila: a recusa não deixa estado pela metade.
    const depois = await query("select sector_id from conversations where organization_id=$1 and id=$2", [org, conv]);
    expect(depois.rows[0].sector_id).toBeNull();
  });

  it("apagar a fila SOLTA a conversa e não apaga a conversa", async () => {
    const fila = await criarFila(org, "Suporte");
    await query("update conversations set sector_id=$3 where organization_id=$1 and id=$2", [org, conv, fila]);

    await query("delete from attendant_sectors where organization_id=$1 and id=$2", [org, fila]);

    const r = await query(
      "select id, organization_id, sector_id from conversations where organization_id=$1 and id=$2",
      [org, conv],
    );
    expect(r.rowCount).toBe(1);
    // `on delete set null (sector_id)` com LISTA DE COLUNAS: sem ela, o padrão
    // anularia `organization_id` também e este delete estouraria not-null.
    expect(r.rows[0]).toMatchObject({ organization_id: org, sector_id: null });
  });

  it("a distribuição automática RECUSA quem não é da fila da conversa", async () => {
    const fila = await criarFila(org, "Financeiro");
    // Só o bruno atende esta fila.
    await query("insert into attendant_sector_members (organization_id,user_id,sector_id) values ($1,$2,$3)", [
      org,
      bruno,
      fila,
    ]);
    await prepararConversa(fila);

    // A pessoa está disponível, dentro do horário e com folga — e mesmo assim
    // não recebe: o que barra é a FILA, não a elegibilidade.
    expect(await claim(ana)).toBe("candidate_not_in_sector");
    expect(await claim(bruno)).toBe("assigned");

    const r = await query("select assigned_to_user_id from conversations where organization_id=$1 and id=$2", [org, conv]);
    expect(r.rows[0].assigned_to_user_id).toBe(bruno);
  });

  it("sem fila, nada muda: a distribuição continua aceitando qualquer elegível", async () => {
    await prepararConversa(null);
    expect(await claim(ana)).toBe("assigned");
  });

  it("o UPGRADE de uma instalação existente troca a PK e preserva os vínculos", async () => {
    // O caminho que roda em produção NÃO é o do baseline: é o de quem já tem a
    // 0801 aplicada, com PK `(organization_id, user_id)` e uma linha por pessoa.
    // O teste acima prova a idempotência; este prova a TROCA.
    const arquivo = readFileSync(
      join(process.cwd(), "supabase/migrations/20261031180000_9062_fila_de_atendimento_destino_e_horario.sql"),
      "utf8",
    );
    const comercial = await criarFila(org, "Comercial");
    await query("insert into attendant_sector_members (organization_id,user_id,sector_id) values ($1,$2,$3)", [
      org,
      ana,
      comercial,
    ]);

    await query("begin");
    try {
      // Volta ao estado de antes da 9062, como numa instalação com a 0801.
      await query("alter table attendant_sector_members drop constraint attendant_sector_members_pkey");
      await query("alter table attendant_sector_members add primary key (organization_id, user_id)");
      await query("alter table attendant_sectors drop column if exists schedule");
      await query("alter table conversations drop constraint if exists conversations_sector_fk");
      await query("alter table conversations drop column if exists sector_id");

      await query(arquivo);

      const pk = await query(
        "select pg_get_constraintdef(c.oid) def from pg_constraint c join pg_class t on t.oid=c.conrelid where t.relname='attendant_sector_members' and c.contype='p'",
      );
      expect(pk.rows[0].def).toContain("sector_id");
      // O vínculo que já existia continua existindo — a migração não perde gente.
      const vinculo = await query(
        "select count(*)::int n from attendant_sector_members where organization_id=$1 and user_id=$2",
        [org, ana],
      );
      expect(vinculo.rows[0].n).toBe(1);
      // E agora cabe a segunda fila na mesma pessoa.
      const financeiro = await query(
        "insert into attendant_sectors (organization_id, name) values ($1,'Financeiro') returning id",
        [org],
      );
      await query("insert into attendant_sector_members (organization_id,user_id,sector_id) values ($1,$2,$3)", [
        org,
        ana,
        financeiro.rows[0].id,
      ]);
    } finally {
      await query("rollback");
    }
  });

  it("a migration roda DUAS vezes sem estourar (clone que já a aplicou)", async () => {
    const arquivo = readFileSync(
      join(process.cwd(), "supabase/migrations/20261031180000_9062_fila_de_atendimento_destino_e_horario.sql"),
      "utf8",
    );
    await query("begin");
    try {
      await query(arquivo);
      await query(arquivo);
      await query("rollback");
    } catch (error) {
      await query("rollback");
      throw error;
    }
    const r = await query(
      "select pg_get_constraintdef(c.oid) def from pg_constraint c join pg_class t on t.oid=c.conrelid where t.relname='attendant_sector_members' and c.contype='p'",
    );
    expect(r.rows[0].def).toContain("sector_id");
  });
});

/**
 * O lado TYPESCRIPT da mesma regra: `loadEligibleAttendants` com escopo de fila.
 *
 * A ponte `routingPgSupabase` roda o código REAL contra o Postgres real — o
 * mesmo harness dos testes de roteamento. O que se prova aqui é o que o claim
 * não consegue provar sozinho: que a fila é INTERSEÇÃO com o número (não
 * substituição) e que fila fechada devolve ZERO candidato — o worker, ao ver
 * zero, reenfileira; a conversa espera a abertura em vez de ser entregue fora
 * do horário.
 */
describe("fila de atendimento: quem é elegível agora", () => {
  const { client } = routingPgSupabase(pool);

  async function filaCom(horario: unknown): Promise<string> {
    const r = await query(
      "insert into attendant_sectors (organization_id, name, schedule) values ($1,$2,$3::jsonb) returning id",
      [org, `Fila ${Math.random().toString(36).slice(2, 8)}`, JSON.stringify(horario)],
    );
    return r.rows[0].id as string;
  }

  async function disponivel(userId: string): Promise<void> {
    await query(
      "insert into attendant_availability (organization_id,user_id,is_available,capacity,schedule) values ($1,$2,true,5,'{}') on conflict (organization_id,user_id) do update set is_available=true, capacity=5, schedule='{}'",
      [org, userId],
    );
  }

  it("fila com janela fechada agora não entrega ninguém (e o horário vazio é 24/7)", async () => {
    const agora = new Date();
    const amanha = new Date(agora.getTime() + 24 * 60 * 60 * 1000).getUTCDay();
    const fechada = await filaCom({
      timezone: "UTC",
      windows: [{ dow: amanha, start: "00:00", end: "23:59" }],
    });
    const aberta = await filaCom({});
    await disponivel(ana);
    await query("insert into attendant_sector_members (organization_id,user_id,sector_id) values ($1,$2,$3)", [
      org,
      ana,
      fechada,
    ]);
    await query("insert into attendant_sector_members (organization_id,user_id,sector_id) values ($1,$2,$3)", [
      org,
      ana,
      aberta,
    ]);

    expect((await loadSectorWindow(client, org, fechada, agora)).window.open).toBe(false);
    expect((await loadSectorWindow(client, org, aberta, agora)).window.open).toBe(true);

    const nenhum = await loadEligibleAttendants(client, org, agora, {
      kind: "sector",
      sectorId: fechada,
      channelSessionId: null,
    });
    expect(nenhum).toEqual([]);

    const algum = await loadEligibleAttendants(client, org, agora, {
      kind: "sector",
      sectorId: aberta,
      channelSessionId: null,
    });
    expect(algum.map((c) => c.userId)).toEqual([ana]);
  });

  it("fila ∧ número é INTERSEÇÃO: quem não responde pelo número não recebe pela fila", async () => {
    const fila = await filaCom({});
    await disponivel(ana);
    await disponivel(bruno);
    // A fila tem os dois; o número só tem o bruno.
    await query("insert into attendant_sector_members (organization_id,user_id,sector_id) values ($1,$2,$3),($1,$4,$3)", [
      org,
      ana,
      fila,
      bruno,
    ]);
    const politica = await query(
      "insert into channel_routing_policies (organization_id, channel_session_id) values ($1,$2) returning id",
      [org, canal],
    );
    await query(
      "insert into channel_routing_responsibles (organization_id, policy_id, user_id) values ($1,$2,$3)",
      [org, politica.rows[0].id, bruno],
    );

    const candidatos = await loadEligibleAttendants(client, org, new Date(), {
      kind: "sector",
      sectorId: fila,
      channelSessionId: canal,
    });
    expect(candidatos.map((c) => c.userId)).toEqual([bruno]);
  });
});
