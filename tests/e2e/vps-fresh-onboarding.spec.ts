/**
 * J1 — Onboarding do primeiro usuário numa instalação FRESCA (estilo VPS).
 *
 * Pré-condições (ambiente que simula o kit self-host):
 *   - banco zerado do baseline.sql (Supabase local pg17)
 *   - primeiro usuário criado via scripts/bootstrap-owner.ts (como o install.sh)
 *   - WAHA ativo, Redis local, RESEND_API_KEY VAZIO (realidade da VPS fresca)
 *   - app em produção (next build + next start) na E2E_PORT
 *
 * Casos: J1.1–J1.13 do docs/testing/user-journey-map.md. Tudo pelo frontend;
 * banco só para PROVAR estado (nunca para atalhar a jornada).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const OWNER_EMAIL = "dono@qa.local";
const OWNER_PASSWORD = "QaVps!2026#Dono";
const OWNER_STATE_PATH = path.join(process.cwd(), ".e2e-owner.json");
const EVIDENCE_DIR = path.join(process.cwd(), ".superpowers/evidence/vps-qa");

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

/**
 * A ORGANIZACAO DO DONO — resolvida por QUEM ELA E, nunca por "a primeira".
 *
 * Este seletor era `.limit(1).single()` sem filtro nenhum: pegava a primeira
 * organizacao que o Postgres devolvesse. Num banco recem-semeado isso funciona
 * por acidente — a unica org existente e a do teste. Num banco que ja tem uso,
 * a primeira e OUTRA, e o `beforeAll` desta suite entao zerava `onboarded_at`,
 * apagava `ai_agents` e apagava `channel_sessions` DELA.
 *
 * Medido em 2026-09-03, numa instalacao de trabalho: a organizacao real perdeu
 * o onboarding e caiu no wizard, e a sessao de WhatsApp conectada foi apagada.
 * O sintoma que apareceu primeiro foi outro e nao apontava para ca — duas specs
 * de webhooks falhando porque o link sumia da barra lateral, que e o que o
 * layout faz quando a org nao esta onboarded.
 *
 * A correcao amarra a org ao DONO do bootstrap (`OWNER_EMAIL`), que e de quem
 * esta suite fala. Se ele nao existir, falha alto: um teste destrutivo que nao
 * sabe em quem esta mexendo deve parar, nunca escolher alguem.
 */
async function orgRow(): Promise<{
  id: string;
  display_name: string;
  timezone: string | null;
  onboarded_at: string | null;
  onboarding_state: Record<string, unknown> | null;
}> {
  const { data: users, error: erroUsuarios } = await svc.auth.admin.listUsers();
  if (erroUsuarios) throw erroUsuarios;
  const dono = users?.users.find((u) => u.email === OWNER_EMAIL);
  if (!dono) {
    throw new Error(
      `esta suite APAGA dados da organizacao que resolver aqui, e nao achou o dono ` +
        `(${OWNER_EMAIL}). Sem saber em quem mexer, ela para — escolher "a primeira" ` +
        `ja custou o onboarding e a sessao de WhatsApp de uma instalacao real.`,
    );
  }

  const { data: vinculo, error: erroVinculo } = await svc
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", dono.id)
    .is("revoked_at", null)
    .limit(1)
    .single();
  if (erroVinculo) throw erroVinculo;

  const { data, error } = await svc
    .from("organizations")
    .select("id, display_name, timezone, onboarded_at, onboarding_state")
    .eq("id", (vinculo as { organization_id: string }).organization_id)
    .single();
  if (error) throw error;
  return data as never;
}

async function snap(page: Page, name: string): Promise<void> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

async function login(page: Page, password = OWNER_PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(OWNER_EMAIL);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.describe("J1 — onboarding do dono numa instalação fresca", () => {
  test.beforeAll(async () => {
    // Reset ao estado recém-bootstrapado (re-runs idempotentes): wizard zerado,
    // sem agente, sem canal, sem fatores MFA do dono.
    const org = await orgRow();
    await svc
      .from("organizations")
      .update({ onboarding_state: {}, onboarded_at: null })
      .eq("id", org.id);
    await svc.from("ai_agents").delete().eq("organization_id", org.id);
    await svc.from("channel_sessions").delete().eq("organization_id", org.id);

    const { data: users } = await svc.auth.admin.listUsers();
    const owner = users?.users.find((u) => u.email === OWNER_EMAIL);
    if (owner) {
      const { data: factors } = await svc.auth.admin.mfa.listFactors({ userId: owner.id });
      for (const f of factors?.factors ?? []) {
        await svc.auth.admin.mfa.deleteFactor({ id: f.id, userId: owner.id });
      }
    }
    if (fs.existsSync(OWNER_STATE_PATH)) fs.rmSync(OWNER_STATE_PATH);

    // WAHA: remove sessões org_* de rodadas anteriores (instalação fresca não
    // teria sessão FAILED pendurada; QR não re-renderiza sobre sessão morta).
    const wahaBase = process.env.WAHA_API_BASE_URL;
    const wahaKey = process.env.WAHA_API_KEY;
    if (wahaBase && wahaKey) {
      const res = await fetch(`${wahaBase}/api/sessions?all=true`, {
        headers: { "X-Api-Key": wahaKey },
      }).catch(() => null);
      const sessions = res?.ok ? ((await res.json()) as Array<{ name: string }>) : [];
      for (const s of sessions) {
        if (!s.name.startsWith("org_")) continue;
        await fetch(`${wahaBase}/api/sessions/${s.name}`, {
          method: "DELETE",
          headers: { "X-Api-Key": wahaKey },
        }).catch(() => null);
      }
    }
  });

  test("J1.2 senha errada → mensagem clara, sem stack", async ({ page }) => {
    await login(page, "senha-errada-123");
    await expect(page.getByText(/email ou senha incorretos/i)).toBeVisible({ timeout: 10_000 });
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/error:|stack|exception/i);
    await snap(page, "j1.2-senha-errada");
  });

  test("J1.1 login do bootstrap cai no wizard (org sem onboarded_at)", async ({ page }) => {
    const before = await orgRow();
    expect(before.onboarded_at).toBeNull();
    await login(page);
    await page.waitForURL(/\/onboarding/, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/onboarding\/welcome/);
    await snap(page, "j1.1-welcome");
  });

  test("J1.12 /app/inbox antes de concluir → volta pro onboarding", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding/);
    await page.goto("/app/inbox");
    await page.waitForURL(/\/onboarding/, { timeout: 15_000 });
  });

  test("J1.3 + J1.4 welcome: termos obrigatórios; salva nome/timezone e avança", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding\/welcome/);

    // J1.3 — sem aceitar os termos o botão fica desabilitado
    const continuar = page.getByRole("button", { name: /continuar/i });
    await expect(continuar).toBeDisabled();

    // J1.4 — preenche e avança
    await page.locator("#display_name").fill("Loja QA VPS");
    await page.locator('input[type="checkbox"]').check();
    await expect(continuar).toBeEnabled();
    await continuar.click();
    await page.waitForURL(/\/onboarding\/connect-whatsapp/, { timeout: 20_000 });
    await snap(page, "j1.4-connect-whatsapp");

    const org = await orgRow();
    expect(org.display_name).toBe("Loja QA VPS");
    expect(org.timezone).toBe("America/Sao_Paulo");
    expect((org.onboarding_state as { welcome?: unknown })?.welcome).toBeTruthy();
  });

  test("J1.5 WAHA ativo → QR code aparece de verdade", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding\/connect-whatsapp/);

    // O passo agora ABRE PERGUNTANDO como a pessoa já usa o número — o código
    // deixou de ser suposição. Escolher "leio um código com o celular" é o que
    // sobe a sessão; antes ela subia sozinha na montagem da tela, e quem tinha
    // conta oficial entrava pelo caminho errado sem ter sido perguntado.
    await page.getByTestId("forma-qr").locator("input").click();

    // sem banner de "WAHA não está configurado"
    // O nome do transporte saiu da tela: o aviso agora fala do "WhatsApp desta
    // instalação", que é como o dono chama a coisa.
    await expect(page.getByText(/ainda não subiu/i)).toHaveCount(0);

    // QR do proxy (poll de 3s até SCAN_QR_CODE) — imagem carregada de fato
    const qr = page.locator('img[src*="/whatsapp/qr"]');
    await expect(qr).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => qr.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await snap(page, "j1.5-qr-visivel");
  });

  test("J1.11 + J1.6 abandona e volta → retoma no step pendente; pular WhatsApp avança", async ({ page }) => {
    // sessão nova (simula fechar o browser): retoma exatamente no connect-whatsapp
    await login(page);
    await page.waitForURL(/\/onboarding\/connect-whatsapp/, { timeout: 20_000 });

    // Com Nuvemshop desabilitado (VPS fresca), pular o WhatsApp deve cair
    // DIRETO no setup de IA — nunca num step oculto (bug corrigido: as actions
    // redirecionavam hardcoded pro connect-nuvemshop).
    await page.getByRole("button", { name: /pular por enquanto/i }).click();
    await page.waitForURL(/\/onboarding\/setup-ai/, { timeout: 20_000 });
    await snap(page, "j1.6-setup-ai");
  });

  test("J1.7 setup IA: cria agente default e avança", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding\/setup-ai/);

    await page.locator("#name").fill("Tomik QA");
    await page.getByRole("button", { name: /criar e continuar/i }).click();
    // O wizard ganhou um passo entre treinar e chamar o time: ver o
    // funcionário atender. Terminar sem nunca tê-lo visto fazer nada era como
    // o onboarding entregava a pessoa num inbox vazio.
    await page.waitForURL(/\/onboarding\/testar/, { timeout: 20_000 });
    await snap(page, "j1.7-testar");

    // `eq(organization_id)` pela MESMA razão de `orgRow()` acima: sem ele, este
    // `select` lê os agentes de TODAS as organizações do banco, e o
    // `expect(length).toBe(1)` deixa de medir "o wizard criou um agente" e passa
    // a medir "o banco inteiro tem um agente" — que é falso em qualquer
    // instalação com uso, e vermelho por motivo que não é o desta jornada.
    const orgDoDono = await orgRow();
    const { data: agents } = await svc
      .from("ai_agents")
      .select("id, name, is_active, is_default, published_version_id")
      .eq("organization_id", orgDoDono.id);
    expect(agents?.length).toBe(1);
    expect(agents?.[0]).toMatchObject({ name: "Tomik QA", is_active: true, is_default: true });

    // A VERSÃO, e não só o agente. Este caso olhava apenas `ai_agents` — e foi
    // por isso que a regressão do provedor nasceu invisível: o agente ficava
    // bonito na tabela enquanto a versão publicada apontava para uma empresa de
    // IA que a instalação não contratou, morrendo em toda mensagem.
    const { data: versoes } = await svc
      .from("ai_agent_versions")
      .select("provider, model, status, channel_session_id")
      .eq("agent_id", agents?.[0]?.id ?? "");
    expect(versoes?.length).toBe(1);
    expect(versoes?.[0]?.status).toBe("published");

    // E o provedor da versão é o MESMO que a instalação escolheu. Comparar com
    // uma string fixa aqui não provaria nada: o teste passaria justamente na
    // instalação Anthropic, que é a única em que o defeito não aparecia.
    // A SEGUNDA instância de "a primeira organização" neste mesmo arquivo. Aqui
    // ela não apaga nada — faz pior de um jeito silencioso: `escolhido` vira o
    // provedor de OUTRA organização, e a asserção abaixo passa ou reprova sem
    // relação com a instalação que o wizard acabou de configurar.
    const { data: org } = await svc
      .from("organizations")
      .select("settings")
      .eq("id", orgDoDono.id)
      .maybeSingle();
    const escolhido =
      (org?.settings as { llm?: { provider?: string } } | null)?.llm?.provider ?? "anthropic";
    expect(versoes?.[0]?.provider).toBe(escolhido);

    // O modelo veio do catálogo DAQUELE provedor — nunca um id emprestado.
    const { data: curado } = await svc
      .from("ai_models")
      .select("model_id")
      .eq("provider", escolhido)
      .eq("is_default_for_provider", true)
      .is("deprecated_at", null)
      .limit(1)
      .maybeSingle();
    expect(versoes?.[0]?.model).toBe(curado?.model_id);
  });

  test("J1.24 ver ele atender: o wizard não termina sem mostrar o funcionário", async ({ page }) => {
    // O passo que faltava. O onboarding entregava a pessoa num inbox vazio
    // ("Sem conversas por aqui") logo depois de ela montar um funcionário que
    // nunca tinha visto fazer nada — e um erro de chave ou de saldo só
    // apareceria quando um cliente de verdade escrevesse.
    await login(page);
    await page.waitForURL(/\/onboarding\/testar/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /veja ele atender/i })).toBeVisible();

    // O agente desta jornada nasceu SEM canal (o WhatsApp foi pulado em J1.6),
    // então ficou rascunho — e rascunho não responde. A tela tem de dizer isso
    // em vez de oferecer um ensaio que nunca funcionaria.
    await expect(page.getByText(/rascunho/i)).toBeVisible();
    await snap(page, "j1.24-testar-rascunho");

    await page.getByRole("button", { name: /^continuar$/i }).click();
    await page.waitForURL(/\/onboarding\/invite-team/, { timeout: 20_000 });

    const org = await orgRow();
    expect((org.onboarding_state as { teste?: unknown })?.teste).toBeTruthy();
  });

  test("J1.8 convite SEM Resend: a UI não pode mentir que enviou email", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding\/invite-team/);

    await page.locator("#emails").fill("atendente@qa.local");
    await page.getByRole("button", { name: /enviar convites/i }).click();

    // Honestidade: sem RESEND_API_KEY nenhum email sai. A UI deve dizer isso
    // e oferecer o link de aceite copiável (nunca redirecionar em silêncio).
    await expect(page.getByText(/não está configurado neste servidor/i)).toBeVisible({
      timeout: 15_000,
    });
    const acceptUrl = (
      await page.locator("code", { hasText: /team\/accept-invite/ }).first().innerText()
    ).trim();
    expect(acceptUrl).toMatch(/\/team\/accept-invite\/.+/);
    fs.writeFileSync(
      path.join(process.cwd(), ".e2e-invite-url.json"),
      JSON.stringify({ email: "atendente@qa.local", accept_url: acceptUrl }, null, 2),
    );
    await snap(page, "j1.8-convite-sem-resend");

    // e o wizard segue em frente conscientemente
    await page.getByRole("button", { name: /^continuar$/i }).click();
    await page.waitForURL(/\/onboarding\/done/, { timeout: 20_000 });
  });

  test("J1.9 done → onboarded_at setado e cai no inbox", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding\/done/);
    await snap(page, "j1.9-done-recap");

    await page.getByRole("button", { name: /começar a usar/i }).click();
    await page.waitForURL(/\/app\/inbox/, { timeout: 30_000 });

    const org = await orgRow();
    expect(org.onboarded_at).not.toBeNull();
  });

  test("J1.10 verificação em duas etapas: ativa pela tela e VÊ os códigos de recuperação", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/app\//, { timeout: 30_000 });

    // ⚠️ ESTE CASO MUDOU DE PORTA, e a mudança é o ponto. Ele testava o
    // BLOQUEADOR não-dismissível que aparecia sozinho para todo admin — e era
    // exatamente o que fazia a instalação fresca receber um sétimo passo logo
    // depois do wizard, sem aviso. A verificação virou opcional; o cadastro
    // agora começa em Configurações › Segurança, por escolha de quem entra.
    //
    // O que este caso continua guardando é o que importava nele: o fluxo de
    // enroll leva até os CÓDIGOS DE RECUPERAÇÃO (a regressão que o nome antigo
    // citava). Perder isso seria trocar uma tela por nenhuma.
    await page.goto("/app/settings/security");
    await expect(page.getByText("Desativada")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /^ativar$/i }).click();

    await expect(
      page.getByRole("heading", { name: /verificação em duas etapas/i }),
    ).toBeVisible({ timeout: 20_000 });
    await snap(page, "j1.10-mfa-ativar");

    await page.getByRole("button", { name: /iniciar configuração/i }).click();
    await expect(
      page.locator('img[alt="QR code para configurar autenticador"]'),
    ).toBeVisible({ timeout: 20_000 });

    // secret manual (o que um leigo digitaria no app autenticador)
    await page.getByText(/não consegue escanear/i).click();
    const secret = (await page.locator("code").innerText()).trim();
    expect(secret.length).toBeGreaterThan(15);
    fs.writeFileSync(
      OWNER_STATE_PATH,
      JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp_secret: secret }, null, 2),
    );

    // digita o código com retry na virada da janela TOTP
    for (let attempt = 0; attempt < 3; attempt++) {
      if (msUntilNextTotpWindow() < 4_000) await page.waitForTimeout(msUntilNextTotpWindow() + 300);
      await page.locator('input[aria-label="Dígito 1"]').click();
      await page.keyboard.type(generateTotp(secret), { delay: 40 });
      try {
        await expect(page.getByRole("heading", { name: /códigos de recuperação/i })).toBeVisible({
          timeout: 8_000,
        });
        break;
      } catch {
        if (attempt === 2) throw new Error("MFA enroll não chegou aos recovery codes");
        // código recusado (janela virou) → limpa e tenta de novo
        await page.locator('input[aria-label="Dígito 1"]').click();
        for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
      }
    }

    // O BUG: a revalidação do server action desmontava o gate e o usuário
    // caía no inbox sem ver estes códigos. Prova de que a tela persiste com os
    // 10 códigos + ações de salvar (grid font-mono no RecoveryCodesPanel).
    await expect(page.getByText(/salve esses 10 códigos/i)).toBeVisible();
    const codes = page.locator("div.font-mono");
    await expect(codes).toHaveCount(10);
    await expect(page.getByRole("button", { name: /copiar todos/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /baixar \.txt/i })).toBeVisible();
    await snap(page, "j1.10-recovery-codes");

    await page.getByText(/salvei meus códigos/i).click();
    await page.getByRole("button", { name: /^concluir$/i }).click();

    // gate some após reload; shell do app visível
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { name: /verificação em duas etapas/i }),
    ).toHaveCount(0, { timeout: 20_000 });
    await snap(page, "j1.10-inbox-livre");
  });

  test("J1.13 wizard não reabre depois de concluído", async ({ page }) => {
    // agora o login do dono exige TOTP
    const state = JSON.parse(fs.readFileSync(OWNER_STATE_PATH, "utf8")) as { totp_secret: string };
    await login(page);
    await page.waitForURL(/\/login\/mfa/, { timeout: 20_000 });
    if (msUntilNextTotpWindow() < 4_000) await page.waitForTimeout(msUntilNextTotpWindow() + 300);
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(state.totp_secret), { delay: 40 });
    await page.waitForURL(/\/app\//, { timeout: 30_000 });

    await page.goto("/onboarding");
    await page.waitForURL(/\/app\/inbox/, { timeout: 15_000 });
  });
});
