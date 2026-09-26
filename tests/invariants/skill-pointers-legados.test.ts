import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20260926040000_0422_skill_pointers_legados.sql"),
  "utf8",
);

describe("reconciliação de skill_pointers legados", () => {
  it("preserva a linha e preenche o ponteiro canônico a partir de slug/active_version_id", () => {
    const saida = sql(`
      begin;

      alter table public.skill_pointers add column if not exists id uuid default gen_random_uuid();
      alter table public.skill_pointers add column if not exists slug text;
      alter table public.skill_pointers add column if not exists active_version_id uuid references public.skill_versions(id);
      alter table public.skill_pointers alter column name drop not null;
      alter table public.skill_pointers alter column version_id drop not null;

      insert into public.skill_versions
        (id, organization_id, name, description, body, matcher)
      values
        ('f4190000-0000-4000-8000-000000000001', null, 'legada', 'Skill legada', 'corpo', '{}'::jsonb);

      insert into public.skill_pointers
        (id, organization_id, slug, active_version_id, name, version_id)
      values
        ('f4190000-0000-4000-8000-000000000002', null, 'legada',
         'f4190000-0000-4000-8000-000000000001', null, null);

      ${MIGRATION}

      select count(*) || '|' || min(name) || '|' || min(version_id::text)
        from public.skill_pointers
       where id = 'f4190000-0000-4000-8000-000000000002';

      rollback;
    `);

    expect(lastLine(saida.replace(/\nROLLBACK$/, ""))).toBe(
      "1|legada|f4190000-0000-4000-8000-000000000001",
    );
  });
});
