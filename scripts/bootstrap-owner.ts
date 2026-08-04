/**
 * Bootstrap do 1º dono de uma instância self-host do DeskcommCRM.
 *
 * O app NÃO tem tela de cadastro — este script cria, de forma idempotente:
 *   1. o usuário dono (auth) com e-mail confirmado
 *   2. a organização (tenant)
 *   3. a associação do dono como `admin`
 *   4. a linha em `platform_admins` (super-admin de plataforma)
 *
 * Depois disso o dono faz login e o onboarding do app cuida do resto
 * (WhatsApp, IA, time). MFA TOTP é forçado no 1º login do admin.
 *
 * Uso (o install.sh exporta as vars; localmente lê .env/.env.local):
 *   OWNER_EMAIL=dono@empresa.com OWNER_PASSWORD='senha-forte' \
 *   OWNER_ORG_NAME='Minha Empresa' npx tsx scripts/bootstrap-owner.ts
 *
 * Sobre um banco que JÁ tem esse e-mail, a senha existente é PRESERVADA. Antes
 * ela era sobrescrita em silêncio pelo OWNER_PASSWORD do .env — e este script é
 * documentado como "o que o install.sh faz", que faz o oposto: o instalador
 * manda um POST /auth/v1/admin/users, leva 422 `email_exists` e não toca na
 * senha. Duas rotas que se anunciam iguais e divergem justamente na credencial
 * do dono trancam quem re-roda o bootstrap com um .env de senha antiga.
 * Redefinir agora é escolha explícita:
 *   npx tsx scripts/bootstrap-owner.ts --reset-owner-password
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

/** Lê env do processo; completa com .env / .env.local se rodando localmente. */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const file of [".env", ".env.local"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]!]) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
    }
  }
  return out;
}

const env = loadEnv();

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const OWNER_EMAIL = env.OWNER_EMAIL;
const OWNER_PASSWORD = env.OWNER_PASSWORD;
const ORG_NAME = env.OWNER_ORG_NAME || "Minha Empresa";
/** Só com esta flag o script mexe na senha de um dono que já existe. */
const RESET_SENHA = process.argv.includes("--reset-owner-password");

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
}
if (!OWNER_EMAIL || !OWNER_PASSWORD) {
  throw new Error("Faltam OWNER_EMAIL / OWNER_PASSWORD.");
}

/** slug seguro (o tipo da coluna é restrito): minúsculo, hífens, sem acento. */
function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "minha-empresa";
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function ensureOwnerUser(): Promise<string> {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const existing = list.users.find((u) => u.email === OWNER_EMAIL);
  if (existing) {
    if (!RESET_SENHA) {
      console.log(
        `[bootstrap] dono já existia, senha PRESERVADA: ${existing.id}` +
          ` (para redefinir: --reset-owner-password)`,
      );
      return existing.id;
    }
    // O erro era engolido: uma senha que a admin API recusou (política de
    // tamanho, por ex.) saía como "senha atualizada" e a pessoa só descobria
    // na tela de login.
    const { error } = await admin.auth.admin.updateUserById(existing.id, {
      password: OWNER_PASSWORD,
    });
    if (error) throw new Error(`redefinir senha do dono: ${error.message}`);
    console.log(`[bootstrap] dono já existia, senha REDEFINIDA: ${existing.id}`);
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "Dono" },
  });
  if (error || !data?.user) throw new Error(`criar dono: ${error?.message}`);
  console.log(`[bootstrap] dono criado: ${data.user.id}`);
  return data.user.id;
}

async function ensureOrg(ownerId: string): Promise<string> {
  const slug = slugify(ORG_NAME);
  const { data: existing } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (existing) {
    console.log(`[bootstrap] org já existia: ${(existing as { id: string }).id}`);
    return (existing as { id: string }).id;
  }
  const { data, error } = await admin
    .from("organizations")
    .insert({
      slug,
      display_name: ORG_NAME,
      legal_name: ORG_NAME,
      created_by: ownerId,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`criar org: ${error?.message}`);
  console.log(`[bootstrap] org criada: ${(data as { id: string }).id}`);
  return (data as { id: string }).id;
}

async function ensureMembership(userId: string, orgId: string): Promise<void> {
  const { data: existing } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (existing) {
    await admin
      .from("user_organizations")
      .update({ role: "admin", revoked_at: null } as never)
      .eq("user_id", userId)
      .eq("organization_id", orgId);
    console.log("[bootstrap] associação admin garantida");
    return;
  }
  const { error } = await admin.from("user_organizations").insert({
    user_id: userId,
    organization_id: orgId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  } as never);
  if (error) throw new Error(`associação: ${error.message}`);
  console.log("[bootstrap] dono associado como admin");
}

async function ensurePlatformAdmin(userId: string): Promise<void> {
  const { data: existing } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (existing) {
    console.log("[bootstrap] super-admin já existia");
    return;
  }
  // granted_by = o próprio dono (auto-concessão no bootstrap). mfa_required
  // fica no default (true) — TOTP é forçado no login.
  const { error } = await admin.from("platform_admins").insert({
    user_id: userId,
    granted_by: userId,
    scope: "full",
    reason: "Bootstrap inicial do self-host (dono da instância)",
  } as never);
  if (error) throw new Error(`platform_admin: ${error.message}`);
  console.log("[bootstrap] dono promovido a super-admin de plataforma");
}

async function main(): Promise<void> {
  const ownerId = await ensureOwnerUser();
  const orgId = await ensureOrg(ownerId);
  await ensureMembership(ownerId, orgId);
  await ensurePlatformAdmin(ownerId);
  console.log(`\n✅ Bootstrap completo.\n  dono: ${OWNER_EMAIL}\n  org:  ${orgId}\n  Faça login em ${env.NEXT_PUBLIC_APP_URL || "https://<seu-dominio>"} e conclua o onboarding.`);
}

main().catch((err) => {
  console.error("❌ Bootstrap falhou:", err);
  process.exit(1);
});
