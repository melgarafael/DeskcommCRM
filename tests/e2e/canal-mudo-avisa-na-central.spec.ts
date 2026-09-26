import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

/**
 * O CANAL MUDO APARECE NA CENTRAL — E SOME QUANDO DEIXA DE SER VERDADE.
 *
 * Doc 11, decisão B do dono. O canal nasce em modo de teste e só responde aos
 * números autorizados; o defeito é o esquecimento, e o sintoma é o pior
 * possível: as mensagens chegam no Inbox e a IA nunca responde, então quem
 * instalou conclui que o produto está quebrado.
 *
 * Esta spec prova o laço inteiro PELA TELA, que é o que a doutrina de QA Visual
 * pede — o teste da rota prova o mesmo por dentro, e nenhum dos dois substitui
 * o outro:
 *
 *   1. o aviso aparece na Central, com a frase que o operador lê;
 *   2. o número de teste é autorizado EM CONEXÕES, clicando;
 *   3. na rodada seguinte o aviso some da lista de abertos.
 *
 * O passo 2 é o que separa esta prova de um `update` no banco: quem fecha o
 * aviso é o caminho que o operador percorre, não uma escrita nossa.
 */

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});
const senha = `Local-${randomUUID()}!`;
const SUFIXO = randomUUID().slice(0, 8);

let orgId = "";
let canalId = "";
let email = "";

async function insere(tabela: string, valores: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valores).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

/** Roda a varredura como o scheduler roda, pelo segredo interno. */
async function rodarVarredura(page: Page): Promise<{ avisados: number; resolvidos: number }> {
  const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  expect(segredo, "sem segredo interno não dá para chamar o cron").toBeTruthy();
  const r = await page.request.post("/api/v1/cron/canal-mudo-watcher", {
    headers: { authorization: `Bearer ${segredo}` },
  });
  expect(r.status(), await r.text()).toBe(200);
  return ((await r.json()) as { data: { avisados: number; resolvidos: number } }).data;
}

const avisoNaCentral = (page: Page) =>
  page.getByTestId("inbox-item").filter({ hasText: /modo de teste/i });

test.describe("o canal em modo de teste avisa na Central", () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    email = `canal-mudo-${SUFIXO}@invariant.test`;
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true,
    });
    if (error || !data.user) throw error;

    orgId = await insere("organizations", {
      slug: `canal-mudo-${SUFIXO}`,
      legal_name: `Canal Mudo ${SUFIXO}`,
      display_name: `Canal Mudo ${SUFIXO}`,
      onboarded_at: new Date().toISOString(),
    });
    const { error: erroVinculo } = await db.from("user_organizations").insert({
      organization_id: orgId,
      user_id: data.user.id,
      role: "admin",
      accepted_at: new Date().toISOString(),
    });
    if (erroVinculo) throw erroVinculo;

    // O canal do defeito: ligado há cinco dias, em modo de teste, sem ninguém
    // autorizado. É o estado que o operador não vê porque nada reclama.
    canalId = await insere("channel_sessions", {
      organization_id: orgId,
      waha_session_name: `canal-mudo-${SUFIXO}`,
      display_name: `WhatsApp mudo ${SUFIXO}`,
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
      last_status_change_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      metadata: { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: [] },
    });
  });

  test.afterAll(async () => {
    if (orgId) await db.from("organizations").delete().eq("id", orgId);
  });

  test("o aviso aparece, o número autorizado pela tela o resolve, e ele some", async ({ page }) => {
    const primeira = await rodarVarredura(page);
    expect(primeira.avisados).toBeGreaterThanOrEqual(1);

    await login(page);
    await page.goto("/app/ai/inbox");
    const aviso = avisoNaCentral(page);
    await expect(aviso.first()).toBeVisible({ timeout: 60_000 });
    // A frase é o produto: ela diz o que o CLIENTE vive, não a configuração.
    await expect(aviso.first()).toContainText(/não responde ninguém/i);
    await page.screenshot({ path: "evidence/canal-mudo/01-aviso-na-central.png", fullPage: true });

    // Segunda rodada sem nada mudar: o aviso não duplica.
    const repetida = await rodarVarredura(page);
    expect(repetida.avisados).toBe(0);
    await page.reload();
    await expect(avisoNaCentral(page)).toHaveCount(1);

    // ── O laço de retorno, pela tela: autorizar um número em Conexões ──────
    // A rota é `/app/connections` — Conexões NÃO mora sob Configurações. Esta
    // spec apontava para `/app/settings/connections`, que não existe: o teste
    // pousava no 404 do produto e o único sintoma era "elemento não
    // encontrado", 60s depois. Os seletores abaixo são os mesmos que
    // `pre-go-live-whatsapp.spec.ts` já exerce nesta mesma tela — o painel se
    // abre por "Configurar acesso da IA", e a lista é um campo com rótulo.
    await page.goto("/app/connections");
    await expect(page.getByText(`WhatsApp mudo ${SUFIXO}`, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Configurar acesso da IA" }).click();
    const campo = page.getByLabel("Números autorizados para teste");
    await campo.fill("+5511999990000");
    await page.getByRole("button", { name: "Salvar lista de teste" }).click();
    // O painel fecha ao salvar: é o sinal de que o PATCH voltou 2xx, e sem ele
    // o `poll` abaixo esperaria 60s por uma escrita que nunca foi pedida.
    await expect(campo).not.toBeVisible();
    await expect
      .poll(
        async () => {
          const { data } = await db
            .from("channel_sessions")
            .select("metadata")
            .eq("id", canalId)
            .single();
          const nums = (data as { metadata: { ai_test_phone_numbers?: unknown[] } } | null)?.metadata
            ?.ai_test_phone_numbers;
          return Array.isArray(nums) ? nums.length : 0;
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);
    await page.screenshot({ path: "evidence/canal-mudo/02-numero-autorizado.png", fullPage: true });

    // ── E o aviso se fecha sozinho na rodada seguinte ─────────────────────
    const terceira = await rodarVarredura(page);
    expect(terceira.resolvidos).toBeGreaterThanOrEqual(1);

    await page.goto("/app/ai/inbox");
    await expect(avisoNaCentral(page)).toHaveCount(0);
    await page.screenshot({ path: "evidence/canal-mudo/03-aviso-resolvido.png", fullPage: true });
  });
});
