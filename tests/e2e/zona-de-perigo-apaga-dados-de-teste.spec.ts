/**
 * ZONA DE PERIGO — o admin zera os dados de teste da PRÓPRIA organização.
 *
 * Capacidade extraída da contribuição de @maugarciasa (PR #556).
 *
 * ─── Por que esta spec existe, e por que ela precisa de DUAS organizações ────
 *
 * A action apaga com o client de SERVICE ROLE, que bypassa RLS. Quando a RLS
 * sai de cena, quem separa uma organização da vizinha é uma linha de código —
 * o `.eq("organization_id", …)` de cada DELETE. Uma spec com UMA organização
 * ficaria verde mesmo com esse filtro removido: os dados sumiriam do mesmo
 * jeito, e a única diferença é que os do cliente ao lado também.
 *
 * Por isso o cenário tem A (que é zerada pela tela) e B (que tem de sair
 * inteira), e as duas provas de B são pela TELA — trocar de organização e ver
 * o contato e o negócio ainda lá — e pelo BANCO, contando as seis tabelas.
 *
 * ─── Por que o usuário é o `manager`, e não o `admin` ───────────────────────
 *
 * Dois motivos, os dois medidos:
 *   • ele não tem fator de MFA, então o login não depende do TOTP compartilhado
 *     que outros seeds rotacionam no meio de um run;
 *   • ele é `manager` na organização compartilhada e `admin` nas duas do
 *     fixture — o que dá de graça o caso negativo do RBAC: a MESMA pessoa, na
 *     MESMA sessão, não alcança a tela onde não administra.
 *
 * ⚠️ A spec NÃO toca na organização do `.e2e-creds.json`. Zerar a org
 * compartilhada destruiria a fixture de todo o resto do run.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

const RAIZ = path.resolve(__dirname, "../..");
const CREDS_PATH = path.join(RAIZ, ".e2e-creds.json");

interface Zona {
  org_a_id: string;
  org_a_nome: string;
  org_a_contato: string;
  org_a_lead: string;
  org_a_funil_id: string;
  org_a_etapa: string;
  org_b_id: string;
  org_b_nome: string;
  org_b_contato: string;
  org_b_lead: string;
  usuario_email: string;
}
interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string } | undefined>;
  zona_de_perigo?: Zona;
}

/** Semeia SEMPRE: a spec anterior desta suíte apaga o dado que ela precisa ver. */
function semear(): Creds {
  execFileSync("npx", ["tsx", "scripts/seed-e2e-zona-de-perigo.ts"], {
    stdio: "inherit",
    cwd: RAIZ,
  });
  const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.zona_de_perigo) throw new Error("o seed não gravou o bloco `zona_de_perigo`");
  return c;
}

function bancoDeTeste() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) {
    throw new Error(
      "sem NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY no processo de teste — " +
        "o playwright.config publica o .env.e2e aqui; se sumiu, a conferência no banco é cega",
    );
  }
  return createClient(url, chave, { auth: { autoRefreshToken: false, persistSession: false } });
}

const TABELAS = [
  "messages",
  "conversations",
  "calendar_appointments",
  "orders",
  "crm_leads",
  "contacts",
] as const;

async function contarTudo(orgId: string): Promise<Record<string, number>> {
  const db = bancoDeTeste();
  const saida: Record<string, number> = {};
  for (const tabela of TABELAS) {
    const { count, error } = await db
      .from(tabela)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if (error) throw new Error(`contar ${tabela}: ${error.message}`);
    saida[tabela] = count ?? 0;
  }
  return saida;
}

async function entrar(page: Page, email: string, senha: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

async function trocarPara(page: Page, orgId: string) {
  const seletor = page.getByTestId("tenant-switcher");
  await expect(seletor).toBeVisible({ timeout: 20_000 });
  await seletor.click();
  await page.getByTestId(`tenant-switcher-item-${orgId}`).click();
  await expect(seletor).toBeEnabled({ timeout: 60_000 });
}

test.describe.configure({ timeout: 180_000 });

test("o admin zera os dados da sua organização pela tela — e a vizinha não sente nada", async ({
  page,
}) => {
  const creds = semear();
  const z = creds.zona_de_perigo!;

  // ── Precondição medida, não presumida ───────────────────────────────────
  const antesA = await contarTudo(z.org_a_id);
  const antesB = await contarTudo(z.org_b_id);
  for (const tabela of TABELAS) {
    expect(antesA[tabela], `o fixture de A não tem ${tabela} — a spec não provaria nada`).toBeGreaterThan(0);
    expect(antesB[tabela], `o fixture de B não tem ${tabela}`).toBeGreaterThan(0);
  }

  await entrar(page, z.usuario_email, creds.password);
  await page.goto("/app/inbox");
  await trocarPara(page, z.org_a_id);

  // ── O dado ESTÁ na tela antes ───────────────────────────────────────────
  // As duas metades do controle positivo. Sem elas, um "sumiu" depois não
  // distingue "foi apagado" de "esta tela nunca mostrou isto".
  await page.goto("/app/contacts");
  await expect(page.getByText(z.org_a_contato)).toBeVisible({ timeout: 30_000 });
  await page.goto(`/app/pipelines/${z.org_a_funil_id}`);
  await expect(page.getByText(z.org_a_lead)).toBeVisible({ timeout: 30_000 });

  // ── A zona de perigo, com a confirmação por nome ────────────────────────
  await page.goto("/app/settings/tenant");
  const zona = page.getByTestId("zona-de-perigo");
  await expect(zona).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("abrir-zona-de-perigo").click();

  const apagar = page.getByTestId("apagar-de-vez");
  await expect(
    apagar,
    "o botão destrutivo nasceu habilitado — um clique só bastaria para zerar a organização",
  ).toBeDisabled();

  const campo = page.getByTestId("confirmar-nome-da-organizacao");
  await campo.fill(`${z.org_a_nome} Ltda`);
  await expect(apagar, "nome errado habilitou o botão").toBeDisabled();

  await campo.fill(z.org_a_nome);
  await expect(apagar).toBeEnabled({ timeout: 10_000 });
  await apagar.click();

  await expect(page.getByText(/dados apagados/i)).toBeVisible({ timeout: 30_000 });

  // ── A prova pela TELA: sumiu de A ───────────────────────────────────────
  //
  // ⚠️ `toHaveCount(0)` sozinho é sonda CEGA aqui, e isto foi medido: a lista de
  // contatos é carregada pelo cliente, então logo depois do `goto` a contagem é
  // zero porque nada renderizou ainda — e a asserção passa mesmo com o dado
  // intacto no banco. (Aconteceu: na rodada de sabotagem, este par passou e quem
  // reprovou foi a asserção da organização vizinha, três linhas abaixo.)
  //
  // O conserto é esperar um sinal POSITIVO de que a tela terminou de carregar
  // — o estado vazio dos contatos, o nome da etapa no quadro — e só então
  // afirmar a ausência.
  await page.goto("/app/contacts");
  await expect(page.getByText(/nenhum contato ainda/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(z.org_a_contato)).toHaveCount(0);

  await page.goto(`/app/pipelines/${z.org_a_funil_id}`);
  await expect(page.getByText(z.org_a_etapa).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(z.org_a_lead)).toHaveCount(0);

  // ── A prova pela TELA: a vizinha continua inteira ───────────────────────
  //
  // A volta ao Inbox NÃO é enfeite: trocar de organização estando no quadro de
  // um funil da organização ANTIGA deixa o seletor desabilitado para sempre —
  // o id do funil não existe na organização de destino. Medido: `toBeEnabled`
  // estourou 60 s com o botão preso em `disabled`.
  await page.goto("/app/inbox");
  await trocarPara(page, z.org_b_id);
  await page.goto("/app/contacts");
  await expect(
    page.getByText(z.org_b_contato),
    "o contato da organização VIZINHA sumiu — o DELETE atravessou o tenant",
  ).toBeVisible({ timeout: 30_000 });

  // ── E a prova pelo BANCO, tabela a tabela ───────────────────────────────
  const depoisA = await contarTudo(z.org_a_id);
  const depoisB = await contarTudo(z.org_b_id);
  for (const tabela of TABELAS) {
    expect(depoisA[tabela], `${tabela} da organização A sobreviveu ao reset`).toBe(0);
    expect(depoisB[tabela], `${tabela} da organização B foi apagada junto`).toBe(antesB[tabela]);
  }

  // A organização compartilhada do harness é uma terceira testemunha: ela não
  // é nem A nem B, e um DELETE sem filtro a levaria junto.
  const compartilhada = await contarTudo(creds.org_id);
  expect(
    compartilhada.contacts,
    "os contatos da organização compartilhada do harness sumiram — o reset saiu do tenant",
  ).toBeGreaterThan(0);

  // ── O rastro: a mutação está no audit log ───────────────────────────────
  const db = bancoDeTeste();
  const { data: linhas, error } = await db
    .from("api_audit_log")
    .select("action, organization_id, metadata")
    .eq("organization_id", z.org_a_id)
    .eq("action", "org.dados_operacionais_apagados")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`ler audit: ${error.message}`);
  expect(linhas?.length, "o reset não deixou linha em api_audit_log").toBe(1);
  const meta = linhas![0]!.metadata as { counts?: Record<string, number> } | null;
  expect(meta?.counts?.contacts).toBe(antesA.contacts);
});

test("quem não administra a organização não chega na zona de perigo", async ({ page }) => {
  const creds = semear();
  const z = creds.zona_de_perigo!;

  // O `agent` do harness: nunca é admin de organização nenhuma.
  const agente = creds.users.agent;
  if (!agente) throw new Error("`.e2e-creds.json` sem o usuário `agent`");
  await entrar(page, agente.email, creds.password);
  await page.goto("/app/settings/tenant");
  await expect(page.getByTestId("zona-de-perigo")).toHaveCount(0);
  await expect(page).toHaveURL(/\/403/, { timeout: 20_000 });

  // E o MESMO usuário do primeiro caso — que é admin em A — não alcança a tela
  // na organização onde ele é só `manager`. É o gate de PAPEL, não de pessoa.
  await page.context().clearCookies();
  await entrar(page, z.usuario_email, creds.password);
  await page.goto("/app/inbox");
  await trocarPara(page, creds.org_id);
  await page.goto("/app/settings/tenant");
  await expect(page.getByTestId("zona-de-perigo")).toHaveCount(0);
  await expect(page).toHaveURL(/\/403/, { timeout: 20_000 });
});
