import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";
describe("native social schema", () => {
  it("keeps integration credentials inaccessible to browser database roles", () => {
    for (const role of ["anon", "authenticated"]) {
      expect(sql(`select has_table_privilege('${role}', 'public.channel_integrations', 'SELECT')`)).toBe("f");
      expect(sql(`select has_table_privilege('${role}', 'public.channel_integrations', 'INSERT')`)).toBe("f");
    }
    expect(sql("select relrowsecurity from pg_class where oid = 'public.channel_integrations'::regclass")).toBe("t");
  });
  it("separates numeric social IDs from phones and scopes uniqueness to the organization", () => {
    sql(`insert into organizations (id, slug, legal_name, display_name) values
      ('10000000-0000-4000-8000-000000000001','social-a','Social A','Social A'),
      ('10000000-0000-4000-8000-000000000002','social-b','Social B','Social B');
      insert into contacts (organization_id, social_identity) values
      ('10000000-0000-4000-8000-000000000001','instagram:account:12345'),
      ('10000000-0000-4000-8000-000000000002','instagram:account:12345');`);
    sql(`insert into channel_integrations (organization_id, profile_id, credential_encrypted) values
      ('10000000-0000-4000-8000-000000000001','profile-a','\\x00'),
      ('10000000-0000-4000-8000-000000000002','profile-b','\\x00');`);
    for (const org of ['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002']) {
      expect(() => sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000099"}', false);
        select credential_encrypted from channel_integrations where organization_id = '${org}';`)).toThrow();
    }
    expect(sql("select count(*) from contacts where social_identity = 'instagram:account:12345' and phone_number is null and wa_identity is null")).toBe("2");
    expect(() => sql("insert into contacts (organization_id, social_identity) values ('10000000-0000-4000-8000-000000000001','instagram:account:12345')")).toThrow();
  });
});
