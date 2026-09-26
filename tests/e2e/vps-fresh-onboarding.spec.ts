/**
 * J1 — Onboarding do primeiro usuário numa instalação FRESCA (estilo VPS).
 *
 * Pré-condições (ambiente que simula o kit self-host):
 *   - banco zerado do baseline.sql (Supabase local pg17)
 *   - primeiro usuário criado via scripts/bootstrap-owner.ts (como o install.sh)
 *   - WAHA ativo, Redis local, RESEND_API_KEY VAZIO (realidade da VPS fresca)
 *   - SEM chave de IA na instalação (o install.sh deixa pular com Enter; o
 *     .env.e2e não traz nenhuma) — J1.7 e J1.24 afirmam o agente em rascunho
 *   - app em produção (next build + next start) na E2E_PORT
 *
 * Casos: J1.1–J1.13 do docs/testing/user-journey-map.md. Tudo pelo frontend;
 * banco só para PROVAR estado (nunca para atalhar a jornada).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { PROVEDOR_POR_ID } from "@/lib/ai/pontos/provedores";

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
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
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

  test("J1.7 setup IA sem chave: cria o agente como rascunho, diz o que falta e deixa seguir", async ({ page }) => {
    // ⚠️ ESTE CASO MUDOU DE DESFECHO, e a razão é o ambiente, não o produto.
    // Ele afirmava "cria, PUBLICA e vai para /onboarding/testar" — o que só é
    // verdade numa instalação que já tem chave de IA. O `install.sh` deixa pular
    // a chave com Enter, e o `.env.e2e` (o ambiente desta suíte, local e CI) não
    // traz nenhuma. Medido no run 35150134046 (parte 4 do PR #983, a primeira
    // vez que esta spec rodou no CI): o clique em "Criar e continuar" devolve
    // `publish_blocked_by: "chave"`, a tela mostra o aviso de rascunho com
    // "Continuar sem publicar", e o `waitForURL(/testar/)` estourou 20s parado
    // nesse aviso. O J1.24 logo abaixo já afirmava "rascunho" na tela de testar
    // — os dois casos descreviam instalações diferentes.
    await login(page);
    await page.waitForURL(/\/onboarding\/setup-ai/);

    await page.locator("#name").fill("Tomik QA");
    await page.getByRole("button", { name: /criar e continuar/i }).click();

    // `eq(organization_id)` pela MESMA razão de `orgRow()` acima: sem ele, este
    // `select` lê de TODAS as organizações do banco, e as asserções deixam de
    // medir a instalação que o wizard acabou de configurar.
    const orgDoDono = await orgRow();
    const { data: org } = await svc
      .from("organizations")
      .select("settings")
      .eq("id", orgDoDono.id)
      .maybeSingle();
    const escolhido =
      (org?.settings as { llm?: { provider?: string } } | null)?.llm?.provider ?? "anthropic";

    // O aviso nomeia a empresa de IA que a INSTALAÇÃO escolheu. É o que sobra,
    // sem chave, da guarda da regressão do provedor: o passo publicava
    // "anthropic" literal para quem tinha escolhido outra, e o `provider` deste
    // aviso sai da mesma leitura de `settings.llm.provider` que a versão usaria.
    // Comparar com uma string fixa não provaria nada — passaria justamente na
    // instalação Anthropic, a única em que o defeito não aparecia.
    const aviso = page.getByRole("alert").filter({ hasText: /rascunho/i });
    await expect(aviso).toBeVisible({ timeout: 20_000 });
    await expect(aviso).toContainText(PROVEDOR_POR_ID.get(escolhido)?.rotulo ?? escolhido);
    await snap(page, "j1.7-sem-chave-rascunho");

    // Sem esta saída o passo é um beco: o diagnóstico está certo e nenhum botão.
    await aviso.getByRole("button", { name: /continuar sem publicar/i }).click();
    // Depois de treinar vem "Onde ele organiza" (J1.26, `/onboarding/funil`),
    // e só então "Ver ele atender". Medido no run 35401941259 (parte 4): o
    // clique avançou para `/onboarding/funil` e este `waitForURL` esperava
    // `/testar`, o passo seguinte. O produto seguiu; a spec é que pulava um passo.
    await page.waitForURL(/\/onboarding\/funil/, { timeout: 20_000 });
    await snap(page, "j1.7-funil");

    const { data: agents } = await svc
      .from("ai_agents")
      .select("id, name, is_active, is_default, published_version_id")
      .eq("organization_id", orgDoDono.id);
    expect(agents?.length).toBe(1);
    expect(agents?.[0]).toMatchObject({
      name: "Tomik QA",
      is_active: true,
      is_default: true,
      published_version_id: null,
    });

    // A VERSÃO, e não só o agente: sem chave utilizável nenhuma é gravada. Uma
    // versão "publicada" aqui seria o agente que morre em toda mensagem pedindo
    // uma chave que a instalação nunca teve.
    const { data: versoes } = await svc
      .from("ai_agent_versions")
      .select("id")
      .eq("agent_id", agents?.[0]?.id ?? "");
    expect(versoes?.length).toBe(0);

    // O passo aconteceu mesmo sem publicar — é o que faz o wizard seguir em
    // vez de reabrir "Treine seu funcionário".
    const depois = await orgRow();
    expect(
      (depois.onboarding_state as { ai?: { agent_id?: string } } | null)?.ai?.agent_id,
    ).toBe(agents?.[0]?.id);
  });

  test("J1.26 onde ele organiza: sem funcionário no ar, oferece um quadro pronto e deixa seguir", async ({ page }) => {
    // Numa instalação sem chave de IA o agente ficou rascunho (J1.7), então a
    // sugestão de quadro, que sai do MESMO modelo que vai atender, não tem a
    // quem pedir. O passo não pode virar beco: diz o porquê, começa de um
    // modelo pronto e deixa seguir.
    await login(page);
    await page.waitForURL(/\/onboarding\/funil/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /onde ele organiza seus clientes/i })).toBeVisible();
    await expect(page.getByText(/ainda não está no ar/i)).toBeVisible();
    await expect(page.getByText(/isso não trava nada/i)).toBeVisible();

    // O que a tela mostra é o que tem de ser gravado: lido da própria tela, não
    // de uma lista fixa, para o caso valer com qualquer modelo pronto.
    const nomeDoQuadro = await page.getByLabel("Nome do quadro").inputValue();
    const colunas = await page.getByLabel(/^Nome da coluna \d+$/).evaluateAll((els) =>
      els.map((e) => (e as HTMLInputElement).value),
    );
    expect(nomeDoQuadro.trim()).not.toBe("");
    expect(colunas.length).toBeGreaterThan(0);
    await snap(page, "j1.26-funil-sem-ia");

    await page.getByRole("button", { name: /usar este quadro/i }).click();
    await page.waitForURL(/\/onboarding\/testar/, { timeout: 20_000 });

    const org = await orgRow();
    const funil = (org.onboarding_state as { funil?: { pipeline_id?: string } } | null)?.funil;
    expect(funil?.pipeline_id, "o passo do quadro ficou registrado").toBeTruthy();
    const { data: pipeline } = await svc
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", org.id)
      .eq("id", funil?.pipeline_id ?? "")
      .maybeSingle();
    expect(pipeline?.name).toBe(nomeDoQuadro.trim());
    const { data: etapas } = await svc
      .from("crm_stages")
      .select("name")
      .eq("organization_id", org.id)
      .eq("pipeline_id", funil?.pipeline_id ?? "");
    for (const coluna of colunas) {
      expect(etapas?.map((e) => e.name), `a coluna "${coluna}" da tela foi gravada`).toContain(coluna.trim());
    }
  });

  test("J1.24 ver ele atender: o wizard não termina sem mostrar o funcionário", async ({ page }) => {
    // O passo que faltava. O onboarding entregava a pessoa num inbox vazio
    // ("Sem conversas por aqui") logo depois de ela montar um funcionário que
    // nunca tinha visto fazer nada — e um erro de chave ou de saldo só
    // apareceria quando um cliente de verdade escrevesse.
    await login(page);
    await page.waitForURL(/\/onboarding\/testar/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /veja ele atender/i })).toBeVisible();

    // O agente desta jornada ficou rascunho — sem versão, porque a instalação
    // não tem chave de IA (ver J1.7; o canal existe desde o QR de J1.5) — e
    // rascunho não responde. A tela tem de dizer isso em vez de oferecer um
    // ensaio que nunca funcionaria.
    //
    // A asserção mora no aviso (`role="status"`), e não em "a palavra aparece
    // em algum lugar da página": no run 35407985023 o `getByText(/rascunho/i)`
    // casou DOIS nós — o `<strong>` da frase e o parágrafo que explica —, os
    // dois certos, e o strict mode reprovou a sonda, não o produto. Prender o
    // aviso e exigir as DUAS frases é mais estreito do que era antes: diz o
    // ESTADO (não foi para o ar) e a CONSEQUÊNCIA (não há o que ensaiar).
    const aviso = page.getByRole("status").filter({ hasText: /rascunho/i });
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText(/ainda não foi para o ar/i);
    await expect(aviso).toContainText(/não responde mensagem/i);
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
    //
    // A frase que este caso procurava ("não está configurado neste servidor")
    // não existe mais no produto — `git grep` devolve zero. O texto de hoje é
    // o do bloco âmbar de `app/onboarding/invite-team/_form.tsx:109`, e a tela
    // ainda diz a verdade: medido no job 105816595263 (parte 4), ela mostra
    // "Esta instalação não envia e-mail" com o link e o botão de copiar.
    await expect(page.getByText(/não envia e-mail/i).first()).toBeVisible({
      timeout: 15_000,
    });
    // O nome deste caso é "a UI não pode MENTIR que enviou": o controle
    // negativo é o que o torna verdade, e ele faltava. Nenhuma frase de envio
    // bem-sucedido pode aparecer numa instalação sem serviço de e-mail.
    await expect(page.getByText(/convites? enviad/i)).toHaveCount(0);
    // E a pessoa convidada aparece nominalmente ao lado do link dela, senão
    // "copie o link" não diz de quem é o link.
    await expect(page.getByText("atendente@qa.local").first()).toBeVisible();
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

    // O título do DIÁLOGO, e não "o texto aparece em algum lugar": a página de
    // Segurança tem a seção "Verificação em duas etapas" e o diálogo tem
    // "Configure a verificação em duas etapas". Medido no run da parte 4 (job
    // 105825863584): o `getByRole('heading', /verificação em duas etapas/i)`
    // casava os DOIS e o strict mode reprovava — os dois certos, a sonda é que
    // não dizia qual. Prender no `#mfa-title` é o que prova que o diálogo ABRIU.
    await expect(page.locator("#mfa-title")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#mfa-title")).toHaveText(/verificação em duas etapas/i);
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
        // MESMA ARMADILHA DO FECHO, e aqui ela desligava o retry: a página de
        // Segurança tem a seção "Códigos de recuperação" impressa desde antes
        // do enroll (`_client.tsx:176`, fora de condicional), então
        // `getByRole('heading', /códigos de recuperação/i)` já valia ANTES de
        // o modal chegar ao passo dos códigos — e passava na hora, mesmo com o
        // TOTP recusado. Medido: com os dois títulos no DOM o strict mode
        // reprova (`resolved to 2 elements`), então o verde só podia vir do
        // casamento único, o da página. Resultado: este `for` nunca dava a
        // segunda volta e a virada da janela TOTP caía lá embaixo, como falha
        // confusa. `#mfa-title` é o título do passo ATUAL do modal (intro,
        // scan e codes são ramos exclusivos), então prendê-lo aqui é o que
        // pergunta de fato "o modal avançou?".
        await expect(page.locator("#mfa-title")).toHaveText(/códigos de recuperação/i, {
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

    // ⚠️ SEGUNDA HERANÇA DA MESMA MUDANÇA DE PORTA. Cobrar que o título
    // "Verificação em duas etapas" SUMA valia quando o cadastro vinha do
    // bloqueador de tela cheia e terminar caía no inbox — daí o nome
    // `j1.10-inbox-livre`. Hoje o fluxo começa e termina em Configurações ›
    // Segurança, e essa página imprime a seção "Verificação em duas etapas"
    // o tempo todo (`app/app/settings/security/_client.tsx:78`, fora de
    // qualquer condicional). Medido no job 105829755207: `44 × locator
    // resolved to 1 element` — o único casamento era essa seção, com o
    // diálogo já fechado e o selo em "Ativada". O vermelho media a mudança de
    // porta, não regressão.
    //
    // O que prova o fim do fluxo HOJE são duas coisas, e a segunda é a que
    // não deixa o caso passar por acidente:
    await page.waitForLoadState("networkidle");
    // 1) o DIÁLOGO fechou — `#mfa-title` é o título dos três passos do modal
    //    (intro, QR, códigos), então count 0 é o modal inteiro desmontado;
    await expect(page.locator("#mfa-title")).toHaveCount(0, { timeout: 20_000 });
    // 2) CONTROLE NEGATIVO — o estado MUDOU no servidor. Se o enroll não
    //    persistisse, ou se "Concluir" desfizesse o cadastro, a página
    //    recarregada voltaria exatamente ao estado em que este caso COMEÇOU
    //    (selo "Desativada" + botão "Ativar") e o modal também estaria
    //    fechado — ou seja, só a asserção (1) passaria feliz. Esta reprova.
    await expect(page.getByText("Ativada", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^desligar$/i })).toBeVisible();
    await expect(page.getByText("Desativada", { exact: true })).toHaveCount(0);
    // e a pessoa não ficou presa: o shell do app respondeu ao reload (se a
    // sessão tivesse caído no enroll, aqui seria a tela de login).
    await expect(page.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
    await snap(page, "j1.10-verificacao-ativada");
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
