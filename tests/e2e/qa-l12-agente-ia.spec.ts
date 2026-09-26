/**
 * QA VISUAL DO LOTE 12 — #942, a ferramenta que CONFERE e MARCA na mesma chamada.
 *
 * ⚠️ O COMPORTAMENTO (o agente responder e reservar numa conversa) exige chave de
 * IA, e esta instalação não tem nenhuma — é o estado de um primeiro deploy, de
 * propósito. O que a tela responde, e só ela, é a metade de CONFIGURAÇÃO:
 * a capacidade existe, tem nome que um leigo entende, e o estado em que ela
 * NASCE — que é o que decide se a instalação de quem já tinha o agente recebe a
 * novidade ou não.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test } from "./helpers/test";

import { admin, captura, creds, expect, registra, type Creds } from "./qa-l12-comum";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const ROTULO = "Ver se o horário está livre e já marcar";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

/** O `admin` da organização de teste tem TOTP; sem ele o login para em /login/mfa. */
async function loginComTotp(
  page: import("@playwright/test").Page,
  email: string,
  senha: string,
): Promise<void> {
  const segredo = (
    JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as {
      admin_totp?: { secret: string };
    }
  ).admin_totp?.secret;
  if (!segredo) throw new Error("sem admin_totp em .e2e-creds.json");

  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click({ timeout: 15_000 });
  await page.waitForURL(/\/login\/mfa/, { timeout: 90_000 });

  const digito1 = page.locator('input[aria-label="Dígito 1"]');
  const recusa = page.locator("form").getByRole("alert");
  for (let i = 0; i < 3; i++) {
    if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    await digito1.click({ timeout: 15_000 });
    await page.keyboard.type(generateTotp(segredo), { delay: 40 });
    const desfecho = await Promise.race([
      page.waitForURL(/\/app\//, { timeout: 60_000 }).then(() => "entrou" as const, () => "nada" as const),
      recusa.waitFor({ state: "visible", timeout: 60_000 }).then(() => "recusado" as const, () => "nada" as const),
    ]);
    if (desfecho === "entrou") return;
    registra(`[ambiente] MFA de ${email}: tentativa ${i + 1} = ${desfecho}`);
    await page.waitForTimeout(msUntilNextTotpWindow() + 200);
  }
  throw new Error(`MFA falhou para ${email} (url=${page.url()})`);
}

test.describe("Lote 12 — #942 a capacidade na tela do agente", () => {
  test.describe.configure({ timeout: 420_000 });
  let c: Creds;
  let agenteId = "";

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    c = creds();
    for (let i = 1; i <= 6 && !agenteId; i++) {
      const { data, error } = await admin
        .from("ai_agents")
        .select("id, name, is_active, published_version_id")
        .eq("organization_id", c.org_id)
        .limit(1)
        .maybeSingle();
      if (error) {
        registra(`[ambiente] leitura de ai_agents: tentativa ${i} caiu (${error.message})`);
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      agenteId = (data as { id: string } | null)?.id ?? "";
      registra(`#942 · agente da org = ${JSON.stringify(data)}`);
    }
  });

  test("a capacidade aparece com nome de gente, e o estado em que ela nasce fica registrado", async ({
    page,
  }) => {
    expect(agenteId, "a organização de teste tem um agente padrão").toBeTruthy();
    // ⚠️ TEM DE SER `admin`. Medido antes, como manager: a caixa da capacidade
    // aparece e vem `disabled` — `app/app/ai/agents/[id]/page.tsx:68` faz
    // `readOnly = ROLE_RANK[role] < ROLE_RANK.admin`. Medir o estado da
    // capacidade com um papel que não pode escrever mediria o papel, não o lote.
    await loginComTotp(page, c.users.admin!.email, c.password);
    await page.goto(`/app/ai/agents/${agenteId}`);
    await page.waitForLoadState("networkidle").catch(() => {});

    const secao = page.getByText("O que o agente pode fazer");
    await expect(secao).toBeVisible({ timeout: 60_000 });

    // O caminho padrão da tela é o PACOTE. A capacidade individual mora atrás
    // de "Escolher uma a uma (modo avançado)" — um leigo clicaria aqui.
    const pacote = page.locator('[data-testid="pacote-vender"]');
    registra(`#942 · o pacote "Vender e mover o funil" está na tela = ${await pacote.count()}`);
    if (await pacote.count()) {
      registra(`#942 · texto do pacote = ${JSON.stringify((await pacote.innerText()).replace(/\n/g, " | "))}`);
    }
    await captura(page, "942-00-pacotes-do-agente");

    const avancado = page.locator('[data-testid="toggle-avancado"]');
    await expect(avancado).toBeVisible({ timeout: 30_000 });
    registra(`#942 · rótulo do avançado = "${await avancado.innerText()}"`);
    await avancado.click();

    const caixa = page.getByRole("checkbox", { name: ROTULO });
    const quantas = await caixa.count();
    registra(`#942 · a caixa "${ROTULO}" existe na tela = ${quantas}`);
    expect(quantas, "a capacidade nova tem de estar na tela de capacidades").toBeGreaterThan(0);

    // É `<input type="checkbox">` nativo: quem responde é `checked`, não
    // `aria-checked` — que vem `null` e leria como "desligada" por acidente.
    const marcada = await caixa.first().isChecked();
    registra(`#942 · a capacidade está ligada nesta instalação = ${marcada}`);
    const consumo = await page.locator('[data-testid="consumo-teto"]').innerText().catch(() => "?");
    registra(`#942 · consumo do teto do agente semeado = "${consumo}"`);
    await captura(page, "942-01-capacidade-na-tela-do-agente");

    const descricao = await page
      .getByText(/Confere o horário que o cliente pediu/)
      .count();
    registra(`#942 · a tela explica o que a capacidade faz = ${descricao}`);

    // Ligar e publicar — a metade que a tela responde.
    const item = page.locator('[data-testid="capacidade-crm_find_and_book_appointment"]');
    registra(
      `#942 · data-marcada=${await item.getAttribute("data-marcada")} data-risco=${await item.getAttribute("data-risco")} · caixa desabilitada = ${await caixa.first().isDisabled()}`,
    );

    if (!marcada) {
      // Curto de propósito: o que interessa é MEDIR se o clique liga, e um
      // clique que não completa é dado, não motivo para a rodada parar.
      try {
        await caixa.first().click({ timeout: 15_000 });
        registra(`#942 · depois do clique, a capacidade está ligada = ${await caixa.first().isChecked()}`);
      } catch (err) {
        registra(`#942 · o clique na capacidade NÃO completou: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
      await captura(page, "942-02-capacidade-ligada");
    }

    registra(
      "#942 · NÃO MEDIDO: o agente conferir e reservar numa conversa de verdade. " +
        "Falta chave de IA (AI_GATEWAY_API_KEY/ANTHROPIC_API_KEY/OPENROUTER_API_KEY) — " +
        "sem ela o motor pula toda resposta com reason='ai_gateway_key_missing', que é o " +
        "estado declarado desta instalação.",
    );
  });
});
