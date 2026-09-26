import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20260926040200_0424_skill_versions_legadas_preservadas.sql"),
  "utf8",
);

describe("versões de skills legadas", () => {
  it("preserva a versão quando o ponteiro legado é removido", () => {
    const saida = sql(`
      begin;

      alter table public.skill_pointers add column if not exists id uuid default gen_random_uuid() unique;
      alter table public.skill_pointers alter column version_id drop not null;
      alter table public.skill_versions add column if not exists pointer_id uuid;
      alter table public.skill_versions alter column pointer_id drop not null;
      alter table public.skill_versions drop constraint if exists skill_versions_pointer_id_fkey;
      alter table public.skill_versions add constraint skill_versions_pointer_id_fkey
        foreign key (pointer_id) references public.skill_pointers(id) on delete cascade;

      insert into public.skill_pointers (id, organization_id, name, version_id)
      values ('f4210000-0000-4000-8000-000000000001', null, 'legada', null);

      insert into public.skill_versions
        (id, organization_id, name, description, body, matcher, pointer_id)
      values
        ('f4210000-0000-4000-8000-000000000002', null, 'legada', 'Skill legada', 'corpo', '{}'::jsonb,
         'f4210000-0000-4000-8000-000000000001');

      ${MIGRATION}

      delete from public.skill_pointers
       where id = 'f4210000-0000-4000-8000-000000000001';

      select count(*) || '|' || coalesce(min(pointer_id::text), 'nulo')
        from public.skill_versions
       where id = 'f4210000-0000-4000-8000-000000000002';

      rollback;
    `);

    expect(lastLine(saida.replace(/\nROLLBACK$/, ""))).toBe("1|nulo");
  });
});
