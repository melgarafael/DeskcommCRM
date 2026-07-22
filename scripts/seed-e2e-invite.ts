/**
 * Seed do e2e do ciclo de convite (tests/e2e/invite-lifecycle.spec.ts).
 *
 * Compõe sobre scripts/seed-e2e-credentials.ts (que cria a org + admin com TOTP +
 * agent + viewer, gravando .e2e-creds.json) e só ACRESCENTA:
 *   - convidado@invite.e2e — conta auth EXISTE (mesma senha do seed base), mas
 *     SEM membership na org. É o atendente novo que vai aceitar o convite: um
 *     convidado real precisa de conta pra logar, mas o acesso à org só nasce no
 *     aceite. O estado inicial (sem membership) é o que o teste prova ser criado.
 *
 * Reusa o admin com TOTP do seed base como quem CONVIDA (invite exige role admin,
 * e admin tem MFA forçada — reaproveitar evita reenrolar TOTP aqui).
 *
 * Escreve .e2e-invite.json (gitignored): { org_id, invitee_email }.
 * Run: npx tsx scripts/seed-e2e-invite.ts
 */
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("[seed-invite] faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const INVITE_EMAIL = "convidado.invite@deskcomm.test";

interface BaseCreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

async function findUserId(email: string): Promise<string | null> {
  const { data } = await admin.schema("auth").from("users").select("id").eq("email", email).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function main(): Promise<void> {
  // 1. Garante o seed base (org + admin+TOTP + agent + viewer).
  if (!fs.existsSync(CREDS_PATH)) {
    console.log("[seed-invite] rodando seed base (seed-e2e-credentials)...");
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  const base = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as BaseCreds;
  const adminId = base.users.admin?.id;
  if (!adminId) throw new Error("seed base sem admin em .e2e-creds.json");

  // 2. Resolve a org do admin (a org do seed base).
  const { data: membership, error: mErr } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", adminId)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  if (mErr || !membership) throw new Error(`org do admin não resolvida: ${mErr?.message}`);
  const orgId = (membership as { organization_id: string }).organization_id;
  console.log(`[seed-invite] org do seed base: ${orgId}`);

  // 3. Convidado: conta existe (mesma senha do base), SEM membership.
  let inviteeId = await findUserId(INVITE_EMAIL);
  if (inviteeId) {
    await admin.auth.admin.updateUserById(inviteeId, { password: base.password, email_confirm: true });
    console.log(`[seed-invite] convidado existe: ${inviteeId}`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: INVITE_EMAIL,
      password: base.password,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser convidado: ${error?.message}`);
    inviteeId = data.user.id;
    console.log(`[seed-invite] convidado criado: ${inviteeId}`);
  }

  // estado inicial: SEM membership (o aceite é quem cria)
  await admin.from("user_organizations").delete().eq("user_id", inviteeId).eq("organization_id", orgId);
  console.log("[seed-invite] convidado sem membership (estado inicial correto)");

  const out = { org_id: orgId, invitee_email: INVITE_EMAIL, invitee_id: inviteeId };
  const outPath = path.join(process.cwd(), ".e2e-invite.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`[seed-invite] escrito ${outPath}: ${JSON.stringify(out)}`);
}

main().catch((e) => {
  console.error("[seed-invite] falhou:", e);
  process.exit(1);
});
