/**
 * O PORTEIRO DO ENVIO tem de deixar passar compromisso sem Meet — e continuar
 * barrando reunião sem link.
 *
 * ## Por que este arquivo existe, e ele nasceu de uma sabotagem
 *
 * A fatia que abriu a entrega para compromisso sem Meet mexe em TRÊS pontas: o
 * gatilho que enfileira (`fn_meet_delivery_enqueue`), a ação que autoriza
 * (`fn_meet_action`) e o porteiro do envio (`fn_meet_delivery_current`), que é
 * quem o worker consulta antes de mandar a mensagem.
 *
 * Sabotei as três, uma a uma, com a previsão escrita antes. O gatilho tem dono:
 * revertê-lo reprova dois casos de `entrega-do-compromisso-sem-meet.test.ts`.
 * **O porteiro não tinha:** revertê-lo deixou 37 casos verdes, inclusive o
 * invariante grande do Meet. Ou seja, a guarda que decide se a mensagem SAI
 * estava sem vigia — e é a última antes do cliente receber.
 *
 * ## As duas direções, e por que as duas
 *
 *   1. compromisso sem Meet, sem link nenhum → o porteiro deixa passar;
 *   2. compromisso COM Meet e sem link pronto → o porteiro barra.
 *
 * Só a primeira provaria "afrouxou"; só a segunda provaria "continua fechado".
 * Juntas provam que o afrouxamento tem a forma certa.
 *
 * ## O que ele NÃO prova
 *
 * Nada sobre o texto que chega ao cliente (isso é `tests/unit/texto-do-compromisso.test.ts`)
 * e nada sobre a tela. E não roda o worker: o que está sob teste é a DECISÃO do
 * porteiro, chamada como o worker a chama.
 *
 * Recorte do PR #803, de @paulolimajr77 — o arquivo é acréscimo da triagem.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { seedGov, GOV_AGENT_A } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());

/** Compromisso pronto para autorizar, no local e no estado de link pedidos. */
async function compromisso(local: string, meetingState: string, url: string | null) {
  const org = randomUUID();
  const id = randomUUID();
  const contact = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Porteiro','Porteiro')",
    [org],
  );
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())",
    [org, GOV_AGENT_A],
  );
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Cliente','Cliente')",
    [contact, org],
  );
  const boundary = await criarOrigemDeFollowup(pool, org, contact);
  await pool.query(
    `insert into calendar_appointments(id,organization_id,contact_id,conversation_id,owner_user_id,title,
       starts_at,ends_at,status,location_kind,meeting_state,meeting_url,meeting_request_id)
     values($1,$2,$3,$4,$5,'Compromisso',now()+interval '4 days',now()+interval '4 days 1 hour','confirmed',$6,$7,$8,gen_random_uuid())`,
    [id, org, contact, boundary.conversation_id, GOV_AGENT_A, local, meetingState, url],
  );
  return { org, id, contact, boundary };
}

/** Autoriza como `fn_meet_action` autoriza, e deixa o gatilho enfileirar. */
async function autorizarEEnfileirar(f: Awaited<ReturnType<typeof compromisso>>) {
  await pool.query(
    `update calendar_appointments set meeting_delivery = jsonb_build_object(
        'state','waiting_for_link','generation',gen_random_uuid()::text,
        'service_boundary',$2::jsonb,
        'authorized_by',jsonb_build_object('kind','user','id',$3::text))
      where id=$1`,
    [f.id, JSON.stringify(f.boundary), GOV_AGENT_A],
  );
  const { rows } = await pool.query(
    "select meeting_delivery_job_id j, meeting_delivery d from calendar_appointments where id=$1",
    [f.id],
  );
  return { job: rows[0].j as string | null, entrega: rows[0].d as Record<string, unknown> };
}

/** O que o worker faz antes de perguntar: pegar o job para si. */
async function comoOWorkerPergunta(org: string, job: string): Promise<boolean> {
  const trabalhador = `w-${randomUUID().slice(0, 8)}`;
  // ⚠️ `locked_at::text`, e NUNCA o `Date` do driver.
  //
  // O porteiro compara `j.locked_at=p_acquired_at` por igualdade exata. O
  // `timestamptz` do Postgres tem MICROssegundos; o `Date` do JavaScript tem
  // milissegundos. Devolver o valor como `Date` e mandá-lo de volta trunca os
  // microssegundos, a igualdade falha, e o porteiro diz `false` — por relógio,
  // não por regra. Medido: com o texto, `true`; com o `Date`, `false`, na MESMA
  // linha e com a mesma função. Foi assim que este arquivo nasceu vermelho três
  // vezes antes de eu olhar o instante.
  const { rows } = await pool.query(
    "update job_queue set status='running',locked_by=$3,locked_at=now() where organization_id=$1 and id=$2 returning locked_at::text",
    [org, job, trabalhador],
  );
  const { rows: r } = await pool.query(
    "select fn_meet_delivery_current($1,$2,$3,$4::timestamptz) ok",
    [org, job, trabalhador, rows[0].locked_at],
  );
  return r[0].ok as boolean;
}

it("⛔ compromisso PRESENCIAL passa pelo porteiro — sem link, e isso não é falta", async () => {
  const f = await compromisso("in_person", "not_requested", null);
  const { job, entrega } = await autorizarEEnfileirar(f);
  expect(entrega.state, "o gatilho não enfileirou — o defeito é antes do porteiro").toBe("queued");
  expect(job).toBeTruthy();
  expect(await comoOWorkerPergunta(f.org, job!)).toBe(true);
});

it("⛔ CONTROLE: com Meet e link NÃO pronto, o porteiro BARRA", async () => {
  // Sem este par, um porteiro que dissesse `true` para tudo passaria no caso
  // acima — e mandaria uma reunião sem como entrar nela, que é pior que não
  // mandar. Aqui o job é criado à mão, porque o gatilho (corretamente) não o
  // cria: o que está sob teste é a decisão do porteiro, não a do gatilho.
  const f = await compromisso("google_meet", "pending", null);
  const { entrega } = await autorizarEEnfileirar(f);
  expect(entrega.state, "o gatilho enfileirou reunião sem link").toBe("waiting_for_link");
  const job = randomUUID();
  await pool.query(
    `insert into job_queue(id,organization_id,contact_id,kind,payload,run_after)
     values($1,$2,$3,'transactional_delivery',jsonb_build_object(
       'appointment_id',$4::uuid,'meeting_request_id',(select meeting_request_id from calendar_appointments where id=$4::uuid),
       'delivery_generation',$5::text,'service_boundary',$6::jsonb),now())`,
    [job, f.org, f.contact, f.id, entrega.generation, JSON.stringify(f.boundary)],
  );
  await pool.query(
    "update calendar_appointments set meeting_delivery_job_id=$2, meeting_delivery=meeting_delivery||'{\"state\":\"queued\"}' where id=$1",
    [f.id, job],
  );
  expect(await comoOWorkerPergunta(f.org, job)).toBe(false);
});

it("⛔ CONTROLE: com Meet e link PRONTO, o porteiro deixa passar", async () => {
  // A terceira direção fecha o triângulo: o que a fatia afrouxou foi o LOCAL,
  // não a exigência. Onde há reunião com link pronto, o caminho antigo segue
  // valendo — se este caso cair, a fatia quebrou o que já funcionava.
  const f = await compromisso("google_meet", "ready", "https://meet.google.com/abc-defg-hij");
  const { job, entrega } = await autorizarEEnfileirar(f);
  expect(entrega.state).toBe("queued");
  expect(await comoOWorkerPergunta(f.org, job!)).toBe(true);
});
