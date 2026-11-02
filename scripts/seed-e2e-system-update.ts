/**
 * Seed E2E da atualização self-service (task 9). Garante:
 *   - o usuário `dono` do seed base é dono do servidor (`platform_admins`,
 *     não `role` de organização — são superfícies diferentes);
 *   - o usuário `admin` do seed base NÃO é dono do servidor;
 *   - `system_version`/`system_update_runs` num estado limpo, sem run pendente,
 *     pra o teste poder disparar sua própria atualização sem colidir com o
 *     índice único `uniq_system_update_runs_dispatched` (migration 0090).
 *
 * ═══ POR QUE A REVOGAÇÃO EXPLÍCITA ESTÁ AQUI ═══
 *
 * Até a Onda 1 do épico de marca, este seed promovia o `e2e-admin` — o mesmo
 * usuário que 10 outras specs usam como *admin de tenant* — e nenhum seed
 * revogava. As duas partes do job `e2e` compartilham banco SEM reset, então a
 * parte 2 inteira rodava com um admin promovido.
 *
 * O tamanho do estrago, MEDIDO (2026-08-14), porque a versão forte da frase é
 * falsa e valia mais medir que assumir: com rank `admin` (5, o teto de
 * `ROLE_RANK`), a promoção NÃO muda a navegação (`canSee` já devolvia `true` por
 * rank) nem os ~20 gates `!is_platform_admin && ROLE_RANK[role] < X`. Ela muda
 * só as superfícies EXCLUSIVAS do dono — `/app/settings/atualizacao`, `/admin/*`,
 * `updateBranding`, `setActiveOrg` fora das orgs de que a pessoa é membro.
 * Medido com `grep -ln '"/admin\|/app/settings/atualizacao' tests/e2e/*.spec.ts`:
 * a única spec que abre uma dessas é ESTA — as outras 10 que usam o admin
 * compartilhado, nenhuma. Ou seja: a contaminação é uma MINA, não um falso-verde
 * em curso. Ela detona na primeira spec que abrir `/admin/*` — que é o que o
 * épico de marca vai fazer.
 *
 * A revogação não é limpeza de cortesia, é AUTO-CURA: bancos locais e de clones
 * já contaminados voltam ao estado certo na próxima execução, sem ninguém
 * lembrar. Teardown em `afterAll` foi descartado de propósito — não roda quando
 * a spec estoura, e este seed rodava duas vezes por execução.
 *
 * Idempotente e auto-reset (mesmo padrão de scripts/seed-e2e-radar.ts). Depende
 * de .e2e-creds.json (rode scripts/seed-e2e-credentials.ts antes).
 *
 * Run: npx tsx scripts/seed-e2e-system-update.ts
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

// `process.env` VENCE o `.env.local` (ver scripts/lib/env-de-teste.ts).
//
// A versão anterior lia `.env.local` DIRETO do disco, ignorando o ambiente — e
// por isso a suíte E2E semeava no banco de PRODUÇÃO mesmo com o `.env.e2e`
// injetado no webServer do Playwright: este script nunca olhava para lá.
const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-system-update", credenciais);
const env = {
  NEXT_PUBLIC_SUPABASE_URL: credenciais.url,
  SUPABASE_SERVICE_ROLE_KEY: credenciais.serviceRole,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: credenciais.anonKey,
  NEXT_PUBLIC_APP_URL: credenciais.appUrl,
  SUPABASE_DB_URL: credenciais.dbUrl,
} as Record<string, string>;

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  users: Record<string, { id: string; email: string; role: string }>;
}

async function ensurePlatformAdmin(userId: string): Promise<void> {
  const { data: existing } = await admin
    .from("platform_admins")
    .select("user_id, revoked_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing && (existing as { revoked_at: string | null }).revoked_at === null) {
    console.log(`[seed] platform_admin já ativo: ${userId}`);
    return;
  }
  if (existing) {
    await admin
      .from("platform_admins")
      .update({ revoked_at: null, revoked_by: null, revoke_reason: null } as never)
      .eq("user_id", userId);
    console.log(`[seed] platform_admin reativado: ${userId}`);
    return;
  }
  const { error } = await admin.from("platform_admins").insert({
    user_id: userId,
    granted_by: userId,
    reason: "seed e2e — dono do servidor para o teste de atualização self-service",
  } as never);
  if (error) throw new Error(`insert platform_admins: ${error.message}`);
  console.log(`[seed] platform_admin criado: ${userId}`);
}

/**
 * Devolve o `e2e-admin` ao que ele deve ser: admin de TENANT, sem escape de
 * plataforma. Roda sempre, mesmo quando a linha já está revogada — é o que cura
 * um banco contaminado por uma execução anterior deste seed.
 *
 * Revoga em vez de deletar: `platform_admins` é auditável (`revoked_at`,
 * `revoked_by`, `revoke_reason`), e apagar a linha esconderia que a promoção
 * chegou a existir.
 */
async function revogarPlatformAdmin(userId: string, razao: string): Promise<void> {
  // O `error` é checado de propósito: sem isso, um select que falha devolve
  // `data: null`, a função retorna cedo, NADA é revogado — e o seed ainda
  // imprime sucesso. É a mesma classe que este arquivo conserta em
  // `seed-e2e-invite.ts`, e a palavra "auto-cura" só é verdade com o erro lido.
  const { data: existing, error: erroLeitura } = await admin
    .from("platform_admins")
    .select("user_id, revoked_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (erroLeitura) {
    throw new Error(
      `nao deu para ler platform_admins de ${userId}: ${erroLeitura.message}. ` +
        "A revogacao NAO aconteceu — nao trate este seed como auto-cura.",
    );
  }
  if (!existing) return; // nunca foi promovido — nada a curar
  if ((existing as { revoked_at: string | null }).revoked_at !== null) {
    console.log(`[seed] platform_admin já revogado: ${userId}`);
    return;
  }
  const { error } = await admin
    .from("platform_admins")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: userId,
      revoke_reason: razao,
    } as never)
    .eq("user_id", userId);
  if (error) throw new Error(`revoke platform_admins: ${error.message}`);
  console.log(`[seed] platform_admin REVOGADO: ${userId} — ${razao}`);
}

async function resetSystemVersion(): Promise<void> {
  const { error: delError } = await admin
    .from("system_update_runs")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (delError) throw new Error(`delete system_update_runs: ${delError.message}`);

  const { error: updError } = await admin
    .from("system_version")
    .update({
      current_version: "1.0.0",
      current_sha: "abc1234",
      // Estado legado limpo: não herdar confirmação/capacidade de outro caso.
      runtime_confirmation: null,
      off_release: false,
      latest_version: "",
      changelog_raw: "",
      agent_last_seen_at: null,
      update_requested_at: null,
      update_requested_by: null,
    } as never)
    .eq("id", 1);
  if (updError) throw new Error(`reset system_version: ${updError.message}`);
  console.log("[seed] system_version/system_update_runs resetados");
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const donoUser = creds.users.dono;
  const adminUser = creds.users.admin;
  if (!donoUser)
    throw new Error(
      "creds.users.dono ausente — rode `pnpm exec tsx scripts/seed-e2e-credentials.ts` primeiro " +
        "(o quinto usuário do seed base é quem vira dono do servidor)",
    );
  if (!adminUser)
    throw new Error("creds.users.admin ausente — rode seed-e2e-credentials.ts primeiro");

  await ensurePlatformAdmin(donoUser.id);
  await revogarPlatformAdmin(
    adminUser.id,
    "seed e2e — o admin de tenant compartilhado nunca é dono do servidor; " +
      "quem é dono é o e2e-dono (ver o cabeçalho deste arquivo)",
  );
  await resetSystemVersion();
  console.log("\n✅ Seed da atualização self-service completo.");
}

main().catch((err) => {
  console.error("❌ Seed da atualização self-service falhou:", err);
  process.exit(1);
});
