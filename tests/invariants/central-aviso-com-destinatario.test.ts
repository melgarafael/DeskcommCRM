/**
 * `agent_inbox_items.para_user_id` (migration 0689, doc de decisão 162) no
 * baseline que o self-host aplica — e o recorte `para_user_id is null or
 * para_user_id = <eu>` que a Central usa, contra o Postgres de verdade.
 *
 * O efeito nas ROTAS (lista, sino, "Marcar todos", resolver um) está em
 * `tests/unit/central-aviso-com-destinatario.test.ts`; aqui fica o que só o
 * banco prova: a coluna existe, é opcional (os avisos da empresa seguem
 * nulos) e some com a pessoa (`on delete cascade`).
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const org = randomUUID(), outraOrg = randomUUID(), ana = randomUUID(), bruno = randomUUID();

beforeAll(() => {
  sql(`insert into auth.users (id, email) values ('${ana}', 'dono-ana@invariant.test'), ('${bruno}', 'dono-bruno@invariant.test');
    insert into organizations (id, slug, legal_name, display_name) values
      ('${org}', '${org}', 'Org', 'Org'), ('${outraOrg}', '${outraOrg}', 'Vizinha', 'Vizinha');
    insert into agent_inbox_items (organization_id, para_user_id, kind, title, ref_kind, ref_id) values
      ('${org}', null, 'other', 'Da empresa', null, null),
      ('${org}', '${ana}', 'task_due', 'Da Ana', 'task', '${randomUUID()}'),
      ('${org}', '${bruno}', 'task_overdue', 'Do Bruno', 'task', '${randomUUID()}'),
      ('${outraOrg}', '${ana}', 'task_due', 'Da vizinha', 'task', '${randomUUID()}');`);
});

const titulosVisiveis = (user: string) =>
  lastLine(sql(`select string_agg(title, '|' order by title) from agent_inbox_items
    where organization_id = '${org}' and (para_user_id is null or para_user_id = '${user}');`));

describe("aviso da Central com destinatário (0689)", () => {
  it("a coluna é opcional e referencia auth.users com on delete cascade", () => {
    expect(lastLine(sql(`select is_nullable from information_schema.columns
      where table_schema='public' and table_name='agent_inbox_items' and column_name='para_user_id';`))).toBe("YES");
    expect(lastLine(sql(`select confdeltype::text || ':' || confrelid::regclass::text from pg_constraint
      where conrelid = 'public.agent_inbox_items'::regclass and contype = 'f'
        and conkey = array[(select attnum from pg_attribute where attrelid = 'public.agent_inbox_items'::regclass and attname = 'para_user_id')];`))).toBe("c:auth.users");
  });

  it("cada pessoa enxerga o aviso da empresa e o seu, nunca o do colega nem o da outra org", () => {
    expect(titulosVisiveis(ana)).toBe("Da Ana|Da empresa");
    expect(titulosVisiveis(bruno)).toBe("Da empresa|Do Bruno");
  });

  it("apagar a pessoa leva o aviso pessoal dela, e o da empresa fica", () => {
    sql(`delete from auth.users where id = '${bruno}';`);
    expect(lastLine(sql(`select count(*) from agent_inbox_items where title = 'Do Bruno';`))).toBe("0");
    expect(lastLine(sql(`select count(*) from agent_inbox_items where title = 'Da empresa' and organization_id = '${org}';`))).toBe("1");
  });
});
