import fs from "node:fs";

function splitPolicies(s) {
  return s.replace(
    /create policy (avaliacao_[a-z_]+) on (public\.avaliacao_[a-z_]+)/g,
    "create policy $1\n    on $2",
  );
}

function addOrgOperante(s) {
  return s.replace(
    /(\s+where status = 'agendado'\s+and scheduled_at < now\(\)\s+)(returning 1)/,
    "$1       and public.fn_org_operante(organization_id)\n     $2",
  );
}

for (const f of [
  "supabase/migrations/20261106235900_0674_modulo_avaliacao_agenda.sql",
  "supabase/baseline.sql",
]) {
  let t = fs.readFileSync(f, "utf8");
  t = splitPolicies(t);
  t = addOrgOperante(t);
  fs.writeFileSync(f, t);
  console.log("fixed", f);
}
