/**
 * QUEM CONFIGURA O AVISO DE AGENDAMENTO, E QUEM LÊ O QUE — migration 0753.
 *
 * O mesmo desenho e os mesmos três eixos de `aviso-de-caso-escrita.test.ts`,
 * pela mesma razão: as duas tabelas ficam fora de `rls-isolation.test.ts` (a
 * policy da configuração exige `admin` e a do histórico `manager`), e entram
 * em `PROVA_PROPRIA` da varredura de completude citando ESTE arquivo.
 *
 *   · TENANT — a organização A não lê a linha da B;
 *   · PAPEL  — `agent` e `viewer` não leem a configuração; `viewer` não lê o
 *     histórico;
 *   · ESCRITA — `authenticated` não escreve em nenhuma das duas. A única porta
 *     é `fn_definir_aviso_de_agendamento`.
 *
 * E o que é próprio deste aviso: "usar o número do aviso de caso" só é aceito
 * quando o aviso de caso existe, e com número próprio valem as mesmas recusas
 * do aviso de caso (conexão do vizinho, número da própria organização, número
 * que já é cliente).
 *
 * Sabotagens previstas: `grant insert ... to authenticated` deixa vermelhos só
 * os casos de escrita; trocar `'admin'` por `'agent'` na policy da
 * configuração deixa vermelho só o caso do `agent`; tirar a checagem de
 * `config_aviso_de_caso` da RPC deixa vermelho só o caso "sem aviso de caso".
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG_A = "07070000-0000-4000-8000-000000000001";
const ORG_B = "07070000-0000-4000-8000-000000000002";
/** Organização SEM aviso de caso: mede a recusa de "usar o número do caso". */
const ORG_C = "07070000-0000-4000-8000-000000000003";
const ADMIN_A = "07070000-1111-4000-8000-000000000001";
const GESTOR_A = "07070000-1111-4000-8000-000000000002";
const ATENDENTE_A = "07070000-1111-4000-8000-000000000003";
const LEITOR_A = "07070000-1111-4000-8000-000000000004";
const ADMIN_B = "07070000-1111-4000-8000-000000000005";
const ADMIN_C = "07070000-1111-4000-8000-000000000006";
const SESSAO_A = "07070000-2222-4000-8000-000000000001";
const SESSAO_B = "07070000-2222-4000-8000-000000000002";
const SESSAO_DESCARTAVEL = "07070000-2222-4000-8000-000000000003";
const CONTATO_A = "07070000-3333-4000-8000-000000000001";

function comoMembro(userId: string): string {
  return `set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
}

function contaComoMembro(userId: string, consulta: string): number {
  const saida = sql(`${comoMembro(userId)}\n${consulta};`).trim();
  const ultima = saida.split("\n").at(-1) ?? "";
  if (!/^\d+$/.test(ultima)) throw new Error(`saída inesperada do psql: ${saida}`);
  return Number(ultima);
}

function valor(consulta: string): string {
  return (sql(consulta).trim().split("\n").at(-1) ?? "").trim();
}

/** `t`/`true` e `f`/`false` — o psql devolve as duas formas conforme o tipo. */
function booleano(consulta: string): boolean {
  const cru = valor(consulta);
  if (cru === "t" || cru === "true") return true;
  if (cru === "f" || cru === "false") return false;
  throw new Error(`INSTRUMENTO: o psql não devolveu um booleano: ${JSON.stringify(cru)}`);
}

function erroDe(comando: string): string {
  try {
    sql(comando);
    return "";
  } catch (e) {
    return motivoDoErro(e);
  }
}

const definir = (org: string, usa: boolean, canal: string | null, tel: string | null, confirma = false) =>
  `select public.fn_definir_aviso_de_agendamento('${org}', ${usa}, ${canal ? `'${canal}'` : "null"}, ${
    tel ? `'${tel}'` : "null"
  }, true, ${confirma});`;

const CONFIGS = "select count(*) from public.config_aviso_de_agendamento";
const ENTREGAS = "select count(*) from public.entregas_de_aviso_de_agendamento";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}',     'aviso-0707-admin-a@invariant.test'),
      ('${GESTOR_A}',    'aviso-0707-gestor-a@invariant.test'),
      ('${ATENDENTE_A}', 'aviso-0707-agent-a@invariant.test'),
      ('${LEITOR_A}',    'aviso-0707-viewer-a@invariant.test'),
      ('${ADMIN_B}',     'aviso-0707-admin-b@invariant.test'),
      ('${ADMIN_C}',     'aviso-0707-admin-c@invariant.test')
      on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'aviso-0707-a', 'Aviso 0707 A', 'Aviso 0707 A'),
      ('${ORG_B}', 'aviso-0707-b', 'Aviso 0707 B', 'Aviso 0707 B'),
      ('${ORG_C}', 'aviso-0707-c', 'Aviso 0707 C', 'Aviso 0707 C')
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}',     '${ORG_A}', 'admin',   now()),
      ('${GESTOR_A}',    '${ORG_A}', 'manager', now()),
      ('${ATENDENTE_A}', '${ORG_A}', 'agent',   now()),
      ('${LEITOR_A}',    '${ORG_A}', 'viewer',  now()),
      ('${ADMIN_B}',     '${ORG_B}', 'admin',   now()),
      ('${ADMIN_C}',     '${ORG_C}', 'admin',   now())
      on conflict do nothing;

    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'aviso-0707-a', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_B}', '${ORG_B}', 'aviso-0707-b', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_A}', '${ORG_A}', 'Aviso 0707 Contato') on conflict do nothing;

    -- O aviso de caso de A e de B existe: é a referência do padrão.
    insert into public.config_aviso_de_caso (organization_id, channel_session_id, telefone_destino, ligado)
      values ('${ORG_A}', '${SESSAO_A}', '+5531998966398', true),
             ('${ORG_B}', '${SESSAO_B}', '+5511988887777', true)
      on conflict (organization_id) do nothing;

    -- Uma configuração e uma entrega em CADA organização: sem a do vizinho,
    -- "o vizinho lê zero" seria satisfeito por tabela vazia.
    insert into public.config_aviso_de_agendamento (organization_id, usa_numero_do_aviso_de_caso, ligado)
      values ('${ORG_A}', true, true), ('${ORG_B}', true, true)
      on conflict (organization_id) do nothing;
    insert into public.entregas_de_aviso_de_agendamento (organization_id, tipo, dia, destino, status)
      values ('${ORG_A}', 'resumo', '2026-10-21', '+5531998966398', 'enviado'),
             ('${ORG_B}', 'resumo', '2026-10-21', '+5511988887777', 'enviado')
      on conflict do nothing;
  `);
});

describe("0707 — a configuração é lida por quem administra", () => {
  it("CONTROLE POSITIVO: o admin lê a própria configuração", () => {
    expect(contaComoMembro(ADMIN_A, CONFIGS)).toBe(1);
  });

  it("o admin do vizinho lê a dele e nunca a de A", () => {
    expect(contaComoMembro(ADMIN_B, CONFIGS)).toBe(1);
    expect(contaComoMembro(ADMIN_B, `${CONFIGS} where organization_id = '${ORG_A}'`)).toBe(0);
  });

  it("`agent` e `viewer` da mesma organização não leem a configuração", () => {
    expect(contaComoMembro(ATENDENTE_A, CONFIGS)).toBe(0);
    expect(contaComoMembro(LEITOR_A, CONFIGS)).toBe(0);
  });
});

describe("0707 — o histórico é lido por quem opera", () => {
  it("CONTROLE POSITIVO: o gestor lê o histórico da própria organização", () => {
    expect(contaComoMembro(GESTOR_A, ENTREGAS)).toBe(1);
  });

  it("o vizinho não lê o histórico de A; `viewer` não lê nada", () => {
    expect(contaComoMembro(ADMIN_B, `${ENTREGAS} where organization_id = '${ORG_A}'`)).toBe(0);
    expect(contaComoMembro(LEITOR_A, ENTREGAS)).toBe(0);
  });
});

describe("0707 — `authenticated` não escreve em nenhuma das duas", () => {
  const escritas: Array<[string, string]> = [
    [
      "insert na configuração",
      `insert into public.config_aviso_de_agendamento (organization_id, usa_numero_do_aviso_de_caso) values ('${ORG_C}', true)`,
    ],
    ["update na configuração", `update public.config_aviso_de_agendamento set ligado = false where organization_id = '${ORG_A}'`],
    ["delete na configuração", `delete from public.config_aviso_de_agendamento where organization_id = '${ORG_A}'`],
    [
      "insert na entrega",
      `insert into public.entregas_de_aviso_de_agendamento (organization_id, tipo, dia, destino) values ('${ORG_A}', 'resumo', '2026-10-22', '+5531900000000')`,
    ],
    ["update na entrega", `update public.entregas_de_aviso_de_agendamento set status = 'falhou' where organization_id = '${ORG_A}'`],
    ["delete na entrega", `delete from public.entregas_de_aviso_de_agendamento where organization_id = '${ORG_A}'`],
  ];
  for (const [nome, comando] of escritas) {
    it(`${nome} é recusado até para o admin`, () => {
      const erro = erroDe(`${comoMembro(ADMIN_A)}\n${comando};`);
      expect(erro, `${nome} passou — a tabela ganhou uma porta de escrita`).not.toBe("");
      expect(erro).toMatch(/permission denied|row-level security|violates/i);
    });
  }
});

describe("0707 — fn_definir_aviso_de_agendamento é a única porta", () => {
  it("`agent` e `viewer` são recusados", () => {
    expect(erroDe(`${comoMembro(ATENDENTE_A)}\n${definir(ORG_A, true, null, null)}`)).toMatch(
      /aviso_de_agendamento_forbidden|permission denied/i,
    );
    expect(erroDe(`${comoMembro(LEITOR_A)}\n${definir(ORG_A, true, null, null)}`)).toMatch(
      /aviso_de_agendamento_forbidden|permission denied/i,
    );
  });

  it("CONTROLE POSITIVO: o admin usa o número do aviso de caso", () => {
    expect(sql(`${comoMembro(ADMIN_A)}\n${definir(ORG_A, true, null, null)}`)).toContain("trocou_numero");
  });

  it("o admin de OUTRA organização é recusado", () => {
    expect(erroDe(`${comoMembro(ADMIN_B)}\n${definir(ORG_A, true, null, null)}`)).toMatch(/aviso_de_agendamento_forbidden/i);
  });

  it("sem aviso de caso, \"usar o número do aviso de caso\" é recusado", () => {
    expect(erroDe(`${comoMembro(ADMIN_C)}\n${definir(ORG_C, true, null, null)}`)).toMatch(
      /aviso_de_agendamento_sem_aviso_de_caso/i,
    );
  });

  it("número próprio com a conexão do VIZINHO é recusado", () => {
    expect(erroDe(`${comoMembro(ADMIN_A)}\n${definir(ORG_A, false, SESSAO_B, "+5531977774444")}`)).toMatch(
      /aviso_de_agendamento_canal_invalido/i,
    );
  });

  it("número de uma conexão da PRÓPRIA organização é recusado", () => {
    sql(`update public.channel_sessions set phone_number = '+5531955554444' where id = '${SESSAO_A}';`);
    const erro = erroDe(`${comoMembro(ADMIN_A)}\n${definir(ORG_A, false, SESSAO_A, "+5531955554444")}`);
    sql(`update public.channel_sessions set phone_number = null where id = '${SESSAO_A}';`);
    expect(erro).toMatch(/aviso_de_agendamento_numero_da_propria_org/i);
  });

  it("número que JÁ É CLIENTE exige confirmação, nas duas grafias do nono dígito", () => {
    sql(`update public.contacts set phone_number = '+553193333222' where id = '${CONTATO_A}';`);
    const erro = erroDe(`${comoMembro(ADMIN_A)}\n${definir(ORG_A, false, SESSAO_A, "+5531993333222")}`);
    const comConfirmacao = sql(`${comoMembro(ADMIN_A)}\n${definir(ORG_A, false, SESSAO_A, "+5531993333222", true)}`);
    sql(`update public.contacts set phone_number = null where id = '${CONTATO_A}';`);
    expect(erro).toMatch(/aviso_de_agendamento_numero_de_cliente/i);
    expect(comConfirmacao).toContain("trocou_numero");
    expect(
      valor(`select telefone_destino from public.config_aviso_de_agendamento where organization_id = '${ORG_A}'`),
    ).toBe("+5531993333222");
  });

  it("anon não tem EXECUTE nas duas funções; o expurgo também é fechado a authenticated", () => {
    expect(
      booleano(
        `select has_function_privilege('anon', 'public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean,text)', 'EXECUTE')::text`,
      ),
    ).toBe(false);
    for (const papel of ["anon", "authenticated"]) {
      expect(
        booleano(
          `select has_function_privilege('${papel}', 'public.fn_expurgar_avisos_de_agendamento_vencidos(int,int)', 'EXECUTE')::text`,
        ),
      ).toBe(false);
    }
  });
});

describe("9060 — o grupo é destino extra, com entrega própria", () => {
  const GRUPO = "120363000000000001@g.us";
  const EVENTO = "07670000-4444-4000-8000-000000000001";
  const definirComGrupo = (grupo: string | null) =>
    `select public.fn_definir_aviso_de_agendamento('${ORG_A}', true, null, null, true, false, ${
      grupo === null ? "null" : `'${grupo}'`
    });`;
  const entregaDoEvento = (alvo: string) =>
    `insert into public.entregas_de_aviso_de_agendamento (organization_id, tipo, event_id, evento, alvo, destino, status)
       values ('${ORG_A}', 'aviso', '${EVENTO}', 'appointment.created', '${alvo}', '${alvo === "grupo" ? GRUPO : "+5531998966398"}', 'pendente');`;
  const resumoDoDia = (alvo: string) =>
    `insert into public.entregas_de_aviso_de_agendamento (organization_id, tipo, dia, alvo, destino, status)
       values ('${ORG_A}', 'resumo', '2026-10-25', '${alvo}', '${alvo === "grupo" ? GRUPO : "+5531998966398"}', 'pendente');`;

  it("CONTROLE POSITIVO: o admin salva um grupo, e `null` o tira", () => {
    sql(`${comoMembro(ADMIN_A)}\n${definirComGrupo(GRUPO)}`);
    expect(valor(`select grupo_destino from public.config_aviso_de_agendamento where organization_id = '${ORG_A}'`)).toBe(GRUPO);
    sql(`${comoMembro(ADMIN_A)}\n${definirComGrupo(null)}`);
    expect(valor(`select coalesce(grupo_destino, 'nenhum') from public.config_aviso_de_agendamento where organization_id = '${ORG_A}'`)).toBe(
      "nenhum",
    );
  });

  it("grupo que não é um chatId de grupo é recusado pela RPC e pelo CHECK", () => {
    expect(erroDe(`${comoMembro(ADMIN_A)}\n${definirComGrupo("+5531998966398")}`)).toMatch(/aviso_de_agendamento_grupo_invalido/i);
    expect(
      erroDe(`update public.config_aviso_de_agendamento set grupo_destino = '5531998966398@c.us' where organization_id = '${ORG_A}';`),
    ).toMatch(/config_aviso_de_agendamento_grupo_check/i);
  });

  it("a assinatura antiga de seis argumentos não existe mais", () => {
    expect(
      valor(
        `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'fn_definir_aviso_de_agendamento'`,
      ),
    ).toBe("1");
  });

  it("o mesmo evento tem uma entrega para o número e uma para o grupo, e nenhuma segunda", () => {
    expect(erroDe(entregaDoEvento("numero"))).toBe("");
    expect(erroDe(entregaDoEvento("grupo"))).toBe("");
    expect(erroDe(entregaDoEvento("numero"))).toMatch(/duplicate key|unique/i);
    expect(erroDe(entregaDoEvento("grupo"))).toMatch(/duplicate key|unique/i);
    expect(erroDe(entregaDoEvento("todos"))).toMatch(/entregas_de_aviso_de_agendamento_alvo_check/i);
  });

  it("o resumo do dia sai uma vez para o número e uma para o grupo", () => {
    expect(erroDe(resumoDoDia("numero"))).toBe("");
    expect(erroDe(resumoDoDia("grupo"))).toBe("");
    expect(erroDe(resumoDoDia("grupo"))).toMatch(/duplicate key|unique/i);
  });

  it("o histórico do grupo segue a mesma RLS: o vizinho não lê", () => {
    expect(contaComoMembro(ADMIN_B, `${ENTREGAS} where organization_id = '${ORG_A}' and alvo = 'grupo'`)).toBe(0);
    expect(contaComoMembro(GESTOR_A, `${ENTREGAS} where alvo = 'grupo'`)).toBe(2);
  });
});

describe("0707 — apagar a conexão apontada não pode falhar", () => {
  it("o DELETE passa, e o aviso com número próprio fica desligado sozinho", () => {
    sql(`
      do $seed$ begin
        insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
          values ('${SESSAO_DESCARTAVEL}', '${ORG_A}', 'aviso-0707-descartavel', '\\x00'::bytea);
      exception when unique_violation then null; end $seed$;
      update public.config_aviso_de_agendamento
         set usa_numero_do_aviso_de_caso = false, channel_session_id = '${SESSAO_DESCARTAVEL}',
             telefone_destino = '+5531911112222', ligado = true
       where organization_id = '${ORG_A}';
    `);
    expect(booleano(`select ligado::text from public.config_aviso_de_agendamento where organization_id = '${ORG_A}'`)).toBe(true);
    expect(erroDe(`delete from public.channel_sessions where id = '${SESSAO_DESCARTAVEL}';`)).toBe("");
    expect(
      booleano(`select ligado::text from public.config_aviso_de_agendamento where organization_id = '${ORG_A}'`),
      "o aviso ficou LIGADO sem conexão — a tela diria ativo sobre um aviso que nunca dispara",
    ).toBe(false);
  });
});

describe("0707 — o expurgo respeita o piso de 30 dias", () => {
  it("apaga o vencido e preserva o recente, mesmo pedindo 1 dia", () => {
    sql(`
      insert into public.entregas_de_aviso_de_agendamento (organization_id, tipo, dia, destino, status, created_at)
        values ('${ORG_B}', 'resumo', '2025-01-01', '+5511988887777', 'enviado', now() - interval '400 days'),
               ('${ORG_B}', 'resumo', '2026-10-01', '+5511988887777', 'enviado', now() - interval '20 days')
        on conflict do nothing;
    `);
    sql(`select public.fn_expurgar_avisos_de_agendamento_vencidos(1, 1000);`);
    expect(valor(`select count(*) from public.entregas_de_aviso_de_agendamento where organization_id = '${ORG_B}' and dia = '2025-01-01'`)).toBe("0");
    expect(valor(`select count(*) from public.entregas_de_aviso_de_agendamento where organization_id = '${ORG_B}' and dia = '2026-10-01'`)).toBe("1");
  });
});
