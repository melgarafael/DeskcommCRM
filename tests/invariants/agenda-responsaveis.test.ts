import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * RESPONSÁVEIS DA CONSULTA (#3067, F2) — invariantes de BANCO. Roda só no CI
 * (`pnpm test:db`): exige o baseline aplicado com o apêndice novo.
 *
 * Casos = seção F do desenho ("Desenho F2"). Cada um nomeia o que deve
 * ACONTECER. A régua de decisão (F.6) fica `it.todo` até o Paulo decidir.
 * O F.16 (estado do PATCH: resposta e auditoria) é de camada de rota e está nos
 * testes unitários do `_handler`, não aqui.
 *
 * Escrita de consulta passa por `fn_appointment_change` com JWT de quem pede
 * (`set local role authenticated`), como a tela: `fn_appointment_change_core`
 * não é concedida a `authenticated`.
 */

const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});

const A = { org: randomUUID(), manager: randomUUID(), colega: randomUUID(), removido: randomUUID() };
const B = { org: randomUUID(), manager: randomUUID() };
const adicionais = Array.from({ length: 10 }, () => randomUUID());
// Índice de array com `noUncheckedIndexedAccess`: o helper devolve `string` e falha alto se faltar.
const umAdicional = (lista: readonly string[], i: number): string => {
  const v = lista[i];
  if (!v) throw new Error(`falta o adicional ${i}`);
  return v;
};
const X = umAdicional(adicionais, 0);
const Y = umAdicional(adicionais, 1);
const Z = umAdicional(adicionais, 2);
const inativo = randomUUID(); // membro de A com revoked_at
const deFora = randomUUID(); // membro só de B
const INICIO = "2026-12-01T14:00:00Z";
const FIM = "2026-12-01T15:00:00Z";
const DEPOIS = "2026-12-01T18:00:00Z";
const FIM_DEPOIS = "2026-12-01T19:00:00Z";

async function criaUsuario(id: string) {
  await pool.query("insert into auth.users(id,email) values($1,$2) on conflict (id) do nothing", [
    id,
    `${id}@responsaveis.test`,
  ]);
}
async function vincula(user: string, org: string, revogado = false) {
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at,revoked_at) values($1,$2,'agent',now(),$3) on conflict do nothing",
    [org, user, revogado ? new Date() : null],
  );
}
async function compromisso(org: string, owner: string, inicio = INICIO, fim = FIM): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into calendar_appointments(id,organization_id,owner_user_id,title,starts_at,ends_at,status,time_zone) values($1,$2,$3,'Consulta fictícia',$4,$5,'confirmed','America/Sao_Paulo')",
    [id, org, owner, inicio, fim],
  );
  return id;
}
async function porDoAdicional(compromissoId: string, user: string, org = A.org) {
  await pool.query(
    "insert into calendar_appointment_responsibles(organization_id,appointment_id,user_id) values($1,$2,$3) on conflict do nothing",
    [org, compromissoId, user],
  );
}
async function adicionaisDe(compromissoId: string): Promise<string[]> {
  const { rows } = await pool.query(
    "select user_id from calendar_appointment_responsibles where appointment_id=$1 order by user_id",
    [compromissoId],
  );
  return rows.map((r: { user_id: string }) => r.user_id).sort();
}
/**
 * Altera a consulta como o usuário (JWT), pela RPC da tela. Commita no sucesso
 * (o teste depois lê o efeito) e desfaz tudo na recusa, como o banco faz.
 */
async function alteraComo(user: string, org: string, id: string, patch: Record<string, unknown>) {
  const { rows } = await pool.query("select revision from calendar_appointments where id=$1", [id]);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: "authenticated", aal: "aal1" }),
    ]);
    const r = await client.query("select fn_appointment_change($1,$2,$3,$4::jsonb) r", [
      org,
      id,
      Number(rows[0].revision),
      JSON.stringify(patch),
    ]);
    await client.query("commit");
    return r;
  } catch (erro) {
    await client.query("rollback");
    throw erro;
  } finally {
    client.release();
  }
}
const alterarA = (id: string, patch: Record<string, unknown>) => alteraComo(A.manager, A.org, id, patch);

beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,'resp-a','Responsáveis A','Responsáveis A'),($2::uuid,'resp-b','Responsáveis B','Responsáveis B') on conflict do nothing",
    [A.org, B.org],
  );
  for (const u of [A.manager, A.colega, A.removido, inativo, ...adicionais, B.manager, deFora]) await criaUsuario(u);
  for (const u of [A.manager, A.colega, A.removido, ...adicionais]) await vincula(u, A.org);
  await vincula(inativo, A.org, true);
  await vincula(B.manager, B.org);
  await vincula(deFora, B.org);
});

afterAll(() => pool.end());

describe("responsáveis — teto de 10 conduzindo (1 principal + 9 adicionais)", () => {
  it("F.1a: 10 adicionais pela RPC recusam com appointment_responsibles_limit antes de qualquer trava", async () => {
    const id = await compromisso(A.org, A.manager);
    await expect(alterarA(id, { responsible_user_ids: adicionais })).rejects.toThrow("appointment_responsibles_limit");
  });

  it("F.1b: o 10º adicional por INSERT direto é recusado pelo gatilho (22023)", async () => {
    const id = await compromisso(A.org, A.manager);
    for (const u of adicionais.slice(0, 9)) await porDoAdicional(id, u);
    expect(await adicionaisDe(id)).toHaveLength(9);
    await expect(porDoAdicional(id, umAdicional(adicionais, 9))).rejects.toMatchObject({ code: "22023" });
  });
});

describe("responsáveis — principal, repetidos, membros", () => {
  it("F.2: o principal na lista de adicionais é recusado (appointment_responsibles_invalid)", async () => {
    const id = await compromisso(A.org, A.manager);
    await expect(alterarA(id, { responsible_user_ids: [A.manager] })).rejects.toThrow("appointment_responsibles_invalid");
  });

  it("F.2b: trocar o principal para quem já é adicional é recusado (revalidação depois do UPDATE)", async () => {
    const id = await compromisso(A.org, A.manager);
    await porDoAdicional(id, X);
    await expect(alterarA(id, { owner_user_id: X })).rejects.toThrow("appointment_responsibles_invalid");
  });

  it("F.3: a mesma pessoa repetida em caixa diferente é recusada", async () => {
    const id = await compromisso(A.org, A.manager);
    await expect(alterarA(id, { responsible_user_ids: [X, X.toUpperCase()] })).rejects.toThrow(
      "appointment_responsibles_invalid",
    );
  });

  it("F.4: membro com revoked_at e membro de OUTRA organização são recusados", async () => {
    const id = await compromisso(A.org, A.manager);
    await expect(alterarA(id, { responsible_user_ids: [inativo] })).rejects.toThrow("appointment_responsibles_invalid");
    await expect(alterarA(id, { responsible_user_ids: [deFora] })).rejects.toThrow("appointment_responsibles_invalid");
  });

  it("F.5: o mesmo co-terapeuta em duas consultas no mesmo horário é recusado, nomeando quem", async () => {
    const outra = await compromisso(A.org, A.colega);
    await porDoAdicional(outra, Y);
    const nova = await compromisso(A.org, A.manager);
    await expect(alterarA(nova, { responsible_user_ids: [Y] })).rejects.toMatchObject({ code: "PT409", detail: Y });
    expect(await adicionaisDe(nova)).toHaveLength(0);
  });
});

describe("responsáveis — sessão coletiva (equipe herdada)", () => {
  async function servicoColetivo(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      "insert into calendar_event_types(id,organization_id,name,slug,duration_minutes,minimum_notice_minutes,service_enabled,booking_mode,service_capacity) values($1::uuid,$2,'Sessão fictícia',$1::text,60,0,true,'collective_unlimited',10)",
      [id, A.org],
    );
    await pool.query(
      "insert into calendar_service_schedule(organization_id,event_type_id,weekday,timing_kind,start_minute) values($1,$2,2,'fixed',840)",
      [A.org, id],
    );
    return id;
  }
  const actor = { type: "user", id: A.manager };
  const entrada = (tipo: string, extra: Record<string, unknown> = {}) => ({
    event_type_id: tipo,
    starts_at: INICIO,
    contact_id: null,
    operation_key: randomUUID(),
    ...extra,
  });

  it("F.7: a segunda reserva da mesma sessão herda a equipe; equipe diferente é service_team_conflict", async () => {
    const tipo = await servicoColetivo();
    const primeira = await pool.query("select fn_calendar_service_book($1,$2,$3) r", [A.org, actor, entrada(tipo, { responsible_user_ids: [X, Y] })]);
    expect([...primeira.rows[0].r.responsible_user_ids].sort()).toEqual([X, Y].sort());
    const herdada = await pool.query("select fn_calendar_service_book($1,$2,$3) r", [A.org, actor, entrada(tipo)]);
    expect([...herdada.rows[0].r.responsible_user_ids].sort()).toEqual([X, Y].sort());
    await expect(
      pool.query("select fn_calendar_service_book($1,$2,$3)", [A.org, actor, entrada(tipo, { responsible_user_ids: [X] })]),
    ).rejects.toMatchObject({ code: "PT409" });
  });

  it("F.8: reenvio com a mesma chave e equipe diferente é service_idempotency_conflict, não a reserva antiga", async () => {
    const tipo = await servicoColetivo();
    const chave = randomUUID();
    await pool.query("select fn_calendar_service_book($1,$2,$3)", [A.org, actor, entrada(tipo, { operation_key: chave, responsible_user_ids: [X] })]);
    await expect(
      pool.query("select fn_calendar_service_book($1,$2,$3)", [A.org, actor, entrada(tipo, { operation_key: chave, responsible_user_ids: [Y] })]),
    ).rejects.toMatchObject({ code: "PT409" });
  });
});

describe("responsáveis — remarcação e lista vazia", () => {
  it("F.9: remarcar para horário em que o adicional está ocupado recusa, e o horário antigo continua gravado", async () => {
    await compromisso(A.org, Z, DEPOIS, FIM_DEPOIS); // Z é principal em DEPOIS
    const minha = await compromisso(A.org, A.manager);
    await porDoAdicional(minha, Z);
    await expect(alterarA(minha, { starts_at: DEPOIS, ends_at: FIM_DEPOIS })).rejects.toThrow("responsible_unavailable");
    const { rows } = await pool.query("select starts_at from calendar_appointments where id=$1", [minha]);
    expect(new Date(rows[0].starts_at).toISOString()).toBe(new Date(INICIO).toISOString());
  });

  it("F.10: remarcar sem mexer na equipe, com o adicional livre, dá certo e mantém a equipe", async () => {
    const minha = await compromisso(A.org, A.manager);
    await porDoAdicional(minha, Y);
    await alterarA(minha, { starts_at: "2026-12-02T14:00:00Z", ends_at: "2026-12-02T15:00:00Z" });
    expect(await adicionaisDe(minha)).toEqual([Y]);
  });

  it("F.11: lista vazia limpa a equipe; ausente não mexe", async () => {
    const minha = await compromisso(A.org, A.manager);
    await porDoAdicional(minha, X);
    await alterarA(minha, { title: "Sem mudar a equipe" });
    expect(await adicionaisDe(minha)).toEqual([X]);
    await alterarA(minha, { responsible_user_ids: [] });
    expect(await adicionaisDe(minha)).toEqual([]);
  });
});

describe("responsáveis — isolamento entre organizações", () => {
  it("F.12: o usuário de B não lê os responsáveis de A e não inclui membro de A", async () => {
    const deA = await compromisso(A.org, A.manager);
    await porDoAdicional(deA, X);
    const lidos = await pool.connect().then(async (client) => {
      try {
        await client.query("begin");
        await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: B.manager, role: "authenticated", aal: "aal1" }),
        ]);
        const r = await client.query("select count(*)::int n from calendar_appointment_responsibles where appointment_id=$1", [deA]);
        return r.rows[0].n as number;
      } finally {
        await client.query("rollback");
        client.release();
      }
    });
    expect(lidos).toBe(0);
    const daB = await compromisso(B.org, B.manager);
    await expect(alteraComo(B.manager, B.org, daB, { responsible_user_ids: [X] })).rejects.toThrow(
      "appointment_responsibles_invalid",
    );
  });

  it("F.13: revoked_at mantém a linha (a checagem de membro ativo impede novas); remover o vínculo apaga a linha", async () => {
    const membroDeLinha = randomUUID();
    await criaUsuario(membroDeLinha);
    await vincula(membroDeLinha, A.org);
    const minha = await compromisso(A.org, A.manager);
    await porDoAdicional(minha, membroDeLinha);
    await pool.query("update user_organizations set revoked_at=now() where user_id=$1 and organization_id=$2", [membroDeLinha, A.org]);
    expect(await adicionaisDe(minha)).toHaveLength(1);
    await pool.query("delete from user_organizations where user_id=$1 and organization_id=$2", [membroDeLinha, A.org]);
    expect(await adicionaisDe(minha)).toHaveLength(0);
  });

  it("F.14: apagar o compromisso apaga a equipe dele", async () => {
    const minha = await compromisso(A.org, A.manager);
    await porDoAdicional(minha, Y);
    await pool.query("delete from calendar_appointments where id=$1", [minha]);
    expect(await adicionaisDe(minha)).toEqual([]);
  });
});

describe("responsáveis — preview e decisões em aberto", () => {
  it("F.15: o preview olha só o principal; adicional ocupado não o faz recusar (comportamento atual fixado)", async () => {
    const tipo = randomUUID();
    await pool.query(
      "insert into calendar_event_types(id,organization_id,name,slug,duration_minutes,minimum_notice_minutes,service_enabled,booking_mode,service_capacity) values($1::uuid,$2,'Preview fictício',$1::text,60,0,true,'individual',1)",
      [tipo, A.org],
    );
    await pool.query(
      "insert into calendar_service_schedule(organization_id,event_type_id,weekday,timing_kind,start_minute) values($1,$2,2,'fixed',840)",
      [A.org, tipo],
    );
    const ocupadoComoAdicional = await compromisso(A.org, A.colega, INICIO, FIM);
    await porDoAdicional(ocupadoComoAdicional, Z);
    const { rows } = await pool.query("select fn_calendar_service_check($1,$2,$3,null,null,now()) result", [A.org, tipo, INICIO]);
    expect(rows[0].result).toMatchObject({ available: true });
  });

  it.todo("F.6: adicional como principal de consulta coletiva no mesmo horário — decisão do Paulo (desenho, G.6)");
});
