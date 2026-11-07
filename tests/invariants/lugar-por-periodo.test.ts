/**
 * LUGAR COM CAPACIDADE POR PERÍODO (issue #4029, fatia 1).
 *
 * O que já existia, e por isso NÃO se prova aqui de novo: reserva por período
 * com teto de PESSOAS na agenda de serviço (collective_limited +
 * service_capacity, exceção por horário em calendar_service_schedule), contada
 * em `fn_calendar_service_check` durante toda a sobreposição.
 *
 * O que esta cerca prova, no PostgreSQL de verdade:
 *
 *   RED  — hoje a reserva não guarda lugar nem quantidade de pessoas: um grupo
 *          de seis entra numa mesa de quatro e nada registra isso.
 *   GREEN — a reserva escolhe UM lugar (`space_id`) e declara as pessoas;
 *           a ocupação do lugar soma pessoas ao longo do período, inclusive de
 *           outro serviço que ofereça o mesmo lugar físico.
 *
 * Lados opostos, todos medidos no banco (nunca em dublê):
 *   (a) acima da capacidade do lugar, recusa nomeada;
 *   (b) duas reservas SIMULTÂNEAS para o último lugar — só uma entra;
 *   (c) cancelar libera a vaga;
 *   (d) outra organização intacta;
 *   (e) o mesmo lugar em outro período convive;
 *   (f) papel sem permissão recebe recusa nomeada.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dia = new Date();
dia.setUTCHours(0, 0, 0, 0);
dia.setUTCDate(dia.getUTCDate() + ((2 - dia.getUTCDay() + 7) % 7 || 7));
function em(hora: string, dias = 0): string {
  const alvo = new Date(dia);
  alvo.setUTCDate(alvo.getUTCDate() + dias);
  return `${alvo.toISOString().slice(0, 10)}T${hora}`;
}
// 17:00Z = 14:00 em America/Sao_Paulo; a programação da fixture é 840 (14:00 local).
const at = em("17:00:00Z");
const depois = em("18:00:00Z");
const agora = new Date();

const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres` });
const tenant = () => ({ org: randomUUID(), manager: randomUUID(), viewer: randomUUID() });
const tenants = [tenant(), tenant()] as const;

beforeAll(async () => {
  for (const t of tenants) {
    await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Espaços fictícios','Espaços fictícios')", [t.org]);
    for (const role of ["manager", "viewer"] as const) {
      await pool.query("insert into auth.users(id,email) values($1,$2)", [t[role], `${t[role]}@example.test`]);
      await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,$3,now())", [t.org, t[role], role]);
    }
  }
});
afterAll(() => pool.end());

/** Serviço coletivo com teto em PESSOAS (o que a 0716 já entregava). */
async function servico(org: string, capacidade = 40, ...minutos: number[]): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into calendar_event_types(id,organization_id,name,slug,duration_minutes,minimum_notice_minutes,service_enabled,booking_mode,service_capacity) values($1::uuid,$2,'Reserva de espaço',$1::text,60,0,true,'collective_limited',$3)", [id, org, capacidade]);
  for (const minuto of minutos.length ? minutos : [840])
    await pool.query("insert into calendar_service_schedule(organization_id,event_type_id,weekday,timing_kind,start_minute) values($1,$2,2,'fixed',$3)", [org, id, minuto]);
  return id;
}

/** O lugar: o MESMO recurso da agenda, marcado como espaço, com capacidade em pessoas. */
async function lugar(org: string, nome: string, capacidade: number, setor = "Salão"): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into calendar_resources(id,organization_id,name,capacity,kind,sector) values($1,$2,$3,$4,'space',$5)", [id, org, nome, capacidade, setor]);
  return id;
}
async function oferecer(org: string, tipo: string, ...recursos: string[]) {
  for (const recurso of recursos)
    await pool.query("insert into calendar_service_resources(organization_id,event_type_id,resource_id,units) values($1,$2,$3,1)", [org, tipo, recurso]);
}
async function contato(org: string): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Pessoa fictícia')", [id, org]);
  return id;
}
async function reservar(org: string, tipo: string, pessoa: string, campos: Record<string, unknown> = {}) {
  const gerente = org === tenants[0].org ? tenants[0].manager : tenants[1].manager;
  const { rows } = await pool.query("select fn_calendar_service_book($1,$2,$3) r", [org, { type: "user", id: gerente },
    { event_type_id: tipo, starts_at: at, contact_id: pessoa, operation_key: randomUUID(), ...campos }]);
  return rows[0].r;
}
async function ocupacaoDoLugar(org: string, lugarId: string) {
  const { rows } = await pool.query("select count(*)::int reservas, coalesce(sum(service_party_size),0)::int pessoas from calendar_appointments where organization_id=$1 and service_space_id=$2 and status in ('pending','confirmed')", [org, lugarId]);
  return rows[0];
}

describe("reserva de lugar com capacidade por período", () => {
  it("RED de hoje: a reserva não guarda lugar nem pessoas, e um grupo de seis cabe na mesa de quatro", async () => {
    // 1) O schema de hoje não tem onde guardar o lugar nem o tamanho do grupo.
    const colunas = await pool.query(`select table_name||'.'||column_name nome from information_schema.columns
      where table_schema='public' and ((table_name='calendar_resources' and column_name in ('kind','sector'))
        or (table_name='calendar_appointments' and column_name in ('service_space_id','service_party_size'))) order by 1`);
    expect(colunas.rows.map((r) => r.nome)).toEqual([
      "calendar_appointments.service_party_size",
      "calendar_appointments.service_space_id",
      "calendar_resources.kind",
      "calendar_resources.sector",
    ]);
    // 2) E a reserva aceita um grupo de seis sem registrar quantas pessoas vêm.
    const org = tenants[0].org, tipo = await servico(org);
    const reserva = await reservar(org, tipo, await contato(org), { party_size: 6 });
    expect(reserva.service_party_size).toBe(6);
  });

  it("grava lugar e pessoas, e a mesa de quatro recusa o grupo de seis", async () => {
    const org = tenants[0].org, tipo = await servico(org, 40);
    const mesa = await lugar(org, "Mesa 1", 4);
    await oferecer(org, tipo, mesa);

    await expect(reservar(org, tipo, await contato(org), { party_size: 1 })).rejects.toMatchObject({ message: "space_required" });
    await expect(reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 5 })).rejects.toMatchObject({ message: "party_exceeds_space_capacity" });

    const reserva = await reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 2 });
    expect(reserva).toMatchObject({ service_space_id: mesa, service_party_size: 2 });
    expect(reserva.service_facts).toMatchObject({ space_id: mesa, space_name: "Mesa 1", space_capacity: 4, space_occupied: 0, party_size: 2 });
    expect(await ocupacaoDoLugar(org, mesa)).toMatchObject({ reservas: 1, pessoas: 2 });
  });

  it("acima da capacidade do lugar: recusa nomeada com o teto medido no banco", async () => {
    const org = tenants[0].org, tipo = await servico(org, 40);
    const mesa = await lugar(org, "Mesa 2", 4);
    await oferecer(org, tipo, mesa);
    await reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 4 });

    await expect(reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 1 })).rejects.toMatchObject({ message: "space_capacity_reached" });
    // O MESMO ponto que a reserva usa recusa também fora dela (prévia/consulta).
    const { rows } = await pool.query("select fn_calendar_service_check($1,$2,$3,null,null,$4,$5,$6) r", [org, tipo, at, agora, mesa, 1]);
    expect(rows[0].r).toMatchObject({ available: false, reason: "space_capacity_reached", occupied: 4, capacity_limit: 4 });
    expect(await ocupacaoDoLugar(org, mesa)).toMatchObject({ reservas: 1, pessoas: 4 });
  });

  it("duas reservas simultâneas para o último lugar: só UMA entra", async () => {
    const org = tenants[0].org, tipo = await servico(org, 40);
    const mesa = await lugar(org, "Mesa 3", 4);
    await oferecer(org, tipo, mesa);
    await reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 3 });

    const [a, b] = await Promise.allSettled([
      reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 1 }),
      reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 1 }),
    ]);
    const entradas = [a, b].filter((r) => r.status === "fulfilled");
    const recusas = [a, b].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(entradas).toHaveLength(1);
    expect(recusas).toHaveLength(1);
    expect(String(recusas[0]!.reason.message)).toBe("space_capacity_reached");
    // A prova é a linha no banco: duas reservas, quatro pessoas, teto do lugar respeitado.
    expect(await ocupacaoDoLugar(org, mesa)).toMatchObject({ reservas: 2, pessoas: 4 });
  });

  it("cancelar libera a vaga do lugar", async () => {
    const org = tenants[0].org, tipo = await servico(org, 40);
    const mesa = await lugar(org, "Mesa 4", 4);
    await oferecer(org, tipo, mesa);
    const primeira = await reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 4 });
    await expect(reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 1 })).rejects.toMatchObject({ message: "space_capacity_reached" });

    await pool.query("select fn_appointment_change($1,$2,$3,$4)", [org, primeira.id, primeira.revision, { status: "cancelled", cancellation_reason: "Desistiu" }]);
    const outra = await reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 4 });
    expect(outra).toMatchObject({ service_space_id: mesa, service_party_size: 4 });
    expect(await ocupacaoDoLugar(org, mesa)).toMatchObject({ reservas: 1, pessoas: 4 });
  });

  it("o mesmo lugar em outro período convive", async () => {
    // 840 = 14:00 local, 900 = 15:00 local: dois períodos do MESMO dia no mesmo lugar.
    const org = tenants[0].org, tipo = await servico(org, 40, 840, 900);
    const mesa = await lugar(org, "Mesa 5", 4);
    await oferecer(org, tipo, mesa);
    await reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 4 });
    const tarde = await reservar(org, tipo, await contato(org), { starts_at: depois, space_id: mesa, party_size: 4 });
    expect(tarde).toMatchObject({ service_space_id: mesa, service_party_size: 4 });
    const { rows } = await pool.query("select count(*)::int n from calendar_appointments where organization_id=$1 and service_space_id=$2 and starts_at=$3", [org, mesa, depois]);
    expect(rows[0].n).toBe(1);
  });

  it("outra organização fica intacta: lugar alheio não se reserva e a ocupação não atravessa", async () => {
    const [a, b] = tenants;
    const tipoA = await servico(a.org, 40), tipoB = await servico(b.org, 40);
    const mesaA = await lugar(a.org, "Mesa 1", 4), mesaB = await lugar(b.org, "Mesa 1", 4);
    await oferecer(a.org, tipoA, mesaA);
    await oferecer(b.org, tipoB, mesaB);

    await reservar(a.org, tipoA, await contato(a.org), { space_id: mesaA, party_size: 4 });
    await expect(reservar(a.org, tipoA, await contato(a.org), { space_id: mesaB, party_size: 1 })).rejects.toMatchObject({ message: "space_not_eligible" });
    // A org B tem a própria mesa cheia, e ela não é a mesa da org A.
    await reservar(b.org, tipoB, await contato(b.org), { space_id: mesaB, party_size: 4 });
    expect(await ocupacaoDoLugar(a.org, mesaA)).toMatchObject({ reservas: 1, pessoas: 4 });
    const { rows } = await pool.query("select count(*)::int n from calendar_appointments where organization_id=$1 and service_space_id is not null", [b.org]);
    expect(rows[0].n).toBe(1);
    // Lugar de outra organização nem entra na consulta, mesmo sabendo o id.
    const consulta = await pool.query("select fn_calendar_service_check($1,$2,$3,null,null,$4,$5,$6) r", [a.org, tipoA, at, agora, mesaB, 1]);
    expect(consulta.rows[0].r).toMatchObject({ available: false, reason: "space_not_eligible" });
  });

  it("grupo no mesmo lugar: cada participante é uma pessoa, e o grupo não entra pela metade", async () => {
    const org = tenants[0].org, tipo = await servico(org, 40);
    const quadra = await lugar(org, "Quadra 1", 2, "Área externa");
    await oferecer(org, tipo, quadra);
    const grupo = async (...pessoas: string[]) => {
      const { rows } = await pool.query("select fn_calendar_service_book_group($1,$2,$3) r", [org, { type: "user", id: tenants[0].manager },
        { event_type_id: tipo, starts_at: at, contact_id: await contato(org), operation_key: randomUUID(), space_id: quadra, party_size: 5, participants: pessoas }]);
      return rows[0].r;
    };
    const dupla = await grupo("Ana Fictícia", "Bia Fictícia");
    expect(dupla).toHaveLength(2);
    expect(dupla.every((r: { service_space_id: string; service_party_size: number }) => r.service_space_id === quadra && r.service_party_size === 1)).toBe(true);
    expect(await ocupacaoDoLugar(org, quadra)).toMatchObject({ reservas: 2, pessoas: 2 });
    // O terceiro não cabe: a chamada inteira volta atrás, sem deixar meia reserva.
    await expect(grupo("Ana Fictícia", "Bia Fictícia", "Caio Fictício")).rejects.toMatchObject({ message: "space_capacity_reached" });
    expect(await ocupacaoDoLugar(org, quadra)).toMatchObject({ reservas: 2, pessoas: 2 });
  });

  it("o lugar nasce pela configuração do serviço, e editar o nome não rebaixa o tipo", async () => {
    const org = tenants[0].org;
    const configurar = async (config: Record<string, unknown>) => {
      const { rows } = await pool.query("select fn_calendar_service_resource($1,$2,$3) r", [org, { type: "user", id: tenants[0].manager }, config]);
      return rows[0].r;
    };
    const mesa = await configurar({ name: "Camarote 7", capacity: 6, kind: "space", sector: "Mezanino" });
    expect(mesa).toMatchObject({ name: "Camarote 7", capacity: 6, kind: "space", sector: "Mezanino" });
    const renomeada = await configurar({ id: mesa.id, expected_revision: mesa.revision, name: "Camarote 7A", capacity: 6 });
    expect(renomeada).toMatchObject({ id: mesa.id, name: "Camarote 7A", kind: "space", sector: "Mezanino" });
    // Um tipo inventado não entra, e o lugar em uso não troca de tipo por baixo das reservas.
    await expect(configurar({ id: mesa.id, expected_revision: renomeada.revision, name: "Camarote 7A", capacity: 6, kind: "mesa" }))
      .rejects.toMatchObject({ message: "service_resource_invalid" });
  });

  it("papel sem permissão recebe recusa nomeada", async () => {
    const org = tenants[0].org, tipo = await servico(org, 40);
    const mesa = await lugar(org, "Camarote 1", 4);
    await oferecer(org, tipo, mesa);
    await expect(pool.query("select fn_calendar_service_book($1,$2,$3)", [org, { type: "user", id: tenants[0].viewer },
      { event_type_id: tipo, starts_at: at, contact_id: await contato(org), operation_key: randomUUID(), space_id: mesa, party_size: 2 }]))
      .rejects.toMatchObject({ code: "42501", message: "service_actor_forbidden" });
    expect(await ocupacaoDoLugar(org, mesa)).toMatchObject({ reservas: 0, pessoas: 0 });
  });

  it("a ocupação do lugar é o MÁXIMO simultâneo: reservas em pontas opostas do período não se somam", async () => {
    // Duas horas por reserva, com início de hora em hora: 14h–16h, 16h–18h e, no meio, 15h–17h.
    const org = tenants[0].org, tipo = await servico(org, 40, 840, 900, 960);
    await pool.query("update calendar_event_types set duration_minutes=120 where organization_id=$1 and id=$2", [org, tipo]);
    const mesa = await lugar(org, "Mesa 6", 4);
    await oferecer(org, tipo, mesa);
    await reservar(org, tipo, await contato(org), { space_id: mesa, party_size: 2 });
    await reservar(org, tipo, await contato(org), { starts_at: em("19:00:00Z"), space_id: mesa, party_size: 2 });

    // 15h–17h encosta nas duas, mas nunca há mais de 2 + 2 pessoas ao mesmo tempo: pela soma seriam 6.
    const meio = await reservar(org, tipo, await contato(org), { starts_at: depois, space_id: mesa, party_size: 2 });
    expect(meio.service_facts).toMatchObject({ space_occupied: 2, space_capacity: 4 });
    // Outro lado: agora 15h–16h e 16h–17h têm 4 pessoas cada, e uma a mais não cabe.
    await expect(reservar(org, tipo, await contato(org), { starts_at: depois, space_id: mesa, party_size: 1 }))
      .rejects.toMatchObject({ message: "space_capacity_reached" });
    expect(await ocupacaoDoLugar(org, mesa)).toMatchObject({ reservas: 3, pessoas: 6 });
  });

  it("a mesma chave de operação com outro lugar ou outro grupo é conflito, não a reserva antiga devolvida", async () => {
    const org = tenants[0].org, tipo = await servico(org, 40);
    const mesa = await lugar(org, "Mesa 7", 4), outra = await lugar(org, "Mesa 8", 4);
    await oferecer(org, tipo, mesa, outra);
    const pessoa = await contato(org), chave = randomUUID();
    const primeira = await reservar(org, tipo, pessoa, { operation_key: chave, space_id: mesa, party_size: 2 });

    // Repetir o MESMO pedido devolve a mesma reserva (retry legítimo).
    expect(await reservar(org, tipo, pessoa, { operation_key: chave, space_id: mesa, party_size: 2 }))
      .toMatchObject({ id: primeira.id, deduplicated: true });
    // Mudar a mesa ou o grupo com a mesma chave não pode virar "já reservado" na mesa errada.
    await expect(reservar(org, tipo, pessoa, { operation_key: chave, space_id: outra, party_size: 2 }))
      .rejects.toMatchObject({ message: "service_idempotency_conflict" });
    await expect(reservar(org, tipo, pessoa, { operation_key: chave, space_id: mesa, party_size: 3 }))
      .rejects.toMatchObject({ message: "service_idempotency_conflict" });
    expect(await ocupacaoDoLugar(org, mesa)).toMatchObject({ reservas: 1, pessoas: 2 });
  });

  it("serviço sem lugar continua reservando como antes, e o recurso exigido segue sendo exigência", async () => {
    const org = tenants[0].org, tipo = await servico(org, 2);
    const projetor = randomUUID();
    await pool.query("insert into calendar_resources(id,organization_id,name,capacity) values($1,$2,'Projetor',1)", [projetor, org]);
    await oferecer(org, tipo, projetor);
    const reserva = await reservar(org, tipo, await contato(org));
    expect(reserva).toMatchObject({ service_space_id: null, service_party_size: 1 });
    // Duas pessoas no serviço de teto 2: a capacidade do serviço conta PESSOAS, como antes contava linhas.
    const segunda = await reservar(org, tipo, await contato(org), { party_size: 1 });
    expect(segunda).toMatchObject({ service_space_id: null, service_party_size: 1 });
    await expect(reservar(org, tipo, await contato(org))).rejects.toMatchObject({ message: "capacity_reached" });
  });
});
