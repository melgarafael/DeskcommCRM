/**
 * Move um user para uma org NOVA sem onboarded_at, pra forçar o fluxo de onboarding.
 * Run: npx tsx scripts/reset-user-onboarding.ts <email> [org-slug]
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

const EMAIL = process.argv[2] ?? "teste@gmail.com";
const ORG_SLUG = process.argv[3] ?? `onboarding-${EMAIL.split("@")[0]}`;
const ORG_NAME = `Onboarding ${EMAIL.split("@")[0]}`;

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const user = list.users.find((u) => u.email === EMAIL);
  if (!user) throw new Error(`user ${EMAIL} não encontrado`);
  console.log("[user]", user.id);

  let { data: org } = await admin
    .from("organizations")
    .select("id, onboarded_at")
    .eq("slug", ORG_SLUG)
    .maybeSingle<{ id: string; onboarded_at: string | null }>();
  if (!org) {
    const r = await admin
      .from("organizations")
      .insert({
        slug: ORG_SLUG,
        display_name: ORG_NAME,
        legal_name: ORG_NAME,
        timezone: "America/Sao_Paulo",
        locale: "pt-BR",
        onboarded_at: null,
      } as never)
      .select("id, onboarded_at")
      .single<{ id: string; onboarded_at: string | null }>();
    if (r.error || !r.data) throw r.error ?? new Error("org insert");
    org = r.data;
    console.log("[org] criada (sem onboarded_at):", org.id);
  } else {
    if (org.onboarded_at) {
      await admin.from("organizations").update({ onboarded_at: null } as never).eq("id", org.id);
      console.log("[org] existente — onboarded_at zerado:", org.id);
    } else {
      console.log("[org] existente, ainda não onboarded:", org.id);
    }
  }

  // Remove memberships antigas pra essa org não competir como "first"
  const del = await admin
    .from("user_organizations")
    .delete()
    .eq("user_id", user.id);
  if (del.error) throw del.error;
  console.log("[memberships] antigas removidas");

  const ins = await admin.from("user_organizations").insert({
    user_id: user.id,
    organization_id: org.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  } as never);
  if (ins.error) throw ins.error;
  console.log("[membership] anexada como admin à nova org");

  console.log(`\n✅ Login com ${EMAIL} agora cairá em /onboarding/welcome`);
  console.log(`   org_id: ${org.id}  slug: ${ORG_SLUG}`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
