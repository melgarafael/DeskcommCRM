import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { SITUACOES_QUE_OCUPAM } from "@/lib/agenda/ocupados";
import { SITUACOES_DO_AGENDAMENTO } from "@/lib/agenda/tipos";
import { evaluateConditions } from "@/lib/automation/conditions";
import { TAG_DE_CLIENTE } from "@/lib/contacts/cliente";
import { funilDeEntrada, garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { ENTIDADE_ESPERADA_POR_GATILHO } from "@/lib/schemas/webhooks";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * CLIENTE PELA AGENDA (migration 0262) — contribuição de @423313 (PR #867), com a
 * decisão do dono: a regra nasce DESLIGADA e cada organização a liga.
 *
 * Invariante de banco, e não teste de unidade, porque o que se mede aqui É o
 * banco: dois triggers, a régua de situação, o recálculo que trava o contato, a
 * RPC que confere papel/suporte/MFA pelo `auth.uid()` e classifica o histórico.
 * Um dublê de `supabase` provaria só que o dublê concorda comigo.
 *
 * Cada decisão do dono tem caso próprio, e os de permissão vêm EM PAR (o papel
 * de baixo barrado, o de cima passando):
 *
 *   I1, I13        desligada (o padrão) não toca contato
 *   I2             ligada: data + etiqueta + contact.tag_added no formato do app,
 *                  que uma condição de automação reconhece
 *   I3, I4         data só se move quando o mínimo muda; sem contato, nada
 *   I3b            horário futuro: "Cliente desde" é o dia em que se combinou,
 *                  nunca uma data que ainda não chegou
 *   I5–I9          cancelado e falta não contam — nem na inserção, nem depois
 *   I7b            apagar o horário é o mesmo que cancelá-lo
 *   I10, I10b      a etiqueta tirada à mão não volta (marcando ou religando)
 *   I10c           a etiqueta posta à mão ANTES sobrevive ao cancelamento
 *   I11, I12       LGPD e tenancy
 *   I14–I16        ligar classifica SÓ a organização que liga, sem evento;
 *                  religar recalcula; desligar não mexe em ninguém
 *   I17–I21        quem pode ligar: admin da própria organização, com MFA
 *                  comprovado e fora de suporte somente leitura
 *   I22–I26        o funil de clientes (do PR) só vale com a regra ligada
 *   I29–I31        o evento sai UMA vez por contato: cancelar e marcar de novo
 *                  não reemite, e a junção de contatos nunca emite
 *   I27, I28,      as corridas que a ordem das travas existe para impedir —
 *   I32, I33       marcação × marcação, ligação × marcação, ligação × junção
 *   I34            a etiqueta que a equipe REPÔS à mão o sistema não tira
 *   I35            horário que nasce sem contato e é vinculado depois: o
 *                  primeiro vínculo é reconhecimento, e emite
 *   I36, I37       as três colunas são do SISTEMA — sessão nenhuma as grava; o
 *                  service role e o trigger gravam
 *   I38            o quarto número do corpo: a agenda que só tem cancelamento
 *   I39            o recálculo recusa contato de outra organização — e é a
 *                  FUNÇÃO que recusa, não a constraint do agendamento
 *
 * ORGANIZAÇÕES SEPARADAS POR PAPEL NO TESTE, para que um caso não verdeie outro
 * por estado compartilhado: A ligada no beforeAll, B sempre desligada, C é o
 * ciclo liga/desliga/religa, D é o alvo das negações, E é a de MFA; F, G e H
 * são uma por corrida com a ligação.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 5,
});
const db = pgComoSupabase(pool);

const ORG_A = "c11e0000-0000-4000-8000-000000000001";
const ORG_B = "c11e0000-0000-4000-8000-000000000002";
const ORG_C = "c11e0000-0000-4000-8000-000000000003";
const ORG_D = "c11e0000-0000-4000-8000-000000000004";
const ORG_E = "c11e0000-0000-4000-8000-000000000005";
/** Só para a corrida entre ligar a regra e marcar um horário (I28). */
const ORG_F = "c11e0000-0000-4000-8000-000000000006";
/** Só para a corrida entre ligar a regra e juntar contatos (I32). */
const ORG_G = "c11e0000-0000-4000-8000-000000000007";
/** Só para a corrida entre ligar a regra e um INSERT que já travou o contato pela FK (I33). */
const ORG_H = "c11e0000-0000-4000-8000-000000000008";
/** Só para a agenda em que NADA conta — o quarto número do corpo (I38). */
const ORG_I = "c11e0000-0000-4000-8000-000000000009";

const ADMIN_A = "c11e1111-0000-4000-8000-000000000001";
const AGENT_A = "c11e1111-0000-4000-8000-000000000002";
const ADMIN_B = "c11e1111-0000-4000-8000-000000000003";
const ADMIN_C = "c11e1111-0000-4000-8000-000000000004";
const ADMIN_D = "c11e1111-0000-4000-8000-000000000005";
const MANAGER_D = "c11e1111-0000-4000-8000-000000000006";
const AGENT_D = "c11e1111-0000-4000-8000-000000000007";
const VIEWER_D = "c11e1111-0000-4000-8000-000000000008";
const ADMIN_E = "c11e1111-0000-4000-8000-000000000009";
/** Operador de plataforma que é TAMBÉM admin da D: isola a guarda de suporte da de papel. */
const SUPORTE_D = "c11e1111-0000-4000-8000-00000000000a";
const ADMIN_F = "c11e1111-0000-4000-8000-00000000000b";
const MANAGER_A = "c11e1111-0000-4000-8000-00000000000c";
const ADMIN_G = "c11e1111-0000-4000-8000-00000000000d";
const MANAGER_G = "c11e1111-0000-4000-8000-00000000000e";
const ADMIN_H = "c11e1111-0000-4000-8000-00000000000f";
/** O papel mais fraco DENTRO da A, para a guarda das três colunas (I36). */
const VIEWER_A = "c11e1111-0000-4000-8000-000000000010";
const ADMIN_I = "c11e1111-0000-4000-8000-000000000011";

const CONVERSA = "c11e0000-0000-4000-8000-00000000c001";

const RPC = "select fn_definir_cliente_pela_agenda($1, $2) as r";

interface Resultado {
  ligado: boolean;
  mudou: boolean;
  ganharam_etiqueta: number;
  perderam_etiqueta: number;
  clientes: number;
  /** Contatos que TÊM horário e nenhum que conte. Ver I38. */
  com_agendamento_que_nao_conta: number;
}

interface Opcoes {
  aal?: "aal1" | "aal2";
  sessao?: string;
  /** Sem `sub` no JWT (authenticated anônimo) ou como service_role. */
  papel?: "authenticated" | "service_role";
  semClaims?: boolean;
}

/**
 * Roda SQL COMO o usuário: `set local role` + o JWT em `request.jwt.claims`, que
 * é como o PostgREST fala com o banco. Transação própria, desfeita no erro.
 */
async function comoUsuario<T extends pg.QueryResultRow>(
  uid: string | null,
  sql: string,
  params: unknown[],
  opcoes: Opcoes = {},
): Promise<pg.QueryResult<T>> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${opcoes.papel ?? "authenticated"}`);
    if (!opcoes.semClaims) {
      const claims =
        opcoes.papel === "service_role"
          ? { role: "service_role" }
          : {
              ...(uid ? { sub: uid } : {}),
              role: "authenticated",
              aal: opcoes.aal ?? "aal1",
              ...(opcoes.sessao ? { session_id: opcoes.sessao } : {}),
            };
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    }
    const r = await c.query<T>(sql, params);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function ligar(uid: string, org: string, ligado: boolean, opcoes?: Opcoes): Promise<Resultado> {
  const r = await comoUsuario<{ r: Resultado }>(uid, RPC, [org, ligado], opcoes);
  return r.rows[0]!.r;
}

async function criarContato(org: string, nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source) values ($1, $2, 'whatsapp') returning id`,
    [org, nome],
  );
  return rows[0]!.id;
}

/**
 * INSERT direto, como postgres: o que está sob teste é o TRIGGER. Passar pela
 * rota traria disponibilidade, jornada e dono do tipo — e um vermelho ali não
 * falaria desta feature.
 */
async function marcar(
  org: string,
  contato: string | null,
  inicio: string,
  status: "pending" | "confirmed" | "cancelled" = "confirmed",
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into calendar_appointments
       (organization_id, title, starts_at, ends_at, contact_id, status, cancelled_at)
     values ($1, 'Atendimento', $2::timestamptz, $2::timestamptz + interval '1 hour', $3, $4,
             case when $4 = 'cancelled' then now() end)
     returning id`,
    [org, inicio, contato, status],
  );
  return rows[0]!.id;
}

async function cancelar(agendamento: string): Promise<void> {
  await pool.query(
    "update calendar_appointments set status = 'cancelled', cancelled_at = now() where id = $1",
    [agendamento],
  );
}

async function tirarEtiquetaAMao(contato: string): Promise<void> {
  await pool.query("update contacts set tags = array_remove(tags, $2) where id = $1", [contato, TAG_DE_CLIENTE]);
}

async function porEtiquetaAMao(contato: string): Promise<void> {
  await pool.query("update contacts set tags = array_append(tags, $2) where id = $1", [contato, TAG_DE_CLIENTE]);
}

/** De quem é a etiqueta agora: 'added', 'removed' ou null (a equipe). */
async function donoDaEtiqueta(contato: string): Promise<string | null> {
  const { rows } = await pool.query<{ d: string | null }>(
    "select client_tag_by_system as d from contacts where id = $1",
    [contato],
  );
  return rows[0]!.d;
}

/** Liga um horário que nasceu SEM contato a um contato (I35). */
async function vincular(agendamento: string, contato: string): Promise<void> {
  await pool.query("update calendar_appointments set contact_id = $2 where id = $1", [agendamento, contato]);
}

/** O que a sessão recebeu: `<código>:<mensagem>`, ou 'passou' se o banco deixou. */
async function tentarComoUsuario(uid: string, sql: string, params: unknown[]): Promise<string> {
  try {
    await comoUsuario(uid, sql, params);
    return "passou";
  } catch (e) {
    const erro = e as { code?: string; message?: string };
    return `${erro.code}:${erro.message}`;
  }
}

const JUNTAR = "select fn_mesclar_contatos($1, $2, $3::uuid[]) as r";

interface Juncao {
  repontado: Record<string, number>;
}

interface Linha {
  first_service_at: Date | null;
  tags: string[];
  updated_at: Date;
}

async function lerContato(id: string): Promise<Linha> {
  const { rows } = await pool.query<Linha>(
    "select first_service_at, tags, updated_at from contacts where id = $1",
    [id],
  );
  return rows[0]!;
}

/** O retrato comparável de todos os contatos de uma organização. */
async function retrato(org: string): Promise<unknown[]> {
  const { rows } = await pool.query(
    `select id, first_service_at, tags, updated_at from contacts
      where organization_id = $1 order by id`,
    [org],
  );
  return rows;
}

async function eventosDeEtiqueta(filtro: { contato?: string; org?: string }): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from event_log
      where event_type = 'contact.tag_added'
        and ($1::uuid is null or entity_id = $1::uuid)
        and ($2::uuid is null or organization_id = $2::uuid)`,
    [filtro.contato ?? null, filtro.org ?? null],
  );
  return rows[0]!.n;
}

async function crmDe(org: string): Promise<unknown> {
  const { rows } = await pool.query<{ crm: unknown }>(
    "select settings -> 'crm' as crm from organizations where id = $1",
    [org],
  );
  return rows[0]!.crm;
}

beforeAll(async () => {
  const usuarios = [
    ADMIN_A, AGENT_A, ADMIN_B, ADMIN_C, ADMIN_D, MANAGER_D, AGENT_D, VIEWER_D, ADMIN_E, SUPORTE_D, ADMIN_F,
    MANAGER_A, ADMIN_G, MANAGER_G, ADMIN_H, VIEWER_A, ADMIN_I,
  ];
  for (const u of usuarios) {
    await pool.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [
      u,
      `${u}@cliente-pela-agenda.test`,
    ]);
  }
  for (const [org, slug] of [
    [ORG_A, "cliente-agenda-a"],
    [ORG_B, "cliente-agenda-b"],
    [ORG_C, "cliente-agenda-c"],
    [ORG_D, "cliente-agenda-d"],
    [ORG_E, "cliente-agenda-e"],
    [ORG_F, "cliente-agenda-f"],
    [ORG_G, "cliente-agenda-g"],
    [ORG_H, "cliente-agenda-h"],
    [ORG_I, "cliente-agenda-i"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Cliente LTDA', 'Cliente') on conflict (id) do nothing`,
      [org, slug],
    );
  }
  for (const [u, org, papel] of [
    [ADMIN_A, ORG_A, "admin"],
    [AGENT_A, ORG_A, "agent"],
    [ADMIN_B, ORG_B, "admin"],
    [ADMIN_C, ORG_C, "admin"],
    [ADMIN_D, ORG_D, "admin"],
    [MANAGER_D, ORG_D, "manager"],
    [AGENT_D, ORG_D, "agent"],
    [VIEWER_D, ORG_D, "viewer"],
    [ADMIN_E, ORG_E, "admin"],
    [SUPORTE_D, ORG_D, "admin"],
    [ADMIN_F, ORG_F, "admin"],
    [MANAGER_A, ORG_A, "manager"],
    [ADMIN_G, ORG_G, "admin"],
    [MANAGER_G, ORG_G, "manager"],
    [ADMIN_H, ORG_H, "admin"],
    [VIEWER_A, ORG_A, "viewer"],
    [ADMIN_I, ORG_I, "admin"],
  ] as const) {
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role, accepted_at)
       values ($1, $2, $3, now()) on conflict do nothing`,
      [u, org, papel],
    );
  }

  // Histórico da B e da D, gravado com as duas DESLIGADAS: é o que I14 confere
  // que ninguém tocou quando a C liga.
  await marcar(ORG_B, await criarContato(ORG_B, "Histórico da B"), "2024-01-10T10:00:00Z");
  await marcar(ORG_D, await criarContato(ORG_D, "Histórico da D 1"), "2024-02-10T10:00:00Z");
  await marcar(ORG_D, await criarContato(ORG_D, "Histórico da D 2"), "2024-03-10T10:00:00Z", "pending");

  const a = await ligar(ADMIN_A, ORG_A, true);
  expect(a.ligado, "a fixture da A precisa estar ligada").toBe(true);
});

afterAll(async () => {
  await pool.end();
});

describe("desligada — o padrão de toda organização", () => {
  it("I1 · organização sem a chave: a marcação não muda data, etiqueta nem emite", async () => {
    expect(await crmDe(ORG_B), "a B nasce sem settings.crm").toBeNull();
    const contato = await criarContato(ORG_B, "Sem regra");
    const antes = await lerContato(contato);

    await marcar(ORG_B, contato, "2026-03-12T14:00:00Z");

    const depois = await lerContato(contato);
    expect(depois.first_service_at).toBeNull();
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
    expect(depois.updated_at.toISOString()).toBe(antes.updated_at.toISOString());
    expect(await eventosDeEtiqueta({ contato })).toBe(0);
  });

  it("I13 · marcação na B desligada enquanto a A está ligada: a B fica intocada", async () => {
    // A regra é por ORGANIZAÇÃO. Uma leitura da chave que olhasse "alguma
    // organização ligada" passaria no I1 (quando nenhuma estivesse) e cairia aqui.
    expect(await crmDe(ORG_A)).toEqual({ cliente_pela_agenda: true });
    const contato = await criarContato(ORG_B, "Vizinha da A");
    await marcar(ORG_B, contato, "2026-04-01T10:00:00Z");
    const depois = await lerContato(contato);
    expect(depois.first_service_at).toBeNull();
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
  });
});

describe("ligada — a transição", () => {
  it("I2 · marcação pela sessão de um agent: data, etiqueta e UM contact.tag_added que a automação vê", async () => {
    const contato = await criarContato(ORG_A, "Joana");

    await comoUsuario(
      AGENT_A,
      `insert into calendar_appointments (organization_id, title, starts_at, ends_at, contact_id)
       values ($1, 'Pela sessão', '2026-03-12T14:00:00Z', '2026-03-12T15:00:00Z', $2)`,
      [ORG_A, contato],
    );

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe("2026-03-12T14:00:00.000Z");
    expect(depois.tags.filter((t) => t === TAG_DE_CLIENTE)).toHaveLength(1);

    const { rows } = await pool.query<{
      entity_kind: string;
      payload: { added_tags: string[]; tags: string[]; service_origin?: { kind?: string } };
      metadata: Record<string, unknown>;
    }>(
      `select entity_kind, payload, metadata from event_log
        where event_type = 'contact.tag_added' and entity_id = $1`,
      [contato],
    );
    expect(rows, "exatamente um evento por virada").toHaveLength(1);
    const evento = rows[0]!;
    expect(evento.entity_kind).toBe(ENTIDADE_ESPERADA_POR_GATILHO["contact.tag_added"]);
    expect(evento.payload.added_tags).toEqual([TAG_DE_CLIENTE]);
    expect(evento.payload.tags).toContain(TAG_DE_CLIENTE);
    // Carimbada por emit_event — sem ela, a ação de enviar mensagem da regra
    // cai em `stale_origin` e nunca sai.
    expect(evento.payload.service_origin?.kind).toBe("command");
    expect(evento.metadata.caused_by_rule, "o motor pula evento causado por regra").toBeUndefined();
    expect(
      evaluateConditions([{ field: "event.added_tags", op: "contains", value: TAG_DE_CLIENTE }], {
        event: evento.payload,
      }),
      "a condição que o editor de regras monta para 'ganhou a tag cliente'",
    ).toBe(true);
  });

  it("I3 · marcação posterior não move nada nem emite; anterior move a data para trás sem emitir", async () => {
    // Datas PASSADAS de propósito: com horário passado, `least(created_at,
    // starts_at)` é o início do horário, e é ele que este caso mede.
    const contato = await criarContato(ORG_A, "Marta");
    await marcar(ORG_A, contato, "2025-03-12T14:00:00Z");
    const primeiro = await lerContato(contato);
    const eventos = await eventosDeEtiqueta({ contato });

    await marcar(ORG_A, contato, "2025-09-01T10:00:00Z");
    const segundo = await lerContato(contato);
    expect(segundo.first_service_at?.toISOString()).toBe("2025-03-12T14:00:00.000Z");
    expect(segundo.updated_at.toISOString()).toBe(primeiro.updated_at.toISOString());
    expect(segundo.tags.filter((t) => t === TAG_DE_CLIENTE)).toHaveLength(1);

    await marcar(ORG_A, contato, "2021-01-05T09:00:00Z");
    const terceiro = await lerContato(contato);
    expect(terceiro.first_service_at?.toISOString()).toBe("2021-01-05T09:00:00.000Z");
    expect(terceiro.tags.filter((t) => t === TAG_DE_CLIENTE)).toHaveLength(1);
    expect(await eventosDeEtiqueta({ contato })).toBe(eventos);
  });

  it("I3b · horário marcado para o mês que vem: 'Cliente desde' é o dia em que se combinou, não o do horário", async () => {
    // A evidência da rodada anterior mostrava "Cliente desde 21/09/2026" numa
    // ficha capturada em 15/09: `min(starts_at)` punha na ficha uma data que
    // ainda não tinha chegado. A relação começa quando se combina a hora.
    const contato = await criarContato(ORG_A, "Marcou para o futuro");
    const { rows } = await pool.query<{ criado: Date; inicio: Date }>(
      `insert into calendar_appointments (organization_id, title, starts_at, ends_at, contact_id)
       values ($1, 'Futuro', now() + interval '30 days', now() + interval '30 days 1 hour', $2)
       returning created_at as criado, starts_at as inicio`,
      [ORG_A, contato],
    );
    const { criado, inicio } = rows[0]!;
    expect(inicio.getTime(), "controle: o horário é mesmo futuro").toBeGreaterThan(Date.now());

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe(criado.toISOString());
    expect(depois.first_service_at!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(depois.tags).toContain(TAG_DE_CLIENTE);
  });

  it("I4 · agendamento sem contato não toca contato nenhum", async () => {
    const contato = await criarContato(ORG_A, "Ninguém");
    await marcar(ORG_A, null, "2026-05-01T12:00:00Z");
    expect((await lerContato(contato)).first_service_at).toBeNull();
  });
});

describe("cancelado e falta não contam", () => {
  it("I5 · a régua SQL é o espelho de LIBERAM_O_HORARIO para todo status do vocabulário", async () => {
    for (const s of SITUACOES_DO_AGENDAMENTO) {
      const { rows } = await pool.query<{ conta: boolean }>(
        "select fn_situacao_conta_como_atendimento($1) as conta",
        [s],
      );
      expect(rows[0]!.conta, `status ${s}`).toBe(SITUACOES_QUE_OCUPAM.includes(s));
    }
  });

  it("I6 · agendamento que já nasce cancelado não faz cliente", async () => {
    const contato = await criarContato(ORG_A, "Desistiu antes");
    await marcar(ORG_A, contato, "2026-06-01T10:00:00Z", "cancelled");
    const depois = await lerContato(contato);
    expect(depois.first_service_at).toBeNull();
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
  });

  it("I7 · cancelar o único horário devolve a data a null e tira a etiqueta, sem evento novo", async () => {
    const contato = await criarContato(ORG_A, "Cancelou");
    const ag = await marcar(ORG_A, contato, "2026-06-02T10:00:00Z");
    expect((await lerContato(contato)).tags).toContain(TAG_DE_CLIENTE);
    const eventos = await eventosDeEtiqueta({ contato });

    await cancelar(ag);

    const depois = await lerContato(contato);
    expect(depois.first_service_at).toBeNull();
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
    expect(await eventosDeEtiqueta({ contato })).toBe(eventos);
  });

  it("I8 · marcar FALTA no único horário (passado, por quem atende) tem o mesmo efeito", async () => {
    const contato = await criarContato(ORG_A, "Faltou");
    const ag = await marcar(ORG_A, contato, "2025-01-10T10:00:00Z");
    expect((await lerContato(contato)).first_service_at).not.toBeNull();

    // `no_show` só se registra por um humano com papel (fn_appointment_stamp).
    await comoUsuario(AGENT_A, "update calendar_appointments set status = 'no_show' where id = $1", [ag]);

    const depois = await lerContato(contato);
    expect(depois.first_service_at).toBeNull();
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
  });

  it("I9 · dois horários: cancelar o primeiro move a data para o segundo e mantém a etiqueta", async () => {
    const contato = await criarContato(ORG_A, "Remarcou");
    const primeiro = await marcar(ORG_A, contato, "2026-07-01T10:00:00Z");
    await marcar(ORG_A, contato, "2026-08-01T10:00:00Z");

    await cancelar(primeiro);

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(depois.tags.filter((t) => t === TAG_DE_CLIENTE)).toHaveLength(1);
  });

  it("I7b · apagar horário pela sessão de um agent: o anterior move a data, o último tira a etiqueta, sem evento", async () => {
    // A policy `calendar_appointments_write` deixa um agent apagar. Sem o
    // trigger de DELETE o contato ficava cliente de um horário que não existe.
    const contato = await criarContato(ORG_A, "Apagaram os horários");
    const primeiro = await marcar(ORG_A, contato, "2025-04-01T10:00:00Z");
    const segundo = await marcar(ORG_A, contato, "2025-05-01T10:00:00Z");
    const eventos = await eventosDeEtiqueta({ contato });
    expect(eventos, "controle: a primeira marcação emitiu").toBe(1);

    const apagar = (id: string) =>
      comoUsuario(AGENT_A, "delete from calendar_appointments where id = $1 and organization_id = $2", [id, ORG_A]);

    expect((await apagar(primeiro)).rowCount, "a policy deixa o agent apagar").toBe(1);
    const meio = await lerContato(contato);
    expect(meio.first_service_at?.toISOString()).toBe("2025-05-01T10:00:00.000Z");
    expect(meio.tags).toContain(TAG_DE_CLIENTE);

    expect((await apagar(segundo)).rowCount).toBe(1);
    const depois = await lerContato(contato);
    expect(depois.first_service_at).toBeNull();
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
    expect(await eventosDeEtiqueta({ contato })).toBe(eventos);
  });
});

describe("a etiqueta tirada à mão é respeitada", () => {
  it("I10 · marcação nova (inclusive ANTERIOR, que muda a data) não devolve a etiqueta nem emite", async () => {
    const contato = await criarContato(ORG_A, "Não quer etiqueta");
    await marcar(ORG_A, contato, "2026-03-12T14:00:00Z");
    await pool.query("update contacts set tags = array_remove(tags, $2) where id = $1", [
      contato,
      TAG_DE_CLIENTE,
    ]);
    const eventos = await eventosDeEtiqueta({ contato });

    await marcar(ORG_A, contato, "2026-05-12T14:00:00Z"); // posterior: nada muda
    // Anterior: a data MUDA — é o caso que passa pela escrita, e o que uma
    // régua de "repor se faltar" pegaria.
    await marcar(ORG_A, contato, "2025-12-01T14:00:00Z");

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe("2025-12-01T14:00:00.000Z");
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
    expect(await eventosDeEtiqueta({ contato })).toBe(eventos);
  });

  it("I10c · etiqueta posta à mão ANTES de marcar: sobrevive ao cancelamento, e não emite", async () => {
    // Medido na versão anterior: {cliente,vip} postos pela equipe viravam {vip}
    // quando o único horário era cancelado. O sistema apagava o que nunca pôs.
    const contato = await criarContato(ORG_A, "Cliente de antes da regra");
    await pool.query("update contacts set tags = array['cliente','vip'] where id = $1", [contato]);

    const ag = await marcar(ORG_A, contato, "2025-10-01T10:00:00Z");
    const marcado = await lerContato(contato);
    expect(marcado.first_service_at?.toISOString()).toBe("2025-10-01T10:00:00.000Z");
    expect(marcado.tags).toEqual(["cliente", "vip"]);

    await cancelar(ag);

    const depois = await lerContato(contato);
    expect(depois.first_service_at).toBeNull();
    expect(depois.tags).toEqual(["cliente", "vip"]);
    expect(await eventosDeEtiqueta({ contato })).toBe(0);
  });
  it("I34 · a etiqueta que a equipe REPÔS à mão: o sistema não a tira no cancelamento seguinte", async () => {
    // A JANELA QUE A LEITURA PREGUIÇOSA DO DONO DEIXAVA ABERTA. Medido, antes da
    // guarda: o sistema põe (`added`), a equipe tira, a equipe REPÕE — e como
    // nenhuma data mudou, `fn_recalcular_cliente_do_contato` não rodava e o dono
    // continuava `added`. O cancelamento seguinte então tirava a etiqueta da
    // EQUIPE, sem evento e sem auditoria — exatamente o que o cabeçalho da
    // migration diz que não acontece, sem nenhuma condição.
    const contato = await criarContato(ORG_A, "Repôs à mão");
    const horario = await marcar(ORG_A, contato, "2026-06-01T10:00:00Z");
    expect((await lerContato(contato)).tags).toContain(TAG_DE_CLIENTE);
    expect(await donoDaEtiqueta(contato)).toBe("added");

    await tirarEtiquetaAMao(contato);
    expect(await donoDaEtiqueta(contato), "tirar à mão passa a etiqueta para a equipe NA HORA").toBeNull();
    await porEtiquetaAMao(contato);
    expect(await donoDaEtiqueta(contato), "repor à mão também é da equipe").toBeNull();

    await cancelar(horario);

    const depois = await lerContato(contato);
    expect(depois.first_service_at, "a data é do sistema, e ela volta a null").toBeNull();
    expect(depois.tags, "a etiqueta é da equipe: o sistema não a tira").toContain(TAG_DE_CLIENTE);
  });

  it("I34b · controle: sem a equipe no meio, o sistema TIRA a etiqueta que é dele", async () => {
    // O par do I34. Sem ele, um dono que virasse null em toda escrita deixaria
    // o I34 verde e quebraria a feature: ninguém perderia a etiqueta nunca.
    const contato = await criarContato(ORG_A, "Só o sistema");
    const horario = await marcar(ORG_A, contato, "2026-06-02T10:00:00Z");
    expect(await donoDaEtiqueta(contato)).toBe("added");
    await cancelar(horario);
    const depois = await lerContato(contato);
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
    expect(await donoDaEtiqueta(contato)).toBe("removed");
  });
});

describe("o evento sai UMA vez por contato", () => {
  it("I29 · pedido pendente que expira e é refeito: a etiqueta volta, e o evento continua sendo um", async () => {
    // O ciclo do pedido que ninguém confirma: vence, vira `cancelled`, e a
    // pessoa pede de novo. A versão anterior emitia duas vezes — duas
    // boas-vindas para a mesma pessoa.
    const contato = await criarContato(ORG_A, "Pediu duas vezes");
    const pedido = await marcar(ORG_A, contato, "2025-06-10T10:00:00Z", "pending");
    expect((await lerContato(contato)).tags).toContain(TAG_DE_CLIENTE);
    expect(await eventosDeEtiqueta({ contato }), "controle: a primeira virada emite").toBe(1);

    await pool.query(
      `update calendar_appointments
          set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Pedido expirado'
        where id = $1`,
      [pedido],
    );
    const expirado = await lerContato(contato);
    expect(expirado.first_service_at).toBeNull();
    expect(expirado.tags, "a etiqueta que o sistema pôs sai").not.toContain(TAG_DE_CLIENTE);

    await marcar(ORG_A, contato, "2025-06-20T10:00:00Z", "pending");

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe("2025-06-20T10:00:00.000Z");
    expect(depois.tags, "voltou a ser cliente: a etiqueta volta").toContain(TAG_DE_CLIENTE);
    expect(await eventosDeEtiqueta({ contato }), "cancelar e marcar de novo = 1 evento no total").toBe(1);
  });

  it("I30 · a equipe tirou a etiqueta; o horário foi cancelado e refeito: a etiqueta não volta, e nada emite", async () => {
    const contato = await criarContato(ORG_A, "Não quer etiqueta nunca");
    const pedido = await marcar(ORG_A, contato, "2025-07-10T10:00:00Z", "pending");
    expect(await eventosDeEtiqueta({ contato })).toBe(1);
    await tirarEtiquetaAMao(contato);

    await cancelar(pedido);
    await marcar(ORG_A, contato, "2025-07-20T10:00:00Z");

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe("2025-07-20T10:00:00.000Z");
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
    expect(await eventosDeEtiqueta({ contato })).toBe(1);
  });

  it("I31 · juntar a duplicata nova com a cliente de 2023: a vencedora vira cliente, e ninguém ganha evento", async () => {
    // Medido na versão anterior: `fn_mesclar_contatos` reponta o horário por
    // UPDATE de contact_id, o trigger via a vencedora "virar cliente" e emitia —
    // uma cliente de 2023 recebia a automação de boas-vindas.
    const antiga = await criarContato(ORG_A, "Lúcia de 2023");
    await marcar(ORG_A, antiga, "2023-05-01T10:00:00Z");
    expect((await lerContato(antiga)).tags).toContain(TAG_DE_CLIENTE);
    const nova = await criarContato(ORG_A, "Lúcia duplicada");
    const eventosDaOrg = await eventosDeEtiqueta({ org: ORG_A });

    const { rows } = await comoUsuario<{ r: Juncao }>(MANAGER_A, JUNTAR, [ORG_A, nova, [antiga]]);

    expect(rows[0]!.r.repontado["calendar_appointments.contact_id"], "controle: o horário foi repontado").toBe(1);
    const vencedora = await lerContato(nova);
    expect(vencedora.first_service_at?.toISOString()).toBe("2023-05-01T10:00:00.000Z");
    expect(vencedora.tags.filter((t) => t === TAG_DE_CLIENTE)).toHaveLength(1);
    expect(await eventosDeEtiqueta({ contato: nova })).toBe(0);
    expect(await eventosDeEtiqueta({ org: ORG_A })).toBe(eventosDaOrg);
  });
  it("I35 · horário que nasce SEM contato e é vinculado depois: o primeiro vínculo emite", async () => {
    // O PRIMEIRO VÍNCULO NÃO É REPONTAMENTO. A condição do ramo de UPDATE é
    // `old.contact_id is distinct from new.contact_id`, e ela tem dois membros:
    // X → Y (a junção do I31, que não deve emitir) e null → Y, que é a primeira
    // vez que este contato tem horário. Medido antes: o contato virava cliente,
    // ganhava a etiqueta, ficava com `client_recognized_at` carimbado — e
    // NENHUM `contact.tag_added` saía, nem ali nem nunca mais, porque o carimbo
    // não volta a null. A automação de boas-vindas nunca veria essa pessoa.
    const contato = await criarContato(ORG_A, "Vinculado depois");
    const horario = await marcar(ORG_A, null, "2026-06-05T10:00:00Z");
    expect(await eventosDeEtiqueta({ contato })).toBe(0);
    expect((await lerContato(contato)).first_service_at, "sem contato, nada acontece").toBeNull();

    await vincular(horario, contato);

    const depois = await lerContato(contato);
    expect(depois.first_service_at).not.toBeNull();
    expect(depois.tags).toContain(TAG_DE_CLIENTE);
    expect(await eventosDeEtiqueta({ contato }), "o primeiro vínculo emite").toBe(1);

    // E continua sendo UM: o carimbo já está lá.
    await cancelar(horario);
    await marcar(ORG_A, contato, "2026-06-06T10:00:00Z");
    expect(await eventosDeEtiqueta({ contato })).toBe(1);
  });
});

describe("LGPD e tenancy", () => {
  it("I11 · contato anonimizado não é re-etiquetado nem emite, e a data sobrevive", async () => {
    const contato = await criarContato(ORG_A, "Apagada");
    await marcar(ORG_A, contato, "2026-03-12T14:00:00Z");
    await pool.query(
      "update contacts set is_anonymized = true, anonymized_at = now(), tags = '{}'::text[] where id = $1",
      [contato],
    );
    const eventos = await eventosDeEtiqueta({ contato });

    await marcar(ORG_A, contato, "2020-07-01T09:00:00Z");

    const depois = await lerContato(contato);
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
    expect(depois.first_service_at?.toISOString()).toBe("2026-03-12T14:00:00.000Z");
    expect(await eventosDeEtiqueta({ contato })).toBe(eventos);
  });

  it("I12 · agendamento da A com contato da B não toca o contato da B", async () => {
    const naOutra = await criarContato(ORG_B, "Alheia");
    // O banco já recusa (`appointment_contact_scope`); o teste aceita as duas
    // formas de estar protegido e reprova só se o contato for marcado.
    await marcar(ORG_A, naOutra, "2026-06-01T12:00:00Z").catch(() => undefined);
    const depois = await lerContato(naOutra);
    expect(depois.first_service_at).toBeNull();
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
  });

  it("I39 · o RECÁLCULO recusa contato de outra organização — e não é a constraint que o faz", async () => {
    // A SABOTAGEM QUE PASSOU VERDE. Tirar `c.organization_id = p_org` do SELECT
    // e do UPDATE de `fn_recalcular_cliente_do_contato` deixava os 44 casos
    // verdes, medido. O I12 acima é verde pela CONSTRAINT
    // `appointment_contact_scope`, que barra o agendamento cruzado ANTES de o
    // trigger rodar, e o laço do backfill filtra a organização por conta
    // própria — então o filtro DA FUNÇÃO, que é a última linha e a que o
    // próximo chamador herda, não era medido por ninguém. Proteção estrutural
    // creditada à disciplina: os dois existem, e só um estava sob gate.
    const daB = await criarContato(ORG_B, "Contato da B, alvo da A");
    const antes = await lerContato(daB);

    const { rows } = await pool.query<{ r: string }>(
      "select fn_recalcular_cliente_do_contato($1, $2, true) as r",
      [ORG_A, daB],
    );

    expect(rows[0]!.r, "a A pedindo o recálculo de um contato da B").toBe("ignorado");
    const depois = await lerContato(daB);
    expect(depois.first_service_at).toBeNull();
    expect(depois.updated_at.toISOString(), "nem `updated_at` se move").toBe(
      antes.updated_at.toISOString(),
    );

    // CONTROLE POSITIVO: com a organização CERTA, a MESMA chamada trabalha. Sem
    // ele, uma função que devolvesse 'ignorado' sempre passaria aqui.
    await marcar(ORG_B, daB, "2026-09-01T10:00:00Z");
    expect((await lerContato(daB)).first_service_at, "a B está desligada: o trigger não faz nada").toBeNull();
    const certo = await pool.query<{ r: string }>(
      "select fn_recalcular_cliente_do_contato($1, $2, false) as r",
      [ORG_B, daB],
    );
    expect(certo.rows[0]!.r).toBe("etiquetado");
    expect((await lerContato(daB)).tags).toContain(TAG_DE_CLIENTE);
  });
});

describe("ligar classifica o histórico SÓ da organização que liga", () => {
  /** Os contatos da C, criados no I14 e reusados no I15/I16. */
  const c: Record<string, string> = {};

  it("I14 · a C liga: 3 com horário que conta ganham; cancelado e sem horário ficam; B e D intocadas; zero evento", async () => {
    c.confirmado = await criarContato(ORG_C, "C confirmado");
    c.pendente = await criarContato(ORG_C, "C pendente");
    c.dois = await criarContato(ORG_C, "C dois horários");
    c.soCancelado = await criarContato(ORG_C, "C só cancelado");
    c.semHorario = await criarContato(ORG_C, "C sem horário");
    await marcar(ORG_C, c.confirmado, "2023-05-01T10:00:00Z");
    await marcar(ORG_C, c.pendente, "2023-06-01T10:00:00Z", "pending");
    await marcar(ORG_C, c.dois, "2023-07-01T10:00:00Z", "cancelled");
    await marcar(ORG_C, c.dois, "2023-08-01T10:00:00Z");
    await marcar(ORG_C, c.soCancelado, "2023-09-01T10:00:00Z", "cancelled");

    const bAntes = await retrato(ORG_B);
    const dAntes = await retrato(ORG_D);
    const eventosC = await eventosDeEtiqueta({ org: ORG_C });

    const r = await ligar(ADMIN_C, ORG_C, true);

    expect(r).toEqual({
      ligado: true,
      mudou: true,
      ganharam_etiqueta: 3,
      perderam_etiqueta: 0,
      clientes: 3,
      // `c.soCancelado` tem horário e nenhum que conte; `c.semHorario` não tem
      // horário nenhum. Os dois ficam sem etiqueta, e só o primeiro entra aqui —
      // é essa diferença que a tela precisa para não dizer "ninguém tinha
      // horário marcado" a quem só teve cancelamento.
      com_agendamento_que_nao_conta: 1,
    });
    expect(await crmDe(ORG_C)).toEqual({ cliente_pela_agenda: true });
    for (const [id, data] of [
      [c.confirmado, "2023-05-01T10:00:00.000Z"],
      [c.pendente, "2023-06-01T10:00:00.000Z"],
      [c.dois, "2023-08-01T10:00:00.000Z"],
    ] as const) {
      const linha = await lerContato(id);
      expect(linha.first_service_at?.toISOString()).toBe(data);
      expect(linha.tags.filter((t) => t === TAG_DE_CLIENTE)).toHaveLength(1);
    }
    for (const id of [c.soCancelado, c.semHorario]) {
      const linha = await lerContato(id);
      expect(linha.first_service_at).toBeNull();
      expect(linha.tags).not.toContain(TAG_DE_CLIENTE);
    }
    expect(await retrato(ORG_B), "a B não liga nada").toEqual(bAntes);
    expect(await retrato(ORG_D), "a D não liga nada").toEqual(dAntes);
    // ZERO evento do histórico: 3 aqui seriam 630 no estúdio do autor, e uma
    // regra "ganhou tag → enviar WhatsApp" dispararia para todos.
    expect(await eventosDeEtiqueta({ org: ORG_C })).toBe(eventosC);
  });

  it("I15 · ligar de novo: mudou=false, ninguém ganha, nenhum updated_at se move", async () => {
    const antes = await retrato(ORG_C);
    const r = await ligar(ADMIN_C, ORG_C, true);
    expect(r).toMatchObject({ ligado: true, mudou: false, ganharam_etiqueta: 0, perderam_etiqueta: 0 });
    expect(await retrato(ORG_C)).toEqual(antes);
  });

  it("I16 · desligar não muda contato; o que acontece desligada não aplica; religar recalcula", async () => {
    const antes = await retrato(ORG_C);
    const desligou = await ligar(ADMIN_C, ORG_C, false);
    expect(desligou).toMatchObject({ ligado: false, mudou: true, ganharam_etiqueta: 0, perderam_etiqueta: 0 });
    expect(await crmDe(ORG_C)).toEqual({ cliente_pela_agenda: false });
    expect(await retrato(ORG_C), "desligar não toca contato").toEqual(antes);

    // Desligada: o único horário do c.confirmado é cancelado, e alguém novo marca.
    const { rows } = await pool.query<{ id: string }>(
      "select id from calendar_appointments where contact_id = $1",
      [c.confirmado],
    );
    for (const { id } of rows) await cancelar(id);
    const novo = await criarContato(ORG_C, "C marcou desligada");
    await marcar(ORG_C, novo, "2026-01-15T10:00:00Z");

    const confirmadoDesligada = await lerContato(c.confirmado!);
    expect(confirmadoDesligada.first_service_at?.toISOString(), "desligada, a data fica congelada").toBe(
      "2023-05-01T10:00:00.000Z",
    );
    expect(confirmadoDesligada.tags).toContain(TAG_DE_CLIENTE);
    expect((await lerContato(novo)).first_service_at).toBeNull();

    const religou = await ligar(ADMIN_C, ORG_C, true);
    expect(religou).toMatchObject({ ligado: true, mudou: true, ganharam_etiqueta: 1, perderam_etiqueta: 1 });

    const perdeu = await lerContato(c.confirmado!);
    expect(perdeu.first_service_at).toBeNull();
    expect(perdeu.tags).not.toContain(TAG_DE_CLIENTE);
    const ganhou = await lerContato(novo);
    expect(ganhou.first_service_at?.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    expect(ganhou.tags).toContain(TAG_DE_CLIENTE);
  });

  it("I38 · agenda que só tem cancelamento: os três números zerados, e o QUARTO em 1", async () => {
    // O CORPO QUE A TELA PRECISA DISTINGUIR. Medido antes deste número: uma
    // organização cujo único contato TEM horário marcado, todos cancelados,
    // devolvia `{ganharam: 0, perderam: 0, clientes: 0}` — três números
    // idênticos aos de uma agenda VAZIA — e a tela dizia "Nenhum contato tinha
    // horário marcado ainda" sobre uma organização que tem horário marcado.
    // Numa clínica com cancelamentos é a primeira frase depois de ligar.
    const contato = await criarContato(ORG_I, "Só cancelou");
    await marcar(ORG_I, contato, "2026-08-01T10:00:00Z", "cancelled");

    const r = await ligar(ADMIN_I, ORG_I, true);

    expect(r).toEqual({
      ligado: true,
      mudou: true,
      ganharam_etiqueta: 0,
      perderam_etiqueta: 0,
      clientes: 0,
      com_agendamento_que_nao_conta: 1,
    });
    // E o contato continua intocado: o quarto número CONTA, não classifica.
    const linha = await lerContato(contato);
    expect(linha.first_service_at).toBeNull();
    expect(linha.tags).not.toContain(TAG_DE_CLIENTE);

    // CONTROLE: marcar um horário que CONTA tira este contato da conta e o põe
    // na de clientes. Sem o par, um número fixo em 1 passaria.
    await marcar(ORG_I, contato, "2026-08-02T10:00:00Z");
    const religou = await ligar(ADMIN_I, ORG_I, false);
    expect(religou.com_agendamento_que_nao_conta, "desligar não recalcula, mas conta o AGORA").toBe(0);
  });

  it("I10b · na C: etiquetada, tirada à mão, desligada e religada — a etiqueta não volta", async () => {
    const contato = await criarContato(ORG_C, "C tirou a etiqueta");
    await marcar(ORG_C, contato, "2026-02-01T10:00:00Z");
    expect((await lerContato(contato)).tags).toContain(TAG_DE_CLIENTE);
    await pool.query("update contacts set tags = array_remove(tags, $2) where id = $1", [
      contato,
      TAG_DE_CLIENTE,
    ]);

    await ligar(ADMIN_C, ORG_C, false);
    await ligar(ADMIN_C, ORG_C, true);

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe("2026-02-01T10:00:00.000Z");
    expect(depois.tags).not.toContain(TAG_DE_CLIENTE);
  });
});

describe("quem pode ligar", () => {
  it("I17 · manager, agent e viewer da D: 42501, settings.crm ausente e contatos iguais", async () => {
    const antes = await retrato(ORG_D);
    for (const quem of [MANAGER_D, AGENT_D, VIEWER_D]) {
      await expect(ligar(quem, ORG_D, true), `papel ${quem}`).rejects.toMatchObject({ code: "42501" });
    }
    expect(await crmDe(ORG_D)).toBeNull();
    expect(await retrato(ORG_D)).toEqual(antes);
  });

  // Do I18 ao I21 a régua é ANTES × DEPOIS, e não "a chave está ausente": se
  // uma guarda falhar, o vermelho fica no caso que a derrubou, em vez de se
  // espalhar pelos seguintes como "a D já estava ligada".
  it("I18 · admin de OUTRA organização (B) chamando para a D: 42501 e nada muda", async () => {
    const antes = { crm: await crmDe(ORG_D), contatos: await retrato(ORG_D) };
    await expect(ligar(ADMIN_B, ORG_D, true)).rejects.toMatchObject({ code: "42501" });
    expect({ crm: await crmDe(ORG_D), contatos: await retrato(ORG_D) }).toEqual(antes);
  });

  it("I19 · sem sessão: authenticated sem sub e service_role — 42501", async () => {
    const antes = await crmDe(ORG_D);
    await expect(
      comoUsuario(null, RPC, [ORG_D, true], { semClaims: true }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(comoUsuario(null, RPC, [ORG_D, true])).rejects.toMatchObject({ code: "42501" });
    await expect(
      comoUsuario(null, RPC, [ORG_D, true], { papel: "service_role" }),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await crmDe(ORG_D)).toEqual(antes);
  });

  it("I20 · admin com fator TOTP verificado: aal1 recusa pela MFA, aal2 liga", async () => {
    const fator = randomUUID();
    await pool.query(
      "insert into auth.mfa_factors (id, user_id, status, factor_type) values ($1, $2, 'verified', 'totp')",
      [fator, ADMIN_E],
    );
    try {
      await expect(ligar(ADMIN_E, ORG_E, true, { aal: "aal1" })).rejects.toMatchObject({
        code: "42501",
        message: "cliente_pela_agenda_mfa_required",
      });
      expect(await crmDe(ORG_E)).toBeNull();
      const r = await ligar(ADMIN_E, ORG_E, true, { aal: "aal2" });
      expect(r).toMatchObject({ ligado: true, mudou: true });
    } finally {
      await pool.query("delete from auth.mfa_factors where id = $1", [fator]);
    }
  });

  it("I21 · suporte na D: somente leitura recusa, e sessão vencida recusa mesmo sendo admin da D", async () => {
    const sessao = randomUUID();
    const suporte = randomUUID();
    await pool.query("insert into auth.sessions (id, user_id, aal) values ($1, $2, 'aal1')", [
      sessao,
      SUPORTE_D,
    ]);
    await pool.query(
      `insert into platform_admins (user_id, granted_by, scope, mfa_required, reason)
       values ($1, $1, 'full', false, 'Invariante cliente pela agenda')`,
      [SUPORTE_D],
    );
    await pool.query(
      `insert into platform_support_sessions
         (id, organization_id, actor_user_id, auth_session_id, access_mode, expires_at)
       values ($1, $2, $3, $4, 'support_readonly', now() + interval '30 minutes')`,
      [suporte, ORG_D, SUPORTE_D, sessao],
    );
    const antes = { crm: await crmDe(ORG_D), contatos: await retrato(ORG_D) };
    try {
      await expect(ligar(SUPORTE_D, ORG_D, true, { sessao })).rejects.toMatchObject({ code: "42501" });

      // Vencida: `fn_user_role_in_org` volta a ler a filiação (admin da D), e
      // quem barra é `fn_support_write_allowed` — a guarda que só este caso isola.
      await pool.query(
        "update platform_support_sessions set access_mode = 'full', expires_at = now() - interval '1 second' where id = $1",
        [suporte],
      );
      await expect(ligar(SUPORTE_D, ORG_D, true, { sessao })).rejects.toMatchObject({ code: "42501" });

      expect({ crm: await crmDe(ORG_D), contatos: await retrato(ORG_D) }).toEqual(antes);
    } finally {
      await pool.query("delete from platform_support_sessions where id = $1", [suporte]);
      await pool.query("delete from platform_admins where user_id = $1", [SUPORTE_D]);
      await pool.query("delete from auth.sessions where id = $1", [sessao]);
    }
  });

  it("I21b · controle do par: o admin da D, sem suporte, liga", async () => {
    const r = await ligar(ADMIN_D, ORG_D, true);
    expect(r).toMatchObject({ ligado: true, mudou: true, ganharam_etiqueta: 2 });
  });
});

describe("as três colunas são do sistema", () => {
  // O valor forjado é DIFERENTE do que está lá em todas as três: a guarda só
  // dispara quando a coluna MUDA, e reescrever o mesmo valor deixaria o caso
  // verde sem medir nada. O contato deste caso tem a etiqueta do sistema
  // (`added`), então o forjado é `removed` — é a escrita que faria o sistema
  // devolver a etiqueta na próxima marcação.
  const TRES = [
    ["first_service_at", "update contacts set first_service_at = $2::timestamptz where id = $1", "2019-01-01T00:00:00Z"],
    ["client_recognized_at", "update contacts set client_recognized_at = $2::timestamptz where id = $1", "2019-01-01T00:00:00Z"],
    ["client_tag_by_system", "update contacts set client_tag_by_system = $2 where id = $1", "removed"],
  ] as const;

  it("I36 · viewer, agent e admin da PRÓPRIA organização: 42501 nas três, e o valor não muda", async () => {
    // A CLASSE É PRÉ-EXISTENTE (um viewer já reescreve `tags` e `name`), e esta
    // entrega ACRESCENTA a ela a coluna que decide roteamento e o carimbo de
    // uma-vez-só. Medido antes da guarda, no mesmo banco: `set local role
    // authenticated` com o JWT de um viewer da PRÓPRIA organização gravava
    // `first_service_at = '2019-01-01'` e devolvia `UPDATE 1` — "Cliente desde
    // 2019" forjado, o lead nascendo no funil de clientes e `contact.tag_added`
    // silenciado para sempre naquele contato.
    //
    // `authenticated` tem UPDATE nestas colunas (default ACL de tabela do
    // Supabase, reproduzido no prelude) e a policy de `contacts` é cega a papel:
    // quem recusa é o BEFORE UPDATE, e é por isso que o admin também é recusado.
    const contato = await criarContato(ORG_A, "Não me forje a data");
    await marcar(ORG_A, contato, "2026-07-01T10:00:00Z");
    const antes = await lerContato(contato);
    const dono = await donoDaEtiqueta(contato);
    expect(dono, "a fixture precisa ter a etiqueta do SISTEMA").toBe("added");

    for (const [coluna, sql, forjado] of TRES) {
      for (const [quem, uid] of [
        ["viewer", VIEWER_A],
        ["agent", AGENT_A],
        ["admin", ADMIN_A],
      ] as const) {
        const r = await tentarComoUsuario(uid, sql, [contato, forjado]);
        expect(r, `${quem} gravou ${coluna}`).toBe("42501:colunas_de_cliente_sao_do_sistema");
      }
    }

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe(antes.first_service_at?.toISOString());
    expect(await donoDaEtiqueta(contato)).toBe(dono);

    // CONTROLE POSITIVO, na mesma sessão e na mesma linha: o que é da equipe
    // continua da equipe. Sem ele, um `revoke` largo demais em `contacts`
    // deixaria este caso verde quebrando a tela de Contatos inteira.
    expect(
      await tentarComoUsuario(VIEWER_A, "update contacts set display_name = $2 where id = $1", [
        contato,
        "renomeado pelo viewer",
      ]),
    ).toBe("passou");
    expect((await lerContato(contato)).tags, "e a etiqueta segue lá").toContain(TAG_DE_CLIENTE);
  });

  it("I37 · o trigger e o service role continuam gravando as três", async () => {
    // O par do I36, e a sabotagem que ele existe para pegar: uma guarda que
    // recusasse TODA escrita (sem o anúncio `deskcomm.cliente_pela_agenda`)
    // deixaria o I36 verde e impediria qualquer um de marcar horário — porque a
    // escrita do sistema também passa pelo trigger, com o `auth.uid()` da
    // sessão que marcou.
    const contato = await criarContato(ORG_A, "O sistema grava");
    const r = await tentarComoUsuario(
      AGENT_A,
      `insert into calendar_appointments (organization_id, title, starts_at, ends_at, contact_id, status)
       values ($1, 'Pela sessão', $2::timestamptz, $2::timestamptz + interval '1 hour', $3, 'confirmed')`,
      [ORG_A, "2026-07-05T10:00:00Z", contato],
    );
    expect(r, "marcar horário pela SESSÃO não pode esbarrar na guarda").toBe("passou");
    const linha = await lerContato(contato);
    expect(linha.first_service_at, "e o trigger gravou a coluna").not.toBeNull();
    expect(await donoDaEtiqueta(contato)).toBe("added");

    // E o admin client (service role, auth.uid() nulo) — o caminho da
    // anonimização de LGPD e dos importadores — passa.
    await pool.query("update contacts set client_recognized_at = now() where id = $1", [contato]);
  });
});

describe("o funil de clientes", () => {
  it("I22 · a marca é exclusiva por organização, e independente entre organizações", async () => {
    const marcarFunil = (org: string, slug: string) =>
      pool.query(
        `insert into crm_pipelines (organization_id, name, slug, position, is_client_pipeline)
         values ($1, 'Clientes', $2, 9000, true)`,
        [org, slug],
      );

    await marcarFunil(ORG_A, "clientes-a");
    await expect(marcarFunil(ORG_A, "clientes-a2")).rejects.toMatchObject({ code: "23505" });
    await expect(marcarFunil(ORG_B, "clientes-b")).resolves.toBeDefined();
  });

  it("I23 · A ligada: o lead de quem já é cliente nasce no funil de clientes", async () => {
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
    await marcar(ORG_A, contato, "2024-02-02T10:00:00Z");

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

  it("I24 · B desligada: contato COM data congelada e funil de clientes marcado nasce no padrão", async () => {
    // O funil de clientes da B existe (I22) e ganha etapa utilizável aqui, para
    // que a ÚNICA razão de não usá-lo seja a regra desligada.
    const { rows } = await pool.query<{ id: string }>(
      "select id from crm_pipelines where organization_id = $1 and is_client_pipeline",
      [ORG_B],
    );
    const funilDeClientes = rows[0]!.id;
    await pool.query(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position)
       values ($1, $2, 'Voltou', 'voltou-b', 1000)`,
      [ORG_B, funilDeClientes],
    );
    const contato = await criarContato(ORG_B, "Congelada");
    await pool.query("update contacts set first_service_at = '2022-01-01T10:00:00Z' where id = $1", [contato]);

    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_B,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Congelada",
    });

    expect(r.criado, `esperava criar, veio ${JSON.stringify(r)}`).toBe(true);
    if (!r.criado) return;
    const padrao = await funilDeEntrada(db, ORG_B);
    if ("erro" in padrao) throw new Error(`a B precisa de funil padrão: ${padrao.erro}`);
    expect(r.pipelineId).toBe(padrao.pipelineId);
    expect(r.pipelineId).not.toBe(funilDeClientes);
  });

  it("I25 · quem NÃO é cliente continua no funil de entrada, mesmo havendo funil de clientes", async () => {
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

  it("I26 · funil de clientes SEM etapa utilizável cai no padrão — o lead nasce de qualquer jeito", async () => {
    const semEtapaAberta = randomUUID();
    await pool.query("update crm_pipelines set is_client_pipeline = false where organization_id = $1", [ORG_A]);
    await pool.query(
      `insert into crm_pipelines (id, organization_id, name, slug, position, is_client_pipeline)
       values ($1, $2, 'Clientes sem etapa', 'clientes-sem-etapa', 9100, true)`,
      [semEtapaAberta, ORG_A],
    );
    await pool.query(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won)
       values ($1, $2, 'Ganho', 'ganho-clientes-a', 1000, true)`,
      [ORG_A, semEtapaAberta],
    );

    const destino = await funilDeEntrada(db, ORG_A, true);
    expect("erro" in destino, `esperava destino, veio ${JSON.stringify(destino)}`).toBe(false);
    if ("erro" in destino) return;
    expect(destino.pipelineId).not.toBe(semEtapaAberta);
  });
});

/**
 * AS CORRIDAS. Cada uma com duas conexões de verdade: a primeira segura a
 * transação aberta, a segunda é disparada e fica esperando a trava, e só então
 * a primeira commita. As asserções são sobre o DESFECHO (a data, a etiqueta),
 * não sobre a trava: se a trava sumir, o desfecho errado é o que fica vermelho.
 */
describe("as corridas", () => {
  /** Espera a conexão `pid` ficar bloqueada por `dono`, ou a promessa terminar. */
  async function esperarBloqueio(pid: number, dono: number, terminou: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !terminou(); i++) {
      const { rows } = await pool.query<{ bloqueada: boolean }>(
        "select $2::int = any(pg_blocking_pids($1::int)) as bloqueada",
        [pid, dono],
      );
      if (rows[0]!.bloqueada) return;
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  it("I27 · dois horários do mesmo contato mudando ao mesmo tempo: fica a data MAIS CEDO, não a do último a gravar", async () => {
    // Por que o recálculo trava o contato ANTES de ler a agenda: a segunda
    // transação, se lesse o min() antes da trava, não enxergaria o horário que a
    // primeira adiantou e ainda não commitou — e gravaria o dela por cima.
    //
    // ⚠️ UPDATE, E NÃO DOIS INSERTS. Medido: com dois INSERTs a segunda
    // transação já espera a primeira ANTES de chegar ao trigger (espera o
    // `transactionid` da primeira no próprio INSERT), então quando o recálculo
    // roda a primeira já commitou e a ordem das leituras não importa — a
    // sabotagem "lê o min() antes da trava" passou verde nessa versão. Mover o
    // horário por UPDATE não passa por aquela espera, e a ordem volta a decidir.
    //
    // Datas PASSADAS: com horário futuro a data do contato é o `created_at` dos
    // dois, e mover `starts_at` não mudaria nada — a corrida sumiria do desfecho.
    const contato = await criarContato(ORG_A, "Corrida de remarcação");
    const cedo = await marcar(ORG_A, contato, "2025-01-01T15:00:00Z");
    const tarde = await marcar(ORG_A, contato, "2025-01-01T16:00:00Z");
    expect((await lerContato(contato)).first_service_at?.toISOString()).toBe("2025-01-01T15:00:00.000Z");

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      // A primeira ADIANTA o horário das 16h para as 9h (e passa a travar o contato).
      await a.query(
        "update calendar_appointments set starts_at = '2025-01-01T09:00:00Z', ends_at = '2025-01-01T10:00:00Z' where id = $1",
        [tarde],
      );
      const pidA = (await a.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const pidB = (await b.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

      await b.query("begin");
      let terminou = false;
      // A segunda ATRASA o das 15h para as 17h.
      const segunda = b
        .query(
          "update calendar_appointments set starts_at = '2025-01-01T17:00:00Z', ends_at = '2025-01-01T18:00:00Z' where id = $1",
          [cedo],
        )
        .finally(() => {
          terminou = true;
        });
      await esperarBloqueio(pidB, pidA, () => terminou);

      await a.query("commit");
      await segunda;
      await b.query("commit");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe("2025-01-01T09:00:00.000Z");
    expect(depois.tags.filter((t) => t === TAG_DE_CLIENTE)).toHaveLength(1);
  });

  it("I28 · ligar a regra enquanto um horário está sendo marcado: o contato não fica de fora", async () => {
    // Por que o trigger e a ligação se serializam: sem isso o horário em voo lê
    // a chave ainda desligada, e a classificação do histórico — que roda antes
    // de ele commitar — não o enxerga. O contato ficaria sem etiqueta até alguém
    // desligar e religar, sem erro nenhum.
    const contato = await criarContato(ORG_F, "Marcou enquanto ligavam");
    const a = await pool.connect();
    const b = await pool.connect();
    let resultado: Resultado | null = null;
    try {
      await a.query("begin");
      await a.query(
        `insert into calendar_appointments (organization_id, title, starts_at, ends_at, contact_id)
         values ($1, 'Em voo', '2025-11-01T09:00:00Z', '2025-11-01T10:00:00Z', $2)`,
        [ORG_F, contato],
      );
      const pidA = (await a.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const pidB = (await b.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

      await b.query("begin");
      await b.query("set local role authenticated");
      await b.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: ADMIN_F, role: "authenticated", aal: "aal1" }),
      ]);
      let terminou = false;
      const ligacao = b.query<{ r: Resultado }>(RPC, [ORG_F, true]).finally(() => {
        terminou = true;
      });
      await esperarBloqueio(pidB, pidA, () => terminou);

      await a.query("commit");
      resultado = (await ligacao).rows[0]!.r;
      await b.query("commit");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }

    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe("2025-11-01T09:00:00.000Z");
    expect(depois.tags).toContain(TAG_DE_CLIENTE);
    expect(resultado).toMatchObject({ ligado: true, mudou: true, ganharam_etiqueta: 1 });
  });

  /** Uma conexão como o usuário, com a transação ABERTA — quem chama commita. */
  async function sessaoAberta(uid: string): Promise<{ conexao: pg.PoolClient; pid: number }> {
    const conexao = await pool.connect();
    await conexao.query("begin");
    await conexao.query("set local role authenticated");
    await conexao.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal: "aal1" }),
    ]);
    const pid = (await conexao.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    return { conexao, pid };
  }

  const TRAVA_DA_ORGANIZACAO = "select pg_advisory_xact_lock(hashtextextended($1::text, 262))";

  /**
   * A consulta que fica esperando, com o desfecho CAPTURADO na hora. Sem isto um
   * `deadlock detected` na conexão que espera vira "unhandled rejection" do
   * arquivo, e o vermelho não aparece no caso que o causou.
   */
  function emVoo<T>(consulta: Promise<T>): { desfecho: () => Promise<T>; terminou: () => boolean } {
    let fim = false;
    const capturado = consulta.then(
      (valor) => ({ ok: true as const, valor }),
      (erro: unknown) => ({ ok: false as const, erro }),
    );
    capturado.finally(() => {
      fim = true;
    });
    return {
      // Função, e não promessa pronta: o erro só é relançado quando o caso o
      // aguarda — uma promessa rejeitada à espera também seria "unhandled".
      desfecho: async () => {
        const d = await capturado;
        if (!d.ok) throw d.erro;
        return d.valor;
      },
      terminou: () => fim,
    };
  }

  it("I32 · ligar a regra enquanto uma junção de contatos está em voo: as duas terminam, e a vencedora vira cliente", async () => {
    // Medido na versão anterior, com duas sessões: a junção travava os contatos
    // e só então o trigger do repontamento pedia a trava da organização; a
    // ligação, com a trava da organização, pedia o contato. `deadlock detected`,
    // e a rota de junção devolvia 500. A ligação pega a trava da organização
    // ANTES (como a própria RPC faz na 1ª instrução) para a junção chegar com
    // ela tomada.
    const antiga = await criarContato(ORG_G, "G antiga");
    await marcar(ORG_G, antiga, "2023-03-01T10:00:00Z");
    const nova = await criarContato(ORG_G, "G duplicada");

    const r = await sessaoAberta(ADMIN_G);
    const m = await sessaoAberta(MANAGER_G);
    let resultado: Resultado | null = null;
    let juncao: Juncao | null = null;
    try {
      await r.conexao.query(TRAVA_DA_ORGANIZACAO, [ORG_G]);
      const juntando = emVoo(m.conexao.query<{ r: Juncao }>(JUNTAR, [ORG_G, nova, [antiga]]));
      await esperarBloqueio(m.pid, r.pid, juntando.terminou);

      resultado = (await r.conexao.query<{ r: Resultado }>(RPC, [ORG_G, true])).rows[0]!.r;
      await r.conexao.query("commit");
      juncao = (await juntando.desfecho()).rows[0]!.r;
      await m.conexao.query("commit");
    } finally {
      for (const s of [r, m]) {
        await s.conexao.query("rollback").catch(() => undefined);
        s.conexao.release();
      }
    }

    expect(resultado).toMatchObject({ ligado: true, mudou: true, ganharam_etiqueta: 1 });
    expect(juncao?.repontado["calendar_appointments.contact_id"]).toBe(1);
    const vencedora = await lerContato(nova);
    expect(vencedora.first_service_at?.toISOString()).toBe("2023-03-01T10:00:00.000Z");
    expect(vencedora.tags).toContain(TAG_DE_CLIENTE);
    expect(await eventosDeEtiqueta({ org: ORG_G })).toBe(0);
  });

  it("I33 · ligar a regra enquanto um horário novo espera por ela: a ligação alcança o contato que a FK já travou", async () => {
    // Medido com `for update` no recálculo: o INSERT do horário trava o contato
    // em `key share` (a FK) ANTES do trigger, e o trigger espera a trava da
    // organização; a ligação, com ela tomada, pedia o contato em `for update` —
    // que conflita com `key share`. `deadlock detected` num horário comum. Com
    // `for no key update`, as duas travas de linha convivem.
    const contato = await criarContato(ORG_H, "H já tinha horário");
    await marcar(ORG_H, contato, "2024-01-10T10:00:00Z");

    const r = await sessaoAberta(ADMIN_H);
    const i = await pool.connect();
    let resultado: Resultado | null = null;
    try {
      await r.conexao.query(TRAVA_DA_ORGANIZACAO, [ORG_H]);
      await i.query("begin");
      const pidI = (await i.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const inserindo = emVoo(
        i.query(
          `insert into calendar_appointments (organization_id, title, starts_at, ends_at, contact_id)
           values ($1, 'Segundo horário', '2024-06-10T10:00:00Z', '2024-06-10T11:00:00Z', $2)`,
          [ORG_H, contato],
        ),
      );
      await esperarBloqueio(pidI, r.pid, inserindo.terminou);

      resultado = (await r.conexao.query<{ r: Resultado }>(RPC, [ORG_H, true])).rows[0]!.r;
      await r.conexao.query("commit");
      await inserindo.desfecho();
      await i.query("commit");
    } finally {
      await r.conexao.query("rollback").catch(() => undefined);
      r.conexao.release();
      await i.query("rollback").catch(() => undefined);
      i.release();
    }

    expect(resultado).toMatchObject({ ligado: true, mudou: true, ganharam_etiqueta: 1 });
    const depois = await lerContato(contato);
    expect(depois.first_service_at?.toISOString()).toBe("2024-01-10T10:00:00.000Z");
    expect(depois.tags).toContain(TAG_DE_CLIENTE);
    // Já era cliente quando a regra ligou: o horário em voo não é virada.
    expect(await eventosDeEtiqueta({ contato })).toBe(0);
  });
});
