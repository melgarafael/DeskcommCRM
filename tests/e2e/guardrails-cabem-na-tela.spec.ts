/**
 * GUARDRAILS DO AGENTE DE VOZ CABEM NA TELA (#5221) — medido por geometria.
 *
 * Na tela de um agente de voz, a linha «Tipo do novo guardrail» + «Adicionar
 * guardrail» era um flex sem `min-w-0` no filho `flex-1`: em flex o item tem
 * `min-width: auto`, então o seletor não encolhia abaixo do próprio conteúdo e
 * empurrava o botão para fora da tela a 375 px. A página inteira rolava para o
 * lado (`main.overflow-auto` com `scrollWidth 452` contra `clientWidth 375`) e
 * cada clique deslocava a rolagem.
 *
 * O que esta spec mede, com a aba VAZIA e depois com uma regra adicionada:
 *
 * (a) o contêiner que rola não transborda — `scrollWidth <= clientWidth`;
 * (b) o botão «Adicionar guardrail» termina dentro da tela
 *     (`getBoundingClientRect().right <= 375`).
 *
 * As duas reprovam no código anterior ao conserto (452/375 e right ≈ 438) e
 * passam depois dele. A régua é a mesma de `equipe-no-celular.spec.ts`:
 * `getBoundingClientRect`, não impressão de tela.
 *
 * No fim, a 1280 px, a mesma linha tem de continuar em UMA linha só: o fundo do
 * seletor e o do botão ficam alinhados (é `items-end`), o que deixa de valer se
 * a linha quebrar.
 *
 * ═══ O que esta spec NÃO cobre, de propósito ════════════════════════════════
 *
 * Safari do iPhone e teclado virtual aberto: é Chromium de computador com
 * `isMobile` + `hasTouch`, EMULADO. Larguras intermediárias entre 375 e 1280
 * também não são varridas aqui (a medição pontual de 320 px fica no PR).
 *
 * ═══ Dados ══════════════════════════════════════════════════════════════════
 *
 * Organização e usuário PRÓPRIOS, semeados pelo service role e apagados no fim:
 * o banco do e2e é compartilhado e esta spec não toca o agente de ninguém. O
 * usuário nasce por `auth.admin.createUser` com senha, então não há segundo
 * fator — o `loginComoAdmin` do seed não serve aqui porque o admin do seed pede
 * TOTP e esta medição não precisa dele.
 *
 * O agente é de VOZ (`channel = 'voice'`): é o ramo que renderiza
 * `components/ai/AgentEditor.tsx`, onde mora a linha dos guardrails.
 */
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { test, expect, type Locator, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const LARGURA = 375;
const LARGURA_DESKTOP = 1280;

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

const senha = `Local-${randomUUID()}!`;
const semente = { usuario: "", email: "", org: "", agente: "" };

test.use({
  viewport: { width: LARGURA, height: 812 },
  hasTouch: true,
  isMobile: true,
  locale: "pt-BR",
});
test.describe.configure({ timeout: 180_000 });

async function insere(tabela: string, valores: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valores).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

test.beforeAll(async () => {
  const email = `guardrails-na-tela-${randomUUID()}@invariant.test`;
  const criado = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (criado.error || !criado.data.user) throw criado.error ?? new Error("sem usuário");
  semente.usuario = criado.data.user.id;
  semente.email = email;

  const org = await insere("organizations", {
    slug: `guardrails-na-tela-${randomUUID()}`,
    legal_name: "Guardrails na tela",
    display_name: "Guardrails na tela",
    onboarded_at: new Date().toISOString(),
  });
  semente.org = org;
  await insere("user_organizations", {
    organization_id: org,
    user_id: semente.usuario,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });

  semente.agente = await insere("ai_agents", {
    organization_id: org,
    name: "Agente de voz da recepção",
    kind: "mcp_agent",
    channel: "voice",
    system_prompt: "Atenda com objetividade.",
    model: "claude-sonnet-4-6",
  });
});

test.afterAll(async () => {
  const falhas: string[] = [];
  // Filhos antes dos pais: as versões do agente seguram a organização.
  for (const [tabela, coluna, valor] of [
    ["ai_agents", "organization_id", semente.org],
    ["organizations", "id", semente.org],
  ] as Array<[string, string, string]>) {
    if (!valor) continue;
    const { error } = await db.from(tabela).delete().eq(coluna, valor);
    if (error) falhas.push(`${tabela}: ${error.message}`);
  }
  if (semente.usuario) {
    const u = await db.auth.admin.deleteUser(semente.usuario);
    if (u.error) falhas.push(`usuário: ${u.error.message}`);
  }
  if (falhas.length > 0) throw new Error(`a limpeza deixou sobra no banco — ${falhas.join("; ")}`);
});

function caixa(alvo: Locator) {
  return alvo.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
}

/** O que rola para o lado dentro do `<main>` do AppShell (o body não enxerga). */
async function rolagemDoMain(page: Page) {
  return page.locator("main").first().evaluate((m) => ({
    scrollWidth: m.scrollWidth,
    clientWidth: m.clientWidth,
    transbordo: m.scrollWidth - m.clientWidth,
  }));
}

async function entrar(page: Page) {
  await page.goto("/login");
  await page.locator("#email").fill(semente.email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

test("o «Adicionar guardrail» do agente de voz cabe nos 375 px, com a aba vazia e com uma regra", async ({
  page,
}) => {
  await entrar(page);
  await page.goto(`/app/ai/agents/${semente.agente}`);

  await page.getByRole("tab", { name: "Guardrails" }).click();
  const painel = page.getByRole("tabpanel", { name: "Guardrails" });
  await expect(painel).toBeVisible({ timeout: 30_000 });

  const adicionar = painel.getByRole("button", { name: "Adicionar guardrail" });
  await expect(adicionar).toBeVisible();

  await test.step("aba vazia: a página não rola para o lado e o botão termina na tela", async () => {
    // A aba abre no estado de fábrica do agente semeado: nenhuma regra.
    await expect(painel.getByText(/Nenhum guardrail definido/)).toBeVisible();

    const rolagem = await rolagemDoMain(page);
    const botao = await caixa(adicionar);
    console.log(
      `[#5221] aba vazia: main.scrollWidth=${rolagem.scrollWidth} main.clientWidth=${rolagem.clientWidth} ` +
        `botão.right=${botao.right.toFixed(2)}`,
    );
    expect(rolagem.transbordo, "o <main> rola para o lado com a aba vazia").toBeLessThanOrEqual(0);
    expect(botao.right, "o botão «Adicionar guardrail» passa da borda direita").toBeLessThanOrEqual(LARGURA);
  });

  await test.step("com uma regra: o item novo não empurra a linha para fora", async () => {
    await adicionar.tap();
    // O estado local muda no clique; a regra nasce com o tipo padrão do seletor.
    await expect(painel.getByText("Bloqueio de saída por regex").first()).toBeVisible();

    const rolagem = await rolagemDoMain(page);
    const botao = await caixa(adicionar);
    console.log(
      `[#5221] com uma regra: main.scrollWidth=${rolagem.scrollWidth} main.clientWidth=${rolagem.clientWidth} ` +
        `botão.right=${botao.right.toFixed(2)}`,
    );
    expect(rolagem.transbordo, "o <main> rola para o lado com uma regra").toBeLessThanOrEqual(0);
    expect(botao.right, "o botão «Adicionar guardrail» passa da borda direita").toBeLessThanOrEqual(LARGURA);
  });

  await test.step("a 1280 px a linha continua em uma linha só", async () => {
    await page.setViewportSize({ width: LARGURA_DESKTOP, height: 900 });
    const seletor = painel.getByRole("combobox").first();
    await expect(seletor).toBeVisible();
    const [s, b] = [await caixa(seletor), await caixa(adicionar)];
    // `items-end`: se a linha quebrasse, o fundo do botão cairia uma linha
    // inteira abaixo do fundo do seletor.
    expect(Math.abs(s.bottom - b.bottom), "a linha dos guardrails quebrou a 1280 px").toBeLessThanOrEqual(1);
    expect(b.right, "o botão passa da borda direita a 1280 px").toBeLessThanOrEqual(LARGURA_DESKTOP);
  });

  // 320 px não faz parte do defeito relatado, mas é a largura de celular menor
  // que ainda aparece por aí: se a linha voltar a transbordar é aqui que se vê.
  await test.step("320 px: a mesma régua, sem afrouxar", async () => {
    await page.setViewportSize({ width: 320, height: 800 });
    const seletor = painel.getByRole("combobox").first();
    await expect(seletor).toBeVisible();
    const rolagem = await rolagemDoMain(page);
    const botao = await caixa(adicionar);
    console.log(
      `[#5221] 320px: main.scrollWidth=${rolagem.scrollWidth} main.clientWidth=${rolagem.clientWidth} ` +
        `botão.right=${botao.right.toFixed(2)}`,
    );
    expect(rolagem.transbordo, "o <main> rola para o lado a 320 px").toBeLessThanOrEqual(0);
    expect(botao.right, "o botão passa da borda direita a 320 px").toBeLessThanOrEqual(320);
  });
});
