import { beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * A PODA DA FILA, O EXPURGO DA AUDITORIA E A PODA DO EVENT_LOG CONTRA UM
 * POSTGRES DE VERDADE — issue #261 (job_queue/api_audit_log) e migration 0172
 * (event_log, mesmo molde).
 *
 * ─── Por que invariante e não unidade ───────────────────────────────────────
 *
 * O que pode quebrar aqui é SQL, e as regras que importam só existem no banco:
 * quais status são terminais, o anti-join contra o aviso ainda aberto, o piso
 * dentro do corpo da função, a cascata das FKs e — a mais importante — o
 * privilégio de quem pode chamar. Nenhuma dessas propriedades é observável de
 * um mock. Roda contra o Postgres efêmero do `scripts/test-db.sh`, com o MESMO
 * `baseline.sql` que o kit self-host aplica.
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 *     $ grep -rn "from job_queue" lib workers app supabase scripts | grep -i delete
 *     (zero linhas)
 *
 * `job_queue` crescia desde a instalação; `api_audit_log` prometia retenção de 5
 * anos no COMMENT e não tinha expurgo nenhum. Numa instalação parada elas são as
 * candidatas naturais a estourar os 500 MB do plano free do Supabase.
 *
 * ─── O risco do conserto, que é o que este arquivo vigia ────────────────────
 *
 * Uma poda mal cortada PERDE TRABALHO. `pending` é trabalho que ainda vai sair;
 * `running` está com um worker agora. E `dead` com aviso ABERTO na Central tem
 * dono também: um humano que ainda não olhou. Um DELETE por idade que não
 * distinga essas três coisas é pior que a tabela crescendo.
 */

const ORG = "26100000-0000-4000-8000-000000000001";
const CONTATO = "26100000-0000-4000-8000-000000000002";

/** Um id determinístico por caso — sem colisão entre os testes deste arquivo. */
function id(n: number): string {
  return `26100000-1111-4000-8000-${String(n).padStart(12, "0")}`;
}

function conta(query: string): number {
  return Number(lastLine(sql(query)));
}

/**
 * `idade` em dias ANTES de agora. `status` decide o `kind` porque o CHECK
 * `job_queue_turn_needs_contact` amarra kind ⇔ contato — a poda não olha kind
 * nenhum, então usar `inbound_turn` em todos os casos é indiferente para a regra.
 */
function enfileirar(opts: { id: string; status: string; idadeDias: number }): void {
  sql(`
    insert into job_queue (id, organization_id, contact_id, kind, payload, status, created_at)
    values ('${opts.id}', '${ORG}', '${CONTATO}', 'inbound_turn', '{}'::jsonb,
            '${opts.status}', now() - interval '${opts.idadeDias} days');
  `);
}

beforeEach(() => {
  sql(`
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'org-retencao-261', 'Org Retencao LTDA', 'Org Retencao')
      on conflict (id) do nothing;
    insert into contacts (id, organization_id, name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Lead da Poda', '+5511900000261')
      on conflict (id) do nothing;
    delete from agent_inbox_items where organization_id = '${ORG}';
    delete from job_queue where organization_id = '${ORG}';
    delete from api_audit_log where organization_id = '${ORG}';
    delete from automation_rule_runs where organization_id = '${ORG}';
    delete from automation_rules where organization_id = '${ORG}';
    delete from event_log where organization_id = '${ORG}';
  `);
});

describe("fn_podar_fila_de_jobs — apaga o terminal velho, preserva o que tem dono", () => {
  it("controle positivo: a função existe e devolve inteiro", () => {
    // Sem isto, uma função ausente faria os casos de "não apagou" passarem por
    // vacuidade — zero apagados é verdade quando nada roda.
    expect(conta(`select public.fn_podar_fila_de_jobs(90, 100)`)).toBeGreaterThanOrEqual(0);
  });

  it("apaga done/failed/dead velhos e NÃO toca em pending/running", () => {
    enfileirar({ id: id(1), status: "done", idadeDias: 200 });
    enfileirar({ id: id(2), status: "failed", idadeDias: 200 });
    enfileirar({ id: id(3), status: "dead", idadeDias: 200 });
    // `pending` e `running` com a MESMA idade: se a regra fosse só idade, os
    // cinco sairiam juntos. É o corte por status que este caso mede.
    enfileirar({ id: id(4), status: "pending", idadeDias: 200 });
    enfileirar({ id: id(5), status: "running", idadeDias: 200 });

    const apagados = conta(`select public.fn_podar_fila_de_jobs(90, 1000)`);
    expect(apagados).toBe(3);

    const sobraram = sql(
      `select string_agg(status, ',' order by status) from job_queue where organization_id = '${ORG}'`,
    );
    expect(lastLine(sobraram)).toBe("pending,running");
  });

  it("NÃO apaga terminal recente (o corte é por idade, e é por created_at)", () => {
    enfileirar({ id: id(6), status: "done", idadeDias: 10 });
    expect(conta(`select public.fn_podar_fila_de_jobs(90, 1000)`)).toBe(0);
    expect(conta(`select count(*) from job_queue where id = '${id(6)}'`)).toBe(1);
  });

  it("NÃO apaga `dead` cujo aviso na Central ainda está ABERTO", () => {
    // O `failJob`/`reapExpiredJobs` abre `agent_inbox_items` com
    // ref_kind='job_queue' e ref_id = job.id. Apagar o job deixaria o aviso
    // apontando para o vazio — e quem ia investigar perde o objeto.
    enfileirar({ id: id(7), status: "dead", idadeDias: 400 });
    enfileirar({ id: id(8), status: "dead", idadeDias: 400 });
    sql(`
      insert into agent_inbox_items (organization_id, kind, severity, title, ref_kind, ref_id, status)
      values ('${ORG}', 'job_dead', 'critical', 'Job descartado', 'job_queue', '${id(7)}', 'open'),
             ('${ORG}', 'job_dead', 'critical', 'Job descartado', 'job_queue', '${id(8)}', 'resolved');
    `);

    expect(conta(`select public.fn_podar_fila_de_jobs(90, 1000)`)).toBe(1);
    // O protegido é o do aviso ABERTO; o do aviso já resolvido sai.
    expect(conta(`select count(*) from job_queue where id = '${id(7)}'`)).toBe(1);
    expect(conta(`select count(*) from job_queue where id = '${id(8)}'`)).toBe(0);
  });

  it("o job protegido não trava a fila: o lote pula por cima dele", () => {
    // A armadilha que este caso prende: filtrar os protegidos DEPOIS do `limit`
    // faria um lote inteiro de protegidos devolver 0, o laço do cron pararia
    // achando que acabou, e a poda morreria de fome com backlog atrás.
    enfileirar({ id: id(9), status: "dead", idadeDias: 500 }); // o MAIS VELHO, protegido
    sql(`
      insert into agent_inbox_items (organization_id, kind, severity, title, ref_kind, ref_id, status)
      values ('${ORG}', 'job_dead', 'critical', 'Job descartado', 'job_queue', '${id(9)}', 'open');
    `);
    enfileirar({ id: id(10), status: "done", idadeDias: 400 });

    // Lote de UM: se o filtro viesse depois do limit, o lote seria só o
    // protegido e a função devolveria 0 para sempre.
    expect(conta(`select public.fn_podar_fila_de_jobs(90, 1)`)).toBe(1);
    expect(conta(`select count(*) from job_queue where id = '${id(10)}'`)).toBe(0);
  });

  it("respeita o `p_limite` (é isso que torna o DELETE lote, e não travamento)", () => {
    for (let i = 0; i < 5; i += 1) {
      enfileirar({ id: id(20 + i), status: "done", idadeDias: 300 });
    }
    expect(conta(`select public.fn_podar_fila_de_jobs(90, 2)`)).toBe(2);
    expect(conta(`select count(*) from job_queue where organization_id = '${ORG}'`)).toBe(3);
  });

  it("o PISO de 7 dias mora na função: p_retencao_dias = 0 não apaga o de ontem", () => {
    enfileirar({ id: id(30), status: "done", idadeDias: 1 });
    enfileirar({ id: id(31), status: "done", idadeDias: 30 });
    // Quem chama pede zero; a função eleva ao piso e o de ontem sobrevive.
    expect(conta(`select public.fn_podar_fila_de_jobs(0, 1000)`)).toBe(1);
    expect(conta(`select count(*) from job_queue where id = '${id(30)}'`)).toBe(1);
  });

  it("a cascata leva o send_ledger do run (efeito DECLARADO, não surpresa)", () => {
    enfileirar({ id: id(40), status: "done", idadeDias: 300 });
    sql(`
      insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
      values ('${ORG}', '${CONTATO}', '${id(40)}', 1, 'hash-261', 'accepted');
    `);
    expect(conta(`select count(*) from send_ledger where job_id = '${id(40)}'`)).toBe(1);

    conta(`select public.fn_podar_fila_de_jobs(90, 1000)`);

    // `on delete cascade` — as duas tabelas do run também crescem sem poda, então
    // isso é parte do conserto. Os dois consumidores de send_ledger sem janela
    // (disclosure de IA e gate LGPD de 1º toque) falham FECHADO quando a linha
    // some: disclosure a mais e veto a mais, nunca a menos.
    expect(conta(`select count(*) from send_ledger where job_id = '${id(40)}'`)).toBe(0);
  });
});

describe("fn_expurgar_auditoria_vencida — a retenção que a doutrina prometia", () => {
  function auditar(opts: { id: string; idadeDias: number }): void {
    sql(`
      insert into api_audit_log (id, organization_id, action, created_at)
      values ('${opts.id}', '${ORG}', 'retention.sweep_run',
              now() - interval '${opts.idadeDias} days');
    `);
  }

  it("apaga o que passou da retenção e preserva o que não passou", () => {
    auditar({ id: id(50), idadeDias: 2000 });
    auditar({ id: id(51), idadeDias: 1000 });
    expect(conta(`select public.fn_expurgar_auditoria_vencida(1825, 1000)`)).toBe(1);
    expect(conta(`select count(*) from api_audit_log where id = '${id(51)}'`)).toBe(1);
  });

  it("o PISO de 90 dias mora na função: nem com p_retencao_dias = 0 se apaga rastro recente", () => {
    // É esta linha que separa "expurgo de retenção" de "porta de adulteração de
    // auditoria". A função NÃO TEM seletor de linha — nem org, nem ator, nem
    // ação, nem id — e o único predicado é a idade, com piso no corpo. Não
    // existe argumento que a faça apagar a linha de ontem que incomoda.
    auditar({ id: id(52), idadeDias: 10 });
    auditar({ id: id(53), idadeDias: 400 });
    expect(conta(`select public.fn_expurgar_auditoria_vencida(0, 1000)`)).toBe(1);
    expect(conta(`select count(*) from api_audit_log where id = '${id(52)}'`)).toBe(1);
  });

  it("respeita o `p_limite`", () => {
    for (let i = 0; i < 4; i += 1) auditar({ id: id(60 + i), idadeDias: 2000 });
    expect(conta(`select public.fn_expurgar_auditoria_vencida(1825, 2)`)).toBe(2);
    expect(conta(`select count(*) from api_audit_log where organization_id = '${ORG}'`)).toBe(2);
  });
});

describe("fn_podar_event_log — mesma regra, terceira tabela (migration 0172)", () => {
  /** `entity_kind` deriva do prefixo do `event_type`, igual `fn_log_event`. */
  function emitir(opts: { id: string; status: string; idadeDias: number; eventType?: string }): void {
    const eventType = opts.eventType ?? "lead.created";
    const entityKind = eventType.split(".")[0];
    sql(`
      insert into event_log (id, organization_id, event_type, entity_kind, status, created_at)
      values ('${opts.id}', '${ORG}', '${eventType}', '${entityKind}', '${opts.status}',
              now() - interval '${opts.idadeDias} days');
    `);
  }

  it("controle positivo: a função existe e devolve inteiro", () => {
    expect(conta(`select public.fn_podar_event_log(90, 100)`)).toBeGreaterThanOrEqual(0);
  });

  it("apaga done/dead velhos e NÃO toca em pending/processing", () => {
    emitir({ id: id(70), status: "done", idadeDias: 200 });
    emitir({ id: id(71), status: "dead", idadeDias: 200 });
    // Mesma idade dos dois terminais — se a regra fosse só idade, os quatro
    // sairiam juntos. É o corte por status que este caso mede. `pending` aqui
    // é EXATAMENTE o estado em que um event_type sem handler registrado fica
    // para sempre (achado da migration 0172) — não pode ser varrido por idade.
    emitir({ id: id(72), status: "pending", idadeDias: 200 });
    emitir({ id: id(73), status: "processing", idadeDias: 200 });

    const apagados = conta(`select public.fn_podar_event_log(90, 1000)`);
    expect(apagados).toBe(2);

    const sobraram = sql(
      `select string_agg(status, ',' order by status) from event_log where organization_id = '${ORG}'`,
    );
    expect(lastLine(sobraram)).toBe("pending,processing");
  });

  it("NÃO apaga terminal recente (o corte é por idade, e é por created_at)", () => {
    emitir({ id: id(74), status: "done", idadeDias: 10 });
    expect(conta(`select public.fn_podar_event_log(90, 1000)`)).toBe(0);
    expect(conta(`select count(*) from event_log where id = '${id(74)}'`)).toBe(1);
  });

  it("respeita o `p_limite`", () => {
    for (let i = 0; i < 5; i += 1) {
      emitir({ id: id(80 + i), status: "done", idadeDias: 300 });
    }
    expect(conta(`select public.fn_podar_event_log(90, 2)`)).toBe(2);
    expect(conta(`select count(*) from event_log where organization_id = '${ORG}'`)).toBe(3);
  });

  it("o PISO de 7 dias mora na função: p_retencao_dias = 0 não apaga o de ontem", () => {
    emitir({ id: id(90), status: "done", idadeDias: 1 });
    emitir({ id: id(91), status: "done", idadeDias: 30 });
    expect(conta(`select public.fn_podar_event_log(0, 1000)`)).toBe(1);
    expect(conta(`select count(*) from event_log where id = '${id(90)}'`)).toBe(1);
  });

  it("automation_rule_runs.event_id vira NULL (on delete set null) — o run fica", () => {
    // A ÚNICA FK que aponta para event_log. Ao contrário de job_queue (cascade),
    // apagar o evento NUNCA leva o run junto — só zera o ponteiro, e a rota de
    // resend já trata event_id nulo (409 event_gone) antes desta migration existir.
    emitir({ id: id(92), status: "done", idadeDias: 300 });
    sql(`
      insert into automation_rules (id, organization_id, name, trigger_event)
      values ('${id(93)}', '${ORG}', 'Regra da poda 261', 'lead.created');
      insert into automation_rule_runs (id, organization_id, rule_id, event_id, status)
      values ('${id(94)}', '${ORG}', '${id(93)}', '${id(92)}', 'success');
    `);

    conta(`select public.fn_podar_event_log(90, 1000)`);

    expect(conta(`select count(*) from automation_rule_runs where id = '${id(94)}'`)).toBe(1);
    const eventId = sql(
      `select coalesce(event_id::text, 'null') from automation_rule_runs where id = '${id(94)}'`,
    );
    expect(lastLine(eventId)).toBe("null");
  });
});

describe("append-only: por onde o expurgo pode passar, e por onde não pode", () => {
  it("NINGUÉM tem GRANT de DELETE/UPDATE em api_audit_log — nem service_role", () => {
    // É por isso que o expurgo precisa de uma `security definer`: o admin client
    // do produto não consegue apagar esta tabela, e é bom que não consiga.
    const linhas = sql(`
      select coalesce(string_agg(grantee || ':' || privilege_type, ',' order by grantee), '')
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'api_audit_log'
         and privilege_type in ('DELETE', 'UPDATE')
         and grantee in ('anon', 'authenticated', 'service_role');
    `);
    expect(lastLine(linhas)).toBe("");
  });

  it("as três funções não são executáveis por anon nem por authenticated", () => {
    // As DUAS origens de EXECUTE: o grant direto do `ALTER DEFAULT PRIVILEGES
    // ... TO anon` do baseline, e o grant a PUBLIC que o Postgres dá na criação.
    // Tratar só uma deixa a função alcançável pela anon key, que vai ao browser.
    for (const fn of ["fn_podar_fila_de_jobs", "fn_expurgar_auditoria_vencida", "fn_podar_event_log"]) {
      for (const papel of ["anon", "authenticated"]) {
        const pode = lastLine(
          sql(`select has_function_privilege('${papel}', 'public.${fn}(int,int)', 'EXECUTE')`),
        );
        expect(pode, `${papel} pode executar ${fn}`).toBe("f");
      }
    }
  });

  it("service_role PODE executar as três (controle positivo do revoke)", () => {
    // Sem este caso, um `revoke` largo demais deixaria a suíte verde e a poda
    // morta: ninguém apagaria nada e o teste de exposição continuaria passando.
    for (const fn of ["fn_podar_fila_de_jobs", "fn_expurgar_auditoria_vencida", "fn_podar_event_log"]) {
      const pode = lastLine(
        sql(`select has_function_privilege('service_role', 'public.${fn}(int,int)', 'EXECUTE')`),
      );
      expect(pode, `service_role NÃO pode executar ${fn}`).toBe("t");
    }
  });
});
