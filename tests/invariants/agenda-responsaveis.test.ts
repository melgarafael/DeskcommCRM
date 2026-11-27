import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * RESPONSÁVEIS DA CONSULTA (#3067, F2) — invariantes de BANCO. Roda só no CI
 * (`pnpm test:db`): exige o baseline aplicado com o apêndice novo.
 *
 * Casos = seção F do desenho. Cada um nomeia o que deve ACONTECER. A régua de
 * decisão (F.6) fica `it.todo` até o Paulo decidir. O F.16 (estado do PATCH:
 * resposta e auditoria) é de camada de rota e está nos testes unitários do
 * `_handler`, não aqui.
 *
 * Escrita de consulta passa por `fn_appointment_change` com JWT de quem pede
 * (`set local role authenticated`), como a tela: `fn_appointment_change_core`
 * não é concedida a `authenticated`.
 *
 * ISOLAMENTO ENTRE CASOS: os casos não se limpam. O índice
 * `calendar_appointments_sem_duplicata_idx` é único em (organização, dono,
 * começo) enquanto o compromisso está pending/confirmed; por isso cada
 * compromisso nasce num horário DIFERENTE por padrão (`novoHorario`), e só os
 * casos que precisam de sobreposição passam o mesmo horário de propósito.
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

// Próxima terça-feira: a reserva de serviço usa o relógio real do banco (mesmo molde de agenda-servicos.test.ts).
const diaDaAula = new Date();
diaDaAula.setUTCHours(0, 0, 0, 0);
diaDaAula.setUTCDate(diaDaAula.getUTCDate() + ((2 - diaDaAula.getUTCDay() + 7) % 7 || 7));
function em(hora: string, dias = 0): string {
  const dia = new Date(diaDaAula);
  dia.setUTCDate(dia.getUTCDate() + dias);
  return `${dia.toISOString().slice(0, 10)}T${hora}`;
}

type Horario = { inicio: string; fim: string };
let sequencia = 0;
/** Um horário novo a cada chamada: 2 h de distância, 1 h de duração, a partir de 05/01/2027 08:00Z. */
function novoHorario(): Horario {
  const base = Date.UTC(2027, 0, 5, 8, 0, 0);
  const ini = new Date(base + sequencia++ * 2 * 3600 * 1000);
  return { inicio: ini.toISOString(), fim: new Date(ini.getTime() + 3600 * 1000).toISOString() };
}

async function criaUsuario(id: string) {
  await pool.query("insert into auth.users(id,email) values($1,$2) on conflict (id) do nothing", [
    id,
    `${id}@responsaveis.test`,
  ]);
}
async function vincula(user: string, org: string, revogado = false, papel = "agent") {
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at,revoked_at) values($1,$2,$4,now(),$3) on conflict do nothing",
    [org, user, revogado ? new Date() : null, papel],
  );
}
/** Disponível a semana toda, em UTC: sem isso `fn_calendar_service_person_available` recusa por "sem jornada", e não pelo motivo que o caso testa. */
async function disponivelNaSemanaToda(user: string, org: string) {
  const windows = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "00:00", end: "23:59" }));
  await pool.query(
    "insert into attendant_availability(organization_id,user_id,is_available,schedule) values($1,$2,true,$3) on conflict(organization_id,user_id) do update set is_available=true,schedule=excluded.schedule",
    [org, user, { timezone: "UTC", windows }],
  );
}
async function compromisso(org: string, owner: string, h: Horario = novoHorario()): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into calendar_appointments(id,organization_id,owner_user_id,title,starts_at,ends_at,status,time_zone) values($1,$2,$3,'Consulta fictícia',$4,$5,'confirmed','America/Sao_Paulo')",
    [id, org, owner, h.inicio, h.fim],
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
async function contato(org = A.org): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Participante fictício')", [id, org]);
  return id;
}
/** Serviço com a mesma semente de agenda-servicos.test.ts: terça às 14:00 locais (= 17:00Z), 40 min, sem aviso mínimo. */
async function servico(modo = "collective_unlimited", org = A.org): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into calendar_event_types(id,organization_id,name,slug,duration_minutes,minimum_notice_minutes,service_enabled,booking_mode,service_capacity) values($1::uuid,$2,'Atividade fictícia',$1::text,40,0,true,$3,$4)",
    [id, org, modo, null],
  );
  await pool.query(
    "insert into calendar_service_schedule(organization_id,event_type_id,weekday,timing_kind,start_minute) values($1,$2,2,'fixed',840)",
    [org, id],
  );
  return id;
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
/** Quantas linhas de `calendar_appointment_responsibles` o usuário (JWT authenticated) enxerga para o compromisso. */
async function linhasQueOUsuarioLe(user: string, compromissoId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: "authenticated", aal: "aal1" }),
    ]);
    const r = await client.query(
      "select count(*)::int n from calendar_appointment_responsibles where appointment_id=$1",
      [compromissoId],
    );
    return r.rows[0].n as number;
  } finally {
    await client.query("rollback");
    client.release();
  }
}

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
  for (const u of [A.manager, A.colega, ...adicionais]) await disponivelNaSemanaToda(u, A.org);
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

  // Fora de serviço o PATCH não troca o principal (`fn_appointment_change_core` ignora `owner_user_id`),
  // então a sobreposição é montada por INSERT direto e a alteração seguinte é que tem de recusar.
  it("F.2b: com o principal repetido entre os adicionais, a alteração é recusada (revalidação depois do UPDATE)", async () => {
    const id = await compromisso(A.org, A.manager);
    await porDoAdicional(id, A.manager);
    await expect(alterarA(id, { title: "Qualquer alteração" })).rejects.toThrow("appointment_responsibles_invalid");
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
    const h = novoHorario(); // o MESMO horário nas duas, de propósito
    const outra = await compromisso(A.org, A.colega, h);
    await porDoAdicional(outra, Y);
    const nova = await compromisso(A.org, A.manager, h);
    await expect(alterarA(nova, { responsible_user_ids: [Y] })).rejects.toMatchObject({ code: "PT409", detail: Y });
    expect(await adicionaisDe(nova)).toHaveLength(0);
  });
});

describe("responsáveis — sessão coletiva (equipe herdada)", () => {
  const actor = { type: "user", id: A.manager };
  const reservar = (tipo: string, contactId: string, extra: Record<string, unknown> = {}) =>
    pool.query("select fn_calendar_service_book($1,$2,$3) r", [
      A.org,
      actor,
      { event_type_id: tipo, starts_at: em("17:00:00Z"), contact_id: contactId, operation_key: randomUUID(), ...extra },
    ]);
  const ordenados = (ids: string[]) => [...ids].sort();

  it("F.7: a segunda reserva da mesma sessão herda a equipe; equipe diferente é service_team_conflict", async () => {
    const tipo = await servico();
    const [c1, c2, c3] = [await contato(), await contato(), await contato()];
    const primeira = await reservar(tipo, c1, { responsible_user_ids: [X, Y] });
    expect(ordenados(primeira.rows[0].r.responsible_user_ids)).toEqual(ordenados([X, Y]));
    const herdada = await reservar(tipo, c2);
    expect(ordenados(herdada.rows[0].r.responsible_user_ids)).toEqual(ordenados([X, Y]));
    await expect(reservar(tipo, c3, { responsible_user_ids: [X] })).rejects.toMatchObject({ code: "PT409" });
  });

  it("F.8: reenvio com a mesma chave e equipe diferente é service_idempotency_conflict, não a reserva antiga", async () => {
    const tipo = await servico();
    const c = await contato();
    const chave = randomUUID();
    // Pessoas que o F.7 não usa: ele ocupa X e Y neste mesmo horário.
    const [primeiro, outro] = [umAdicional(adicionais, 3), umAdicional(adicionais, 4)];
    await reservar(tipo, c, { operation_key: chave, responsible_user_ids: [primeiro] });
    await expect(reservar(tipo, c, { operation_key: chave, responsible_user_ids: [outro] })).rejects.toThrow(
      "service_idempotency_conflict",
    );
  });
});

describe("responsáveis — remarcação e lista vazia", () => {
  it("F.9: remarcar para horário em que o adicional está ocupado recusa, e o horário antigo continua gravado", async () => {
    const ocupado = novoHorario();
    await compromisso(A.org, Z, ocupado); // Z é principal nesse horário
    const hMinha = novoHorario();
    const minha = await compromisso(A.org, A.manager, hMinha);
    await porDoAdicional(minha, Z);
    await expect(alterarA(minha, { starts_at: ocupado.inicio, ends_at: ocupado.fim })).rejects.toThrow(
      "responsible_unavailable",
    );
    const { rows } = await pool.query("select starts_at from calendar_appointments where id=$1", [minha]);
    expect(new Date(rows[0].starts_at).toISOString()).toBe(new Date(hMinha.inicio).toISOString());
  });

  it("F.10: remarcar sem mexer na equipe, com o adicional livre, dá certo e mantém a equipe", async () => {
    const minha = await compromisso(A.org, A.manager);
    await porDoAdicional(minha, Y);
    const novo = novoHorario();
    await alterarA(minha, { starts_at: novo.inicio, ends_at: novo.fim });
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
  it("F.12: o usuário de B não lê os responsáveis de A e não inclui membro de A; o de A lê os próprios (controle positivo)", async () => {
    const deA = await compromisso(A.org, A.manager);
    await porDoAdicional(deA, X);
    expect(await linhasQueOUsuarioLe(A.manager, deA)).toBeGreaterThanOrEqual(1); // controle positivo
    expect(await linhasQueOUsuarioLe(B.manager, deA)).toBe(0);
    const daB = await compromisso(B.org, B.manager);
    await expect(alteraComo(B.manager, B.org, daB, { responsible_user_ids: [X] })).rejects.toThrow(
      "appointment_responsibles_invalid",
    );
  });

  it("F.12b: criar com adicionais em OUTRA organização pela RPC é appointment_forbidden e não grava nada; em A, grava (controle positivo)", async () => {
    const tipo = randomUUID();
    await pool.query(
      "insert into calendar_event_types(id,organization_id,name,slug,duration_minutes) values($1::uuid,$2,'Consulta fictícia',$1::text,60)",
      [tipo, A.org],
    );
    const criaComo = async (user: string, h: Horario, adicionaisPedidos: string[]) => {
      const id = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: user, role: "authenticated", aal: "aal1" }),
        ]);
        await client.query("select fn_appointment_insert_with_responsibles($1,$2::jsonb,$3::uuid[])", [
          A.org,
          JSON.stringify({
            id,
            event_type_id: tipo,
            title: "Consulta fictícia",
            starts_at: h.inicio,
            ends_at: h.fim,
            time_zone: "UTC",
            owner_user_id: A.manager,
            location_kind: "in_person",
            team_guest_user_ids: [],
          }),
          adicionaisPedidos,
        ]);
        await client.query("commit");
      } catch (erro) {
        await client.query("rollback");
        throw erro;
      } finally {
        client.release();
      }
      return id;
    };
    const gravados = async (id: string) =>
      Number((await pool.query("select count(*) n from calendar_appointments where id=$1", [id])).rows[0].n);

    const idDeA = await criaComo(A.manager, novoHorario(), [X]); // controle positivo
    expect(await gravados(idDeA)).toBe(1);
    expect(await adicionaisDe(idDeA)).toEqual([X]);

    const antes = Number(
      (await pool.query("select count(*) n from calendar_appointment_responsibles where organization_id=$1", [A.org])).rows[0].n,
    );
    await expect(criaComo(B.manager, novoHorario(), [Y])).rejects.toThrow("appointment_forbidden");
    const depois = Number(
      (await pool.query("select count(*) n from calendar_appointment_responsibles where organization_id=$1", [A.org])).rows[0].n,
    );
    expect(depois).toBe(antes);
    const { rows } = await pool.query(
      "select count(*) n from calendar_appointments where organization_id=$1 and created_by_user_id=$2",
      [A.org, B.manager],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("F.13: revoked_at mantém a linha (a checagem de membro ativo impede novas); remover o vínculo apaga a linha", async () => {
    const membroDeLinha = randomUUID();
    await criaUsuario(membroDeLinha);
    await vincula(membroDeLinha, A.org);
    const minha = await compromisso(A.org, A.manager);
    await porDoAdicional(minha, membroDeLinha);
    await pool.query("update user_organizations set revoked_at=now() where user_id=$1 and organization_id=$2", [
      membroDeLinha,
      A.org,
    ]);
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
    const tipo = await servico();
    const ocupadoComoAdicional = await compromisso(A.org, A.colega, { inicio: em("17:00:00Z"), fim: em("17:40:00Z") });
    await porDoAdicional(ocupadoComoAdicional, Z);
    const { rows } = await pool.query("select fn_calendar_service_check($1,$2,$3,null,null,now()) result", [
      A.org,
      tipo,
      em("17:00:00Z"),
    ]);
    expect(rows[0].result).toMatchObject({ available: true });
  });

  it.todo("F.6: adicional como principal de consulta coletiva no mesmo horário — decisão do Paulo (desenho, G.6)");
});

/**
 * A CHAVE "COLEGAS PODEM MEXER NA AGENDA" VALE PARA OS ADICIONAIS (#5280).
 *
 * Com a chave desligada, quem está abaixo de gerente não marca na agenda de um
 * colega como principal (`appointment_do_colega`). O adicional também ocupa a
 * agenda de quem é incluído, então segue a mesma régua nas três portas: criação
 * com equipe, edição da lista e reserva de serviço feita por pessoa.
 * Organização própria (C), para ligar e desligar a chave sem tocar em A.
 */
describe("responsáveis — a chave de agenda dos colegas vale para os adicionais", () => {
  const C = { org: randomUUID(), atendente: randomUUID(), gerente: randomUUID(), colega: randomUUID() };
  const chave = (ligada: boolean) =>
    pool.query(
      "update organizations set settings=coalesce(settings,'{}'::jsonb)||jsonb_build_object('colegas_podem_mexer_na_agenda',$2::boolean) where id=$1",
      [C.org, ligada],
    );
  let tipoC = "";

  beforeAll(async () => {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$2,'Responsáveis C','Responsáveis C') on conflict do nothing",
      [C.org, `resp-c-${C.org.slice(0, 8)}`],
    );
    for (const u of [C.atendente, C.gerente, C.colega]) await criaUsuario(u);
    await vincula(C.atendente, C.org);
    await vincula(C.colega, C.org);
    await vincula(C.gerente, C.org, false, "manager");
    for (const u of [C.atendente, C.gerente, C.colega]) await disponivelNaSemanaToda(u, C.org);
    tipoC = randomUUID();
    await pool.query(
      "insert into calendar_event_types(id,organization_id,name,slug,duration_minutes) values($1::uuid,$2,'Consulta fictícia',$1::text,60)",
      [tipoC, C.org],
    );
    await chave(false);
  });

  /** Cria pela RPC da tela, como o usuário (JWT). Commita no sucesso, desfaz na recusa. */
  async function criaComo(user: string, dono: string, adicionaisPedidos: string[]): Promise<string> {
    const id = randomUUID();
    const h = novoHorario();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: user, role: "authenticated", aal: "aal1" }),
      ]);
      await client.query("select fn_appointment_insert_with_responsibles($1,$2::jsonb,$3::uuid[])", [
        C.org,
        JSON.stringify({
          id,
          event_type_id: tipoC,
          title: "Consulta fictícia",
          starts_at: h.inicio,
          ends_at: h.fim,
          time_zone: "UTC",
          owner_user_id: dono,
          location_kind: "in_person",
          team_guest_user_ids: [],
        }),
        adicionaisPedidos,
      ]);
      await client.query("commit");
    } catch (erro) {
      await client.query("rollback");
      throw erro;
    } finally {
      client.release();
    }
    return id;
  }
  const existe = async (id: string) =>
    Number((await pool.query("select count(*) n from calendar_appointments where id=$1", [id])).rows[0].n);
  /** Reserva de serviço como pessoa (o ator que `fn_calendar_service_create_authenticated` monta). */
  const reservaComo = async (user: string, tipo: string, semana: number, equipe: string[]) => {
    const c = await contato(C.org);
    const r = await pool.query("select fn_calendar_service_book($1,$2,$3) r", [
      C.org,
      { type: "user", id: user },
      { event_type_id: tipo, starts_at: em("17:00:00Z", 7 * semana), contact_id: c, operation_key: randomUUID(), responsible_user_ids: equipe },
    ]);
    return { contato: c, consulta: r.rows[0].r as { id: string; responsible_user_ids: string[] } };
  };
  const reservasDoContato = async (c: string) =>
    Number((await pool.query("select count(*) n from calendar_appointments where contact_id=$1", [c])).rows[0].n);

  it("criação: o atendente que inclui um colega como adicional é recusado e nada é gravado", async () => {
    await expect(criaComo(C.atendente, C.atendente, [C.colega])).rejects.toThrow("appointment_do_colega");
    const { rows } = await pool.query(
      "select count(*) n from calendar_appointments where organization_id=$1 and created_by_user_id=$2",
      [C.org, C.atendente],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("criação (controles): o gerente inclui o colega; com a chave ligada, o atendente também", async () => {
    const doGerente = await criaComo(C.gerente, C.gerente, [C.colega]);
    expect(await existe(doGerente)).toBe(1);
    expect(await adicionaisDe(doGerente)).toEqual([C.colega]);
    await chave(true);
    try {
      const doAtendente = await criaComo(C.atendente, C.atendente, [C.colega]);
      expect(await adicionaisDe(doAtendente)).toEqual([C.colega]);
    } finally {
      await chave(false);
    }
  });

  it("edição: o atendente que põe um colega na lista do próprio compromisso é recusado e a lista não muda", async () => {
    const minha = await compromisso(C.org, C.atendente);
    await expect(alteraComo(C.atendente, C.org, minha, { responsible_user_ids: [C.colega] })).rejects.toThrow(
      "appointment_do_colega",
    );
    expect(await adicionaisDe(minha)).toEqual([]);
  });

  it("edição: a lista enviada conta inteira — o colega que já estava não se mantém sem a chave; tirá-lo pode", async () => {
    const minha = await compromisso(C.org, C.atendente);
    await porDoAdicional(minha, C.colega, C.org); // posto antes (por um gerente, ou com a chave ligada)
    await expect(alteraComo(C.atendente, C.org, minha, { responsible_user_ids: [C.colega] })).rejects.toThrow(
      "appointment_do_colega",
    );
    expect(await adicionaisDe(minha)).toEqual([C.colega]);
    await alteraComo(C.atendente, C.org, minha, { responsible_user_ids: [] });
    expect(await adicionaisDe(minha)).toEqual([]);
  });

  it("edição (controles): o gerente põe o colega; com a chave ligada, o atendente também", async () => {
    const doGerente = await compromisso(C.org, C.gerente);
    await alteraComo(C.gerente, C.org, doGerente, { responsible_user_ids: [C.colega] });
    expect(await adicionaisDe(doGerente)).toEqual([C.colega]);
    const minha = await compromisso(C.org, C.atendente);
    await chave(true);
    try {
      await alteraComo(C.atendente, C.org, minha, { responsible_user_ids: [C.colega] });
    } finally {
      await chave(false);
    }
    expect(await adicionaisDe(minha)).toEqual([C.colega]);
  });

  it("reserva de serviço: o atendente que traz um colega na equipe é recusado e nada é gravado", async () => {
    const tipo = await servico("collective_unlimited", C.org);
    const c = await contato(C.org);
    await expect(
      pool.query("select fn_calendar_service_book($1,$2,$3) r", [
        C.org,
        { type: "user", id: C.atendente },
        { event_type_id: tipo, starts_at: em("17:00:00Z"), contact_id: c, operation_key: randomUUID(), responsible_user_ids: [C.colega] },
      ]),
    ).rejects.toThrow("appointment_do_colega");
    expect(await reservasDoContato(c)).toBe(0);
  });

  it("reserva de serviço (controles): o atendente se inclui; o gerente traz o colega; com a chave ligada, o atendente também", async () => {
    const proprio = await reservaComo(C.atendente, await servico("collective_unlimited", C.org), 1, [C.atendente]);
    expect(proprio.consulta.responsible_user_ids).toEqual([C.atendente]);
    const doGerente = await reservaComo(C.gerente, await servico("collective_unlimited", C.org), 2, [C.colega]);
    expect(doGerente.consulta.responsible_user_ids).toEqual([C.colega]);
    await chave(true);
    try {
      const comChave = await reservaComo(C.atendente, await servico("collective_unlimited", C.org), 3, [C.colega]);
      expect(comChave.consulta.responsible_user_ids).toEqual([C.colega]);
    } finally {
      await chave(false);
    }
  });

  it("edição de reserva sem profissional: o atendente se inclui como adicional, e o colega continua recusado", async () => {
    const { consulta } = await reservaComo(C.atendente, await servico("collective_unlimited", C.org), 4, []);
    await expect(alteraComo(C.atendente, C.org, consulta.id, { responsible_user_ids: [C.colega] })).rejects.toThrow(
      "appointment_do_colega",
    );
    await alteraComo(C.atendente, C.org, consulta.id, { responsible_user_ids: [C.atendente] });
    expect(await adicionaisDe(consulta.id)).toEqual([C.atendente]);
  });
});
