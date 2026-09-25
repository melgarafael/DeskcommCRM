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
 * (WhatsApp, IA, time). A verificação em duas etapas é OPCIONAL e se liga em
 * Configurações › Segurança — ver `lib/auth/politica-mfa.ts`.
 *
 * Uso (o install.sh exporta as vars; localmente lê .env/.env.local):
 *   OWNER_EMAIL=dono@empresa.com OWNER_PASSWORD='senha-forte' \
 *   OWNER_ORG_NAME='Minha Empresa' npx tsx scripts/bootstrap-owner.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

import { escolherModeloNoCatalogo } from "@/lib/ai/agents/escolher-modelo";

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
/**
 * O idioma que quem instalou escolheu, gravado na ORGANIZAÇÃO.
 *
 * Na organização, e não só no usuário dono, porque é ela que responde por quem
 * ainda não existe: o segundo, o terceiro e o décimo convidado entram sem
 * preferência própria e caem no idioma da empresa
 * (`AuthUser.idioma`, resolvido em `lib/auth/server.ts`). Gravar apenas no dono
 * faria uma instalação inteira em espanhol entregar o sistema em português para
 * todo mundo que o dono convidasse.
 *
 * Fecha para o padrão diante de qualquer valor desconhecido: um `.env` com
 * `APP_LOCALE=en` não pode derrubar a instalação nem escrever lixo no banco.
 */
const IDIOMAS_SERVIDOS = ["pt-BR", "es"] as const;
const APP_LOCALE = (IDIOMAS_SERVIDOS as readonly string[]).includes(
  (env.APP_LOCALE ?? "").trim(),
)
  ? (env.APP_LOCALE as string).trim()
  : "pt-BR";

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
    await admin.auth.admin.updateUserById(existing.id, { password: OWNER_PASSWORD });
    console.log(`[bootstrap] dono já existia, senha atualizada: ${existing.id}`);
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    email_confirm: true,
    // O dono também nasce com a preferência: ele é o único que entra antes de
    // existir organização resolvida na sessão, no primeiro login.
    user_metadata: { full_name: "Dono", locale: APP_LOCALE },
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
      locale: APP_LOCALE,
      created_by: ownerId,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`criar org: ${error?.message}`);
  const orgId = (data as { id: string }).id;
  console.log(`[bootstrap] org criada: ${orgId}`);
  await aplicarProvedorEscolhido(orgId);
  return orgId;
}

/**
 * O provedor que a pessoa ESCOLHEU no instalador passa a valer no banco.
 *
 * `fn_seed_org_llm_defaults` (trigger de insert em `organizations`) semeia
 * `settings.llm.provider = 'anthropic'`, fixo. Enquanto a Anthropic era a única
 * chave que o `install.sh` pedia, isso estava certo. Desde que o instalador
 * pergunta qual IA vai atender, a resposta era simplesmente ignorada pelo
 * banco: quem escolhia OpenRouter instalava, cadastrava a chave, e todo caminho
 * que passa pelo agent-engine resolvia `provider='anthropic'` — sem chave da
 * Anthropic, `LlmNotConfiguredError` em tudo, com a mensagem mandando cadastrar
 * justamente a chave que ele decidiu não usar.
 *
 * O par vai INTEIRO (`lib/ai/pontos/padrao-da-organizacao.ts`): o gatilho
 * semeia `provider` e `default_model` da Anthropic juntos, e trocar só o
 * provedor deixava `{openai, claude-sonnet-5}` — um id que a OpenAI não
 * conhece, pedido por todo ponto que cai no padrão da empresa. O modelo sai do
 * catálogo do provedor escolhido pela MESMA régua do onboarding
 * (`escolherModeloNoCatalogo`), então nada aqui é inventado.
 *
 * Catálogo vazio (a OpenRouter chega com zero linhas até o cron de catálogo
 * rodar) ou ilegível: grava só o `provider`, como antes. O par incoerente que
 * sobra é resolvido na LEITURA por `lib/ai/gateway-binding.ts`, que troca o
 * modelo pelo do catálogo assim que ele existir.
 */
async function aplicarProvedorEscolhido(orgId: string): Promise<void> {
  const escolhido = (process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (escolhido === "" || escolhido === "anthropic") return;

  const { data: org } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  const settings = ((org as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;
  const llm = ((settings["llm"] as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;

  const escolha = await escolherModeloNoCatalogo(admin, escolhido);
  const modelo = escolha?.escolhido ? escolha.modelId : null;
  if (modelo === null) {
    console.warn(
      `[bootstrap] ${escolha === null ? "não consegui ler" : "ainda não há modelo no"} catálogo de "${escolhido}": ` +
        `gravo só o provedor, e o modelo padrão se escolhe em Agente de IA → Provedores.`,
    );
  }
  const novoLlm = modelo === null ? { ...llm, provider: escolhido } : { ...llm, provider: escolhido, default_model: modelo };

  const { error } = await admin
    .from("organizations")
    .update({ settings: { ...settings, llm: novoLlm } } as never)
    .eq("id", orgId);
  if (error) {
    // Não derruba a instalação: a org existe e o operador consegue trocar o
    // provedor pela tela. Mas o aviso precisa aparecer, senão ele descobre
    // pelo agente mudo.
    console.warn(
      `[bootstrap] não consegui gravar o provedor "${escolhido}" na organização: ${error.message}. ` +
        `Ajuste em Agente de IA → Provedores depois de entrar.`,
    );
    return;
  }
  console.log(`[bootstrap] provedor de IA da organização: ${escolhido}${modelo === null ? "" : ` (modelo ${modelo})`}`);
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
  // granted_by = o próprio dono (auto-concessão no bootstrap).
  //
  // ⚠️ `mfa_required: false` EXPLÍCITO, contra o default `true` da coluna. A
  // coluna nunca era lida pelo gate — ele olhava só `is_platform_admin` —, então
  // o default nunca teve efeito e ninguém percebeu. Agora ela decide, e deixá-la
  // em `true` significaria o oposto do que se pediu: TODA instalação nova
  // voltaria a receber o bloqueador de tela cheia logo depois do onboarding,
  // porque o `install.sh` cria o dono como platform admin.
  //
  // Instalações que JÁ EXISTEM ficam como estão — mudar o default não reescreve
  // linha, e ninguém tem a proteção desligada pelas nossas costas. Quem quiser
  // exigir liga em Configurações › Segurança.
  const { error } = await admin.from("platform_admins").insert({
    user_id: userId,
    granted_by: userId,
    scope: "full",
    mfa_required: false,
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
