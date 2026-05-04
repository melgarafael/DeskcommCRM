/**
 * Cria/atualiza um usuário Supabase já confirmado e o anexa à E2E Test Org como admin.
 * Run: npx tsx scripts/create-test-user.ts <email> [password]
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
const PASSWORD = process.argv[3] ?? "E2E!Test1234";
const ORG_SLUG = "e2e-test-org";

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  let { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", ORG_SLUG)
    .maybeSingle<{ id: string }>();
  if (!org) {
    const r = await admin
      .from("organizations")
      .insert({
        slug: ORG_SLUG,
        display_name: "E2E Test Org",
        legal_name: "E2E Test Org",
        timezone: "America/Sao_Paulo",
        locale: "pt-BR",
        onboarded_at: new Date().toISOString(),
      } as never)
      .select("id")
      .single<{ id: string }>();
    if (r.error || !r.data) throw r.error ?? new Error("org insert");
    org = r.data;
    console.log("[org] criada:", org.id);
  } else {
    console.log("[org] existente:", org.id);
  }

  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  let user = list.users.find((u) => u.email === EMAIL);
  if (user) {
    await admin.auth.admin.updateUserById(user.id, { password: PASSWORD, email_confirm: true });
    console.log("[user] existente — senha resetada:", user.id);
  } else {
    const r = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Teste" },
    });
    if (r.error || !r.data?.user) throw r.error ?? new Error("user create");
    user = r.data.user;
    console.log("[user] criado:", user.id);
  }

  const { data: m } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", user.id)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (m) {
    await admin
      .from("user_organizations")
      .update({ role: "admin", revoked_at: null } as never)
      .eq("user_id", user.id)
      .eq("organization_id", org.id);
    console.log("[membership] atualizada → admin");
  } else {
    const r = await admin.from("user_organizations").insert({
      user_id: user.id,
      organization_id: org.id,
      role: "admin",
      accepted_at: new Date().toISOString(),
    } as never);
    if (r.error) throw r.error;
    console.log("[membership] inserida → admin");
  }

  console.log("\n✅ Pronto");
  console.log(`   email:    ${EMAIL}`);
  console.log(`   password: ${PASSWORD}`);
  console.log(`   user_id:  ${user.id}`);
  console.log(`   org_id:   ${org.id}`);
}

main().catch((err) => {
  console.error("❌ Falhou:", err);
  process.exit(1);
});
