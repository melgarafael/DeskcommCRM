/**
 * O ENCAIXE EM POSTGRES DE VERDADE — o que dublê nenhum alcança.
 *
 * Dois tenants pela sessão, a transação da oferta, a concorrência por uma vaga, a
 * corrida entre aceite e cancelamento, e o escritor canônico de serviços.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});
afterAll(() => pool.end());

const q = async (texto: string, valores: unknown[] = []) => (await pool.query(texto, valores)).rows;

/** Próxima terça, longe o bastante de qualquer antecedência dos tipos. */
const dia = new Date();
dia.setUTCHours(0, 0, 0, 0);
dia.setUTCDate(dia.getUTCDate() + ((2 - dia.getUTCDay() + 7) % 7 || 7) + 7);
const em = (hora: string) => `${dia.toISOString().slice(0, 10)}T${hora}:00.000Z`;

async function organizacao() {
  const org = randomUUID();
  const dono = randomUUID();
  await q("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Demonstração fictícia','Demonstração fictícia')", [org]);
  await q("insert into auth.users(id,email) values($1,$2)", [dono, `${dono}@example.test`]);
  await q("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'manager',now())", [org, dono]);
  const tipo = randomUUID();
  await q("insert into calendar_event_types(id,organization_id,name,slug,duration_minutes) values($1::uuid,$2,'Limpeza fictícia',$1::text,60)", [tipo, org]);
  return { org, dono, tipo };
}

async function contato(org: string) {
  const id = randomUUID();
  await q("insert into contacts(id,organization_id,display_name) values($1,$2,'Pessoa fictícia')", [id, org]);
  return id;
}

async function inscrever(org: string, contatoId: string, tipo: string) {
  const id = randomUUID();
  await q(
    "insert into calendar_waitlist(id,organization_id,contact_id,event_type_id,consentimento_em,consentimento_origem,observacoes) values($1,$2,$3,$4,now(),'tela','prefere manhã')",
    [id, org, contatoId, tipo],
  );
  return id;
}

const ofertar = async (
  org: string,
  espera: string,
  inicio: string,
  fim: string,
  dono: string | null,
  vagaFim: string | null = fim,
) =>
  (
    await q("select fn_lista_de_espera_ofertar($1,$2,$3,$4,'America/Sao_Paulo',$5,$6,$7) as r", [
      org, espera, inicio, fim, dono, vagaFim, em("01:00"),
    ])
  )[0].r as { ok: boolean; motivo?: string; compromisso_id?: string };

/** Roda `corpo` com a sessão de `usuario`, como o PostgREST faz. */
async function comoSessao<T>(usuario: string, corpo: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: usuario, role: "authenticated" })]);
    await c.query("set local role authenticated");
    return await corpo(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
}

let a: Awaited<ReturnType<typeof organizacao>>;
let b: Awaited<ReturnType<typeof organizacao>>;

beforeAll(async () => {
  await q("select public.fn_lista_de_espera_provisionar()");
  a = await organizacao();
  b = await organizacao();
}, 60_000);

describe("dois tenants pela sessão", () => {
  it("cada organização lê só a própria fila, e a sessão não grava nada", async () => {
    const espera = await inscrever(b.org, await contato(b.org), b.tipo);
    const propria = await inscrever(a.org, await contato(a.org), a.tipo);

    await comoSessao(a.dono, async (c) => {
      const { rows } = await c.query("select id from calendar_waitlist");
      expect(rows.map((r) => r.id)).toContain(propria);
      expect(rows.map((r) => r.id)).not.toContain(espera);
    });
    for (const dml of [
      `update calendar_waitlist set observacoes='x' where id='${propria}'`,
      `delete from calendar_waitlist where id='${propria}'`,
      `insert into calendar_waitlist(organization_id,contact_id,event_type_id,consentimento_em,consentimento_origem) values('${a.org}','${randomUUID()}','${a.tipo}',now(),'tela')`,
    ]) {
      await expect(comoSessao(a.dono, (c) => c.query(dml))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("a escrita de serviço não aponta para a organização vizinha", async () => {
    const meu = await contato(a.org);
    const vizinho = await contato(b.org);
    const inserir = (colunas: { contato?: string; tipo?: string; dono?: string | null }) =>
      q(
        "insert into calendar_waitlist(organization_id,contact_id,event_type_id,owner_user_id,consentimento_em,consentimento_origem) values($1,$2,$3,$4,now(),'tela')",
        [a.org, colunas.contato ?? meu, colunas.tipo ?? a.tipo, colunas.dono ?? null],
      );
    await expect(inserir({ contato: vizinho })).rejects.toThrow("lista_de_espera_vinculo_invalido");
    await expect(inserir({ tipo: b.tipo })).rejects.toThrow("lista_de_espera_vinculo_invalido");
    await expect(inserir({ dono: b.dono })).rejects.toThrow("lista_de_espera_vinculo_invalido");

    const espera = await inscrever(a.org, meu, a.tipo);
    await expect(q("update calendar_waitlist set organization_id=$1 where id=$2", [b.org, espera])).rejects.toThrow(
      "lista_de_espera_organizacao_imutavel",
    );
    const alheio = (
      await q(
        "insert into calendar_appointments(organization_id,owner_user_id,title,starts_at,ends_at,time_zone,status) values($1,$2,'Fictício',$3,$4,'UTC','confirmed') returning id",
        [b.org, b.dono, em("20:00"), em("21:00")],
      )
    )[0].id;
    await expect(
      q("update calendar_waitlist set oferta_appointment_id=$1 where id=$2", [alheio, espera]),
    ).rejects.toThrow("lista_de_espera_vinculo_invalido");
  });
});

describe("a oferta numa transação só", () => {
  it("segura a vaga e marca a inscrição juntos, como `pending` do sistema", async () => {
    const espera = await inscrever(a.org, await contato(a.org), a.tipo);
    const r = await ofertar(a.org, espera, em("12:00"), em("13:00"), a.dono);
    expect(r.ok).toBe(true);
    const [compromisso] = await q("select status,created_by_kind,source from calendar_appointments where id=$1", [r.compromisso_id]);
    expect(compromisso).toEqual({ status: "pending", created_by_kind: "system", source: "mcp" });
    const [linha] = await q("select status,oferta_appointment_id from calendar_waitlist where id=$1", [espera]);
    expect(linha).toEqual({ status: "offered", oferta_appointment_id: r.compromisso_id });
  });

  it("se marcar a inscrição falha, a vaga não fica presa", async () => {
    const pessoa = await contato(a.org);
    const espera = await inscrever(a.org, pessoa, a.tipo);
    // `oferta_vaga_fim` nulo reprova o CHECK de coerência no fim da função.
    await expect(ofertar(a.org, espera, em("14:00"), em("15:00"), a.dono, null)).rejects.toThrow("calendar_waitlist_oferta_coerente");
    expect(await q("select id from calendar_appointments where organization_id=$1 and contact_id=$2", [a.org, pessoa])).toEqual([]);
  });

  it("horário sobreposto do mesmo profissional é recusado, mesmo com início diferente", async () => {
    const primeira = await inscrever(a.org, await contato(a.org), a.tipo);
    const segunda = await inscrever(a.org, await contato(a.org), a.tipo);
    expect((await ofertar(a.org, primeira, em("16:00"), em("17:00"), a.dono)).ok).toBe(true);
    const r = await ofertar(a.org, segunda, em("16:30"), em("17:30"), a.dono);
    expect(r).toEqual({ ok: false, motivo: "vaga_ja_ocupada" });
    expect((await q("select status from calendar_waitlist where id=$1", [segunda]))[0].status).toBe("waiting");
  });
});

describe("concorrência real", () => {
  it("duas ofertas sobrepostas com inícios diferentes: o índice não pega, e a trava pega", async () => {
    for (const hora of ["06", "07", "08", "09", "10", "11"]) {
      const primeira = await inscrever(a.org, await contato(a.org), a.tipo);
      const segunda = await inscrever(a.org, await contato(a.org), a.tipo);
      const r = await Promise.all([
        ofertar(a.org, primeira, em(`${hora}:00`), em(`${hora}:40`), a.dono),
        ofertar(a.org, segunda, em(`${hora}:20`), em(`${hora}:59`), a.dono),
      ]);
      expect(r.filter((x) => x.ok)).toHaveLength(1);
    }
  });

  it("duas ofertas da mesma vaga: exatamente uma leva", async () => {
    const primeira = await inscrever(a.org, await contato(a.org), a.tipo);
    const segunda = await inscrever(a.org, await contato(a.org), a.tipo);
    const r = await Promise.all([
      ofertar(a.org, primeira, em("18:00"), em("19:00"), a.dono),
      ofertar(a.org, segunda, em("18:00"), em("19:00"), a.dono),
    ]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.find((x) => !x.ok)?.motivo).toBe("vaga_ja_ocupada");
    const vivos = await q(
      "select id from calendar_appointments where organization_id=$1 and starts_at=$2 and status='pending'",
      [a.org, em("18:00")],
    );
    expect(vivos).toHaveLength(1);
  });

  it("aceite x cancelamento: a revisão deixa um só vencer, e o perdedor recebe recusa", async () => {
    for (const hora of ["20", "21", "22"]) {
      const espera = await inscrever(a.org, await contato(a.org), a.tipo);
      const r = await ofertar(a.org, espera, em(`${hora}:00`), em(`${hora}:30`), a.dono, em(`${hora}:30`));
      const [{ revision }] = await q("select revision from calendar_appointments where id=$1", [r.compromisso_id]);
      const mudar = (patch: Record<string, unknown>) =>
        pool.query("select fn_appointment_change($1,$2,$3,$4)", [a.org, r.compromisso_id, revision, patch]);
      const desfechos = await Promise.allSettled([
        mudar({ status: "confirmed" }),
        mudar({ status: "cancelled", cancellation_reason: "Corrida fictícia." }),
      ]);
      expect(desfechos.filter((d) => d.status === "fulfilled")).toHaveLength(1);
      const [{ status }] = await q("select status from calendar_appointments where id=$1", [r.compromisso_id]);
      expect(status).toBe(desfechos[0].status === "fulfilled" ? "confirmed" : "cancelled");
    }
  });
});

describe("contato que saiu não recebe vaga", () => {
  it("bloqueado é recusado na transação da oferta", async () => {
    const pessoa = await contato(a.org);
    const espera = await inscrever(a.org, pessoa, a.tipo);
    await q("update contacts set is_blocked=true where id=$1", [pessoa]);
    expect(await ofertar(a.org, espera, em("23:00"), em("23:30"), a.dono)).toEqual({ ok: false, motivo: "contato_indisponivel" });
  });

  it("a anonimização apaga a observação e tira a pessoa da fila, pela seção do módulo", async () => {
    const pessoa = await contato(a.org);
    const espera = await inscrever(a.org, pessoa, a.tipo);
    await q("select public.fn_lgpd_cascade_redact_contact($1,$2,gen_random_uuid())", [a.org, pessoa]);
    const [linha] = await q("select observacoes,fora_da_fila_em from calendar_waitlist where id=$1", [espera]);
    expect(linha.observacoes).toBeNull();
    expect(linha.fora_da_fila_em).not.toBeNull();
    expect(await ofertar(a.org, espera, em("23:00"), em("23:30"), a.dono)).toEqual({ ok: false, motivo: "inscricao_mudou" });
  });
});

describe("tipo com serviço passa pelo escritor canônico", () => {
  async function servico(org: string, dono: string, aprovacao: boolean) {
    const tipo = randomUUID();
    await q(
      "insert into calendar_event_types(id,organization_id,name,slug,duration_minutes,minimum_notice_minutes,service_enabled,booking_mode,requires_confirmation) values($1::uuid,$2,'Serviço fictício',$1::text,30,0,true,'individual',$3)",
      [tipo, org, aprovacao],
    );
    await q(
      "insert into calendar_service_schedule(organization_id,event_type_id,weekday,timing_kind,start_minute) values($1,$2,$3,'fixed',840)",
      [org, tipo, dia.getUTCDay()],
    );
    await q("insert into calendar_service_professionals values($1,$2,$3)", [org, tipo, dono]);
    await q(
      "insert into attendant_availability(organization_id,user_id,is_available,schedule) values($1,$2,true,$3) on conflict do nothing",
      [org, dono, { timezone: "America/Sao_Paulo", windows: [{ dow: dia.getUTCDay(), start: "08:00", end: "18:00" }] }],
    );
    return tipo;
  }
  const inicio = () => {
    // 14:00 em São Paulo.
    return em("17:00");
  };

  it("sem aprovação da equipe: a vaga nasce `pending` e o gatilho não recusa", async () => {
    const c = await organizacao();
    const tipo = await servico(c.org, c.dono, false);
    const espera = await inscrever(c.org, await contato(c.org), tipo);
    const r = await ofertar(c.org, espera, inicio(), em("17:30"), c.dono);
    expect(r).toMatchObject({ ok: true });
    const [linha] = await q("select status,service_occurrence_id,revision from calendar_appointments where id=$1", [r.compromisso_id]);
    expect(linha.status).toBe("pending");
    expect(linha.service_occurrence_id).not.toBeNull();
    // A confirmação sem sessão vale aqui, porque o tipo não pede aprovação.
    await q("select fn_appointment_change($1,$2,$3,$4)", [c.org, r.compromisso_id, linha.revision, { status: "confirmed" }]);
  });

  it("com aprovação da equipe: a confirmação sem sessão humana continua recusada", async () => {
    const c = await organizacao();
    const tipo = await servico(c.org, c.dono, true);
    const espera = await inscrever(c.org, await contato(c.org), tipo);
    const r = await ofertar(c.org, espera, inicio(), em("17:30"), c.dono);
    expect(r).toMatchObject({ ok: true });
    const [linha] = await q("select status,revision from calendar_appointments where id=$1", [r.compromisso_id]);
    expect(linha.status).toBe("pending");
    await expect(
      q("select fn_appointment_change($1,$2,$3,$4)", [c.org, r.compromisso_id, linha.revision, { status: "confirmed" }]),
    ).rejects.toThrow("service_human_confirmation_required");
  });

  it("controle: a gravação direta que o #3465 fazia é recusada pelo gatilho", async () => {
    const c = await organizacao();
    const tipo = await servico(c.org, c.dono, false);
    await expect(
      q(
        "insert into calendar_appointments(organization_id,event_type_id,owner_user_id,title,starts_at,ends_at,time_zone,status) values($1,$2,$3,'Fictício',$4,$5,'UTC','pending')",
        [c.org, tipo, c.dono, em("17:00"), em("17:30")],
      ),
    ).rejects.toThrow("service_writer_required");
  });

  it("`segurar_pendente` não vale pela sessão: a reserva da tela segue a regra do tipo", async () => {
    const c = await organizacao();
    const tipo = await servico(c.org, c.dono, false);
    const pessoa = await contato(c.org);
    const reserva = {
      create_service_booking: {
        contact_id: pessoa, event_type_id: tipo, starts_at: em("17:00"), operation_key: randomUUID(), segurar_pendente: true,
      },
    };
    const status = await comoSessao(c.dono, async (conexao) => {
      const { rows } = await conexao.query("select fn_appointment_change($1,null,null,$2) as r", [c.org, reserva]);
      return (rows[0].r as { status: string }).status;
    });
    expect(status).toBe("confirmed");
  });
});
