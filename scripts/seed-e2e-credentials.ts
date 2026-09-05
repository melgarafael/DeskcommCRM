/**
 * Seed E2E test credentials: 1 org + 5 users (admin, manager, agent, viewer,
 * dono) + 1 ai_agents default.
 * Idempotent: re-runs upsert by email/org name. Também garante um factor TOTP
 * verified no admin com secret CONHECIDO (gravado em .e2e-creds.json) para o
 * Playwright passar o challenge MFA — MFA do admin nunca é desabilitado.
 *
 * ═══ POR QUE EXISTE UM QUINTO USUÁRIO, `dono` ═══
 *
 * `platform_admin` (dono do servidor) e `admin` de organização são superfícies
 * DIFERENTES. Para quem já é `admin` de tenant, a promoção não muda navegação
 * nem os gates por rank (medido — ver `tests/e2e/utils/precondicao.ts`); ela
 * abre as superfícies EXCLUSIVAS do dono: `/app/settings/atualizacao`
 * (`page.tsx:16` faz `notFound()` sem a flag), `/admin/*`, `updateBranding`.
 *
 * Até aqui, `seed-e2e-system-update.ts` PROMOVIA o `e2e-admin` — o mesmo usuário
 * que 10 outras specs usam como *admin de tenant* — e nenhum seed revogava. As
 * duas partes do job `e2e` compartilham banco sem reset, então a parte 2 inteira
 * rodava com um admin promovido: uma mina armada para a primeira spec que abrisse
 * uma tela de dono com ele.
 *
 * O conserto REMOVE A CAUSA em vez de limpar depois: quem precisa ser dono do
 * servidor é este usuário dedicado, e `e2e-admin` volta a ser só admin de tenant.
 * Teardown foi descartado de propósito — `afterAll` não roda quando a spec
 * estoura, e o seed promovia em dois pontos do arquivo.
 *
 * O `dono` tem TOTP próprio porque `requiresMfa` (`lib/auth/server.ts:160`) é
 * `isPlatformAdmin || role === "admin"`: sem segundo fator ele não passa do
 * `/login/mfa`.
 *
 * Output: .e2e-creds.json (gitignored) com URLs e creds para Playwright/curl.
 *
 * Run: npx tsx scripts/seed-e2e-credentials.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

import { generateTotp } from "../tests/e2e/utils/totp";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

// `process.env` VENCE o `.env.local` (ver scripts/lib/env-de-teste.ts).
//
// A versão anterior lia `.env.local` DIRETO do disco, e por isso a suíte E2E
// semeava org, usuários e agentes no banco de PRODUÇÃO: o `.env.e2e` injetado no
// webServer do Playwright nunca alcançava este script, porque ele não olhava
// para o ambiente. Medido em 2026-08-06 — o factor TOTP em `.e2e-creds.json` não
// existia no banco local porque tinha sido criado na nuvem.
const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-credentials", credenciais);
const SUPABASE_URL = credenciais.url;
const SERVICE_ROLE = credenciais.serviceRole;
const ANON_KEY = credenciais.anonKey;
const APP_URL = credenciais.appUrl;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG_NAME = "E2E Test Org";
const ORG_SLUG = "e2e-test-org";
const PASSWORD = "E2E!Test1234";

/**
 * `chave` é o nome sob o qual o usuário aparece em `creds.users.*`, e existe
 * porque ela deixou de ser igual ao `role`: `dono` também é `admin` de
 * organização (precisa de membership para alcançar `/app/*`), e indexar por
 * `role` faria o quinto usuário SOBRESCREVER o `users.admin` que 10 specs leem.
 */
const USERS: Array<{
  chave: "admin" | "manager" | "agent" | "viewer" | "dono";
  email: string;
  role: "admin" | "manager" | "agent" | "viewer";
  full_name: string;
}> = [
  { chave: "admin", email: "e2e-admin@deskcomm.test", role: "admin", full_name: "E2E Admin" },
  { chave: "manager", email: "e2e-manager@deskcomm.test", role: "manager", full_name: "E2E Manager" },
  { chave: "agent", email: "e2e-agent@deskcomm.test", role: "agent", full_name: "E2E Agent" },
  { chave: "viewer", email: "e2e-viewer@deskcomm.test", role: "viewer", full_name: "E2E Viewer" },
  // Dono do servidor. Quem `seed-e2e-system-update.ts` promove a `platform_admins`
  // — nunca mais o `admin`. Role de tenant `admin` porque as telas do dono vivem
  // dentro de `/app/*` e exigem organização ativa (`resolveActiveOrg`).
  { chave: "dono", email: "e2e-dono@deskcomm.test", role: "admin", full_name: "E2E Dono do Servidor" },
];

async function ensureOrg(): Promise<string> {
  const { data: existing } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", ORG_SLUG)
    .maybeSingle();
  if (existing) {
    const orgExistente = (existing as { id: string }).id;

    /**
     * O SEED E DONO DO ESTADO QUE PROMETE, nao so da primeira escrita dele.
     *
     * `onboarded_at` era gravado apenas no INSERT abaixo. Numa org que ja
     * existe, este ramo devolvia o id e ia embora — e se alguma execucao
     * anterior tivesse zerado o campo, ele nunca mais voltava.
     *
     * O efeito medido em 2026-09-03: a `E2E Test Org` ficou com
     * `onboarded_at` nulo, `app/app/layout.tsx:51` passou a redirecionar todo
     * login dela para `/onboarding`, e a barra lateral deixou de existir. Duas
     * specs de webhooks falharam procurando um link que a tela do wizard nao
     * tem — sintoma que nao aponta para ca, e que custou uma investigacao
     * inteira para ligar as pontas.
     *
     * Quem zera de proposito e `vps-fresh-onboarding.spec.ts` (ela testa
     * instalacao fresca) e `seed-e2e-funis.ts` (a SEGUNDA org, que precisa
     * estar nao-configurada). Nenhum dos dois esta errado: o que faltava era
     * este seed reafirmar o proprio contrato ao reusar.
     *
     * Mesma classe que `tests/unit/seeds-nao-disputam-organizacao.test.ts`
     * fecha do lado de quem cria, aparecendo do lado de quem reusa.
     */
    const { error: erroOnboard } = await admin
      .from("organizations")
      .update({ onboarded_at: new Date().toISOString() } as never)
      .eq("id", orgExistente)
      .is("onboarded_at", null);
    if (erroOnboard) {
      throw new Error(`reafirmar org onboarded: ${erroOnboard.message}`);
    }

    console.log(`[seed] org existing: ${orgExistente}`);
    return orgExistente;
  }
  const { data, error } = await admin
    .from("organizations")
    .insert({
      slug: ORG_SLUG,
      display_name: ORG_NAME,
      legal_name: ORG_NAME,
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      onboarded_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error("create org: " + error?.message);
  const orgId = (data as { id: string }).id;
  console.log(`[seed] org created: ${orgId}`);
  return orgId;
}

async function ensureUser(email: string, full_name: string): Promise<string> {
  // listUsers paginado — perPage default 50; nosso pool é pequeno
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const existing = list.users.find((u) => u.email === email);
  if (existing) {
    console.log(`[seed] user existing ${email}: ${existing.id}`);
    // garantir senha conhecida
    await admin.auth.admin.updateUserById(existing.id, { password: PASSWORD });
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name },
  });
  if (error || !data?.user) throw new Error(`create user ${email}: ${error?.message}`);
  console.log(`[seed] user created ${email}: ${data.user.id}`);
  return data.user.id;
}

async function ensureMembership(userId: string, orgId: string, role: string): Promise<void> {
  const { data: existing } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (existing) {
    await admin
      .from("user_organizations")
      .update({ role, revoked_at: null } as never)
      .eq("user_id", userId)
      .eq("organization_id", orgId);
    console.log(`[seed] membership updated user=${userId} role=${role}`);
    return;
  }
  const { error } = await admin.from("user_organizations").insert({
    user_id: userId,
    organization_id: orgId,
    role,
    accepted_at: new Date().toISOString(),
  } as never);
  if (error) throw new Error(`membership insert: ${error.message}`);
  console.log(`[seed] membership inserted user=${userId} role=${role}`);
}

async function ensureAgent(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (existing) {
    console.log(`[seed] ai_agent default existing: ${(existing as { id: string }).id}`);
    return (existing as { id: string }).id;
  }
  const { data, error } = await admin
    .from("ai_agents")
    .insert({
      organization_id: orgId,
      name: "Bot Padrão E2E",
      description: "Agent default para testes E2E",
      is_active: true,
      is_default: true,
      model: "anthropic/claude-sonnet-4-6",
      system_prompt:
        "Você é um assistente do CRM E2E. Responda de forma educada e use os {rag_chunks} disponíveis.",
      config: {
        temperature: 0.4,
        max_tokens: 1024,
        context_message_window: 20,
        rag_top_k: 5,
        rag_similarity_threshold: 0.72,
        confidence_threshold: 0.6,
      },
      guardrails: [],
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error("ai_agent insert: " + error?.message);
  const id = (data as { id: string }).id;
  console.log(`[seed] ai_agent default created: ${id}`);
  return id;
}

interface AdminTotp {
  factor_id: string;
  secret: string;
}

/**
 * Garante um factor TOTP verified com secret conhecido (MFA é mandatório pra
 * role admin e pra platform admin; o e2e precisa do secret pra responder o
 * challenge). Idempotente: reutiliza o factor gravado em .e2e-creds.json se ele
 * ainda existir verified; senão rotaciona (delete + enroll + verify). O usuário
 * nunca fica sem MFA no estado final.
 *
 * `campoNoCreds` é a chave sob a qual o par (factor, secret) é gravado —
 * `admin_totp` para o `e2e-admin`, `dono_totp` para o `e2e-dono`. Sem esse
 * parâmetro os dois usuários disputariam UM campo: o segundo leria o factor do
 * primeiro, não o acharia entre os seus, e rotacionaria — invalidando o secret
 * do primeiro a cada execução.
 *
 * ⚠️ Isso é uma armadilha NOVA que este parâmetro evita, não a explicação do
 * "MFA falhou" que já apareceu nesta suíte: aquele é rotação por OUTRA SESSÃO
 * rodando este mesmo seed. Medido em 2026-08-14 — `.e2e-creds.json` trazia
 * `factor_id 49c64c17…` e o banco tinha `81ee0438…`. Ver a seção "Descoberta
 * lateral" de `HANDOFF-marca-propria.md`, onde a explicação errada está
 * registrada e refutada.
 */
async function garantirTotp(
  userId: string,
  email: string,
  campoNoCreds: "admin_totp" | "dono_totp",
): Promise<AdminTotp> {
  let prev: AdminTotp | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")) as Record<
      string,
      AdminTotp | undefined
    >;
    const gravado = raw[campoNoCreds];
    if (gravado?.factor_id && gravado.secret) prev = gravado;
  } catch {
    prev = null; // sem creds anteriores — enroll do zero
  }

  const { data: listed, error: listErr } = await admin.auth.admin.mfa.listFactors({
    userId,
  });
  if (listErr) throw new Error("listFactors: " + listErr.message);
  const factors = listed?.factors ?? [];

  if (prev && factors.some((f) => f.id === prev!.factor_id && f.status === "verified")) {
    console.log(`[seed] ${campoNoCreds} factor reused: ${prev.factor_id}`);
    return prev;
  }

  // Rotaciona: remove factors TOTP existentes (secret desconhecido) e re-enrolla.
  for (const f of factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
    if (error) throw new Error(`deleteFactor ${f.id}: ${error.message}`);
    console.log(`[seed] ${campoNoCreds} factor removed (rotating): ${f.id}`);
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInErr } = await anon.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (signInErr) throw new Error(`signIn for TOTP enroll (${email}): ` + signInErr.message);

  const { data: enrolled, error: enrollErr } = await anon.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "e2e-seed",
  });
  if (enrollErr || !enrolled) throw new Error("mfa.enroll: " + enrollErr?.message);
  const secret = enrolled.totp.secret;

  const { data: challenge, error: chErr } = await anon.auth.mfa.challenge({
    factorId: enrolled.id,
  });
  if (chErr || !challenge) throw new Error("mfa.challenge: " + chErr?.message);

  const { error: verifyErr } = await anon.auth.mfa.verify({
    factorId: enrolled.id,
    challengeId: challenge.id,
    code: generateTotp(secret),
  });
  if (verifyErr) throw new Error("mfa.verify: " + verifyErr.message);
  await anon.auth.signOut();

  console.log(`[seed] ${campoNoCreds} factor enrolled: ${enrolled.id}`);
  return { factor_id: enrolled.id, secret };
}

async function main(): Promise<void> {
  const orgId = await ensureOrg();

  const users: Record<string, { id: string; email: string; role: string }> = {};
  for (const u of USERS) {
    const userId = await ensureUser(u.email, u.full_name);
    await ensureMembership(userId, orgId, u.role);
    users[u.chave] = { id: userId, email: u.email, role: u.role };
  }

  const agentId = await ensureAgent(orgId);
  const adminTotp = await garantirTotp(users.admin!.id, users.admin!.email, "admin_totp");
  const donoTotp = await garantirTotp(users.dono!.id, users.dono!.email, "dono_totp");

  const creds = {
    org_id: orgId,
    org_slug: ORG_SLUG,
    org_name: ORG_NAME,
    password: PASSWORD,
    users,
    admin_totp: adminTotp,
    dono_totp: donoTotp,
    default_agent_id: agentId,
    app_url: APP_URL,
    supabase_url: SUPABASE_URL,
    supabase_anon_key: ANON_KEY,
  };

  fs.writeFileSync(".e2e-creds.json", JSON.stringify(creds, null, 2));
  console.log("\n✅ Seed completo. Credenciais escritas em .e2e-creds.json");
  console.log(`org: ${orgId}`);
  console.log(`agent default: ${agentId}`);
  console.log(
    `users: ${Object.entries(users)
      .map(([chave, u]) => `${chave}(${u.role})=${u.email}`)
      .join(", ")}`,
  );
}

main().catch((err) => {
  console.error("❌ Seed falhou:", err);
  process.exit(1);
});
