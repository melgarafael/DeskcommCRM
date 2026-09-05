/**
 * E2E — O CADASTRO QUANDO O PROVEDOR NÃO PEDE CONFIRMAÇÃO DE E-MAIL.
 *
 * ─── O defeito, medido pela tela ────────────────────────────────────────────
 *
 * Com "Confirm email" DESLIGADO no provedor de auth — escolha do operador da
 * instalação, e o estado de muita VPS recém-montada —, `signUp()` devolve a
 * SESSÃO junto do usuário: a pessoa já entrou. A tela, que não sabia disso,
 * mostrava assim mesmo:
 *
 *     Confirme seu e-mail
 *     Enviamos um link de confirmação para <e-mail>.
 *     Abra o e-mail e clique no link para ativar sua conta.
 *
 * E-mail nenhum foi enviado. Medido na `origin/main` @ `4d50f63f`, dirigindo
 * esta mesma jornada: o texto acima aparecia, o cookie `sb-deskcomm-auth` já
 * estava no browser, e `user_organizations` do usuário novo vinha `[]`. A saída
 * existe desde o PR #465 (`/get-started`), mas a pessoa não tem motivo nenhum
 * para descobri-la: ela foi mandada esperar. Fica parada, autenticada e sem
 * organização, até desistir.
 *
 * Achado de @KIRAzinx566, com um cliente real preso nessa tela.
 *
 * ─── Por que esta spec está FORA do CI ──────────────────────────────────────
 *
 * A precondição não é um dado que a spec possa semear: é a configuração do
 * PROVEDOR (`GOTRUE_MAILER_AUTOCONFIRM`), fixada quando o Supabase local sobe,
 * e o `supabase/config.toml` do repo declara `enable_confirmations = true` — que
 * é o que as outras specs de cadastro exercitam. Ligar o autoconfirm para esta
 * spec mudaria o provedor para a suíte inteira.
 *
 * Por isso ela vive em `FORA_DO_CI` (com o motivo escrito lá) e o gate de todo
 * dia é o par de testes de unidade, que roda no `verify`:
 *
 *   - `app/actions/auth/signUp.test.ts` — a action DIZ que a sessão veio aberta
 *   - `tests/unit/cadastro-sem-confirmacao-nao-manda-esperar-email.test.tsx`
 *     — a tela AGE sobre isso
 *
 * Esta spec é a prova pela tela de que os dois, juntos, resolvem a jornada real.
 * Para rodá-la, ligue o autoconfirm no provedor local e rode só este arquivo:
 *
 *   docker inspect supabase_auth_<projeto> --format '{{json .Config.Env}}'  # guarde
 *   # recrie o container com GOTRUE_MAILER_AUTOCONFIRM=true
 *   pnpm exec playwright test tests/e2e/cadastro-sem-confirmacao-de-email.spec.ts
 *
 * Ela CONFERE a precondição antes de medir e falha alto se não estiver de pé —
 * uma spec que se auto-pula aqui leria como "a jornada está boa".
 */
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const URL_SUPABASE = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const svc = createClient(URL_SUPABASE, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const SENHA = "CadastroSemConfirmar!2026#Deskcomm";
const NOME_DA_EMPRESA = "Plata Iphones E2E";

/** Usuários e organizações criados pela jornada — limpos no fim. */
const usuariosCriados: string[] = [];
const orgsCriadas: string[] = [];

test.beforeAll(async () => {
  const r = await fetch(`${URL_SUPABASE}/auth/v1/settings`, {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
  });
  const settings = (await r.json()) as { mailer_autoconfirm?: boolean };
  // Sem a precondição, TODOS os casos abaixo passariam pelo caminho de sempre e
  // a spec ficaria verde sem ter medido nada do defeito.
  expect(
    settings.mailer_autoconfirm,
    "precondição ausente: o provedor local ainda exige confirmação de e-mail " +
      "(GOTRUE_MAILER_AUTOCONFIRM=false). Ver o cabeçalho desta spec.",
  ).toBe(true);
});

test.afterAll(async () => {
  for (const id of orgsCriadas) {
    await svc.from("user_organizations").delete().eq("organization_id", id);
    await svc.from("crm_stages").delete().eq("organization_id", id);
    await svc.from("crm_pipelines").delete().eq("organization_id", id);
    await svc.from("organizations").delete().eq("id", id);
  }
  for (const id of usuariosCriados) await svc.auth.admin.deleteUser(id);
});

async function idDoUsuario(email: string): Promise<string> {
  const { data } = await svc.auth.admin.listUsers();
  const u = data.users.find((x) => x.email === email);
  if (!u) throw new Error(`usuário ${email} não chegou ao banco`);
  usuariosCriados.push(u.id);
  return u.id;
}

test("⭐ o cadastro não manda esperar um e-mail que não vai chegar", async ({ page }) => {
  const email = `sem-confirmar-${randomUUID().slice(0, 8)}@qa.local`;

  await page.goto("/signup");
  await page.locator("#org_name").fill(NOME_DA_EMPRESA);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(SENHA);
  await page.locator("#password_confirm").fill(SENHA);
  await page.getByRole("button", { name: /criar conta/i }).click();

  // A saída, e não a sala de espera.
  await expect(page).toHaveURL(/\/get-started/, { timeout: 30_000 });
  await expect(
    page.getByText(/Enviamos um link de confirmação/i),
    "a instrução impossível continuou na tela",
  ).toHaveCount(0);

  // O nome que ela digitou no cadastro chega preenchido — não se pede duas
  // vezes o dado que o sistema já tem.
  await expect(page.getByLabel(/Nome da empresa/i)).toHaveValue(NOME_DA_EMPRESA);

  // E a jornada CONCLUI: chegar à tela não é o conserto, sair do beco é.
  const idUsuario = await idDoUsuario(email);
  await page.getByRole("button", { name: /Continuar para o onboarding/i }).click();
  await expect(page).toHaveURL(/\/onboarding\/welcome/, { timeout: 40_000 });

  const { data: vinculo } = await svc
    .from("user_organizations")
    .select("organization_id, role, organizations(display_name)")
    .eq("user_id", idUsuario)
    .maybeSingle();
  expect(vinculo, "a tela navegou sem provisionar organização nenhuma").not.toBeNull();
  const v = vinculo as unknown as {
    organization_id: string;
    role: string;
    organizations: { display_name: string } | { display_name: string }[];
  };
  orgsCriadas.push(v.organization_id);
  expect(v.role).toBe("admin");
  const org = Array.isArray(v.organizations) ? v.organizations[0] : v.organizations;
  expect(org?.display_name).toBe(NOME_DA_EMPRESA);
});

test("⭐ quem se cadastra POR UM CONVITE vai aceitá-lo, não abrir empresa própria", async ({
  page,
}) => {
  // O contrapeso do caso acima. Um desvio que mandasse todo mundo para
  // `/get-started` resolveria a jornada de cima e recriaria, um andar acima, o
  // erro que `decidirConviteDoSignup` existe para evitar: dar organização
  // própria a quem foi convidado para uma que já existe.
  const { data: org, error } = await svc
    .from("organizations")
    .insert({
      slug: `convite-sem-confirmar-${randomUUID().slice(0, 8)}`,
      display_name: "Empresa Que Convidou",
      legal_name: "Empresa Que Convidou",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !org) throw error ?? new Error("sem organização que convida");
  orgsCriadas.push(org.id as string);

  const email = `convidado-sem-confirmar-${randomUUID().slice(0, 8)}@qa.local`;
  // O mesmo token que o convite real emite — assinado com o INTERNAL_SECRET do
  // `.env.e2e`, que o runner publica no ambiente deste processo.
  const { signInviteToken } = await import("@/lib/auth/invite-token");
  const token = signInviteToken({
    invite_id: randomUUID(),
    email,
    organization_id: org.id as string,
    role: "agent",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  await page.goto(`/signup?invite=${encodeURIComponent(token)}`);
  await page.locator("#password").fill(SENHA);
  await page.locator("#password_confirm").fill(SENHA);
  await page.getByRole("button", { name: /criar conta/i }).click();

  await expect(page).toHaveURL(/\/team\/accept-invite\//, { timeout: 30_000 });
  await idDoUsuario(email);
});
