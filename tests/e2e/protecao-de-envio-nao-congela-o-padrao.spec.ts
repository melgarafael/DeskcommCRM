/**
 * SALVAR A PROTEÇÃO DE ENVIO NÃO PODE CONGELAR O PADRÃO DO DIA — PELA TELA.
 *
 * ─── Por que esta spec existe, e por que um teste unitário não bastava ─────
 *
 * O defeito que ela vigia deixou uma instalação real MUDA por um dia inteiro:
 * `channel_knobs.allow_sunday = false`, gravado sem que ninguém tivesse
 * escolhido desligar o domingo. A ficha semeava o Switch com o default vigente
 * e o `handleSave` mandava o booleano cru — então salvar aquela ficha por
 * QUALQUER outro motivo congelava o padrão do dia como override permanente.
 * Quando o produto virou o default para `true`, a instalação não foi junto.
 *
 * `tests/unit/anti-ban-nao-congela-o-padrao.test.ts` já cobre a regra pura, e
 * tem até uma cerca que lê o `AntiBanSheet.tsx` atrás da chamada. Mas cerca de
 * texto morre no dia em que o componente for reescrito, renomeado ou extraído
 * para um hook — e ela nunca provou o que importa: que o valor que sai da TELA
 * e chega ao BANCO é `null`. Entre a função e a linha do banco há um formulário,
 * um mutation, uma rota e um Zod; nenhum deles é exercitado por unitário.
 *
 * Esta spec fecha o vão medindo as duas pontas: o estado da linha ANTES, o
 * clique real no botão de salvar, e o estado da linha DEPOIS.
 *
 * ─── As duas direções, e por que as duas precisam estar aqui ──────────────
 *
 * Um "conserto" que devolvesse `null` sempre também passaria no primeiro caso —
 * e tornaria o Switch decorativo, que é um defeito PIOR: a tela ofereceria um
 * controle que o motor ignora. Por isso o segundo caso desliga o domingo de
 * verdade e cobra o `false` explícito no banco.
 */
import { expect, test, type Page } from "./helpers/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const env = carregarEnvLocal();
const admin: SupabaseClient = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** Nome próprio: a fixture é desta spec e não empresta canal de nenhum seed. */
const CANAL = "Canal da prova de domingo";

async function criarCanal(orgId: string): Promise<string> {
  await admin.from("channel_sessions").delete().eq("display_name", CANAL);
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: orgId,
      display_name: CANAL,
      waha_session_name: `prova-domingo-${Date.now()}`,
      status: "WORKING",
      // NOT NULL sem default; o conteúdo é irrelevante para esta spec.
      webhook_secret_encrypted: "\\x00",
    })
    .select("id")
    .single();
  if (error) throw new Error(`fixture de canal falhou: ${error.message}`);
  return (data as { id: string }).id;
}

/** Lê o knob CRU — `null` e `false` são respostas diferentes, e é essa a questão. */
async function lerAllowSunday(sessionId: string): Promise<boolean | null | undefined> {
  const { data } = await admin
    .from("channel_knobs")
    .select("allow_sunday")
    .eq("channel_session_id", sessionId)
    .maybeSingle();
  return data === null ? undefined : (data as { allow_sunday: boolean | null }).allow_sunday;
}

/**
 * Abre a ficha do canal da fixture e **prova qual ficha abriu**.
 *
 * A org de teste é compartilhada e pode ter outros canais; escolher o cartão
 * certo por posição seria uma aposta silenciosa. O `SheetTitle` é
 * `Proteção de envio — {label}`, então a asserção do título transforma um
 * clique no cartão errado — que passaria despercebido e mediria o knob de outro
 * canal — em falha ruidosa e imediata.
 */
async function abrirFicha(page: Page): Promise<void> {
  await expect(page.getByText(CANAL).first()).toBeVisible({ timeout: 20_000 });
  const cartao = page
    .locator("div")
    .filter({ hasText: CANAL })
    .filter({ has: page.getByRole("button", { name: /Proteção de envio/i }) })
    .last();
  await cartao.getByRole("button", { name: /Proteção de envio/i }).click();
  await expect(
    page.getByText(`Proteção de envio — ${CANAL}`),
    "abriu a ficha de outro canal — a medição seria do knob errado",
  ).toBeVisible({ timeout: 10_000 });
}

// Dois logins neste arquivo NÃO cabem no orçamento padrão de 30 s do
// `playwright.config.ts`. `loginComoAdmin` guarda o último código TOTP e, quando
// o segundo login cai na MESMA janela de 30 s, espera a próxima para não repetir
// código (anti-replay do servidor) — medido no run 35538638028: 23,39 s de espera
// num teto de 30 s, sobrando ~4 s para o teste inteiro. O aviso `Proteção de envio
// atualizada.` estava VISÍVEL na tela no instante da morte: faltou relógio, não
// comportamento. É a convenção de toda spec desta casa que loga (104 delas
// declaram o próprio teto).
test.describe.configure({ timeout: 120_000 });

test.describe("Proteção de envio: o Switch sabe dizer 'não mexi'", () => {
  let sessionId = "";
  let orgId = "";

  test.beforeEach(async () => {
    const creds = lerCreds() as unknown as { org_id: string };
    orgId = creds.org_id;
    sessionId = await criarCanal(orgId);
  });

  test.afterEach(async () => {
    if (sessionId) await admin.from("channel_sessions").delete().eq("id", sessionId);
  });

  test("salvar sem tocar no domingo devolve o knob para herdado", async ({ page }) => {
    // ── ANTES: o estado exato medido na instalação real, um override explícito
    // que COINCIDE com o default vigente do produto (`allowSunday: true`).
    await admin.from("channel_knobs").upsert(
      { organization_id: orgId, channel_session_id: sessionId, allow_sunday: true },
      { onConflict: "organization_id,channel_session_id" },
    );
    expect(await lerAllowSunday(sessionId), "fixture não ficou como o previsto").toBe(true);

    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/connections");

    await abrirFicha(page);

    // A tela precisa REFLETIR o estado antes de a gente concluir algo do save.
    const sw = page.locator("#allow-sunday");
    await expect(sw).toBeVisible({ timeout: 10_000 });
    await expect(sw).toHaveAttribute("data-state", "checked");

    // O gesto do defeito: salvar a ficha SEM tocar no Switch.
    await page.getByTestId("anti-ban-save").click();
    await expect(page.getByText("Proteção de envio atualizada.")).toBeVisible({ timeout: 15_000 });

    // ── DEPOIS: `null`, e não `true`. É a diferença entre herdar e congelar.
    await expect
      .poll(() => lerAllowSunday(sessionId), {
        timeout: 10_000,
        message: "o save congelou o padrão do dia como override — o defeito voltou",
      })
      .toBeNull();
  });

  test("desligar o domingo de verdade continua virando override explícito", async ({ page }) => {
    await admin.from("channel_knobs").upsert(
      { organization_id: orgId, channel_session_id: sessionId, allow_sunday: null },
      { onConflict: "organization_id,channel_session_id" },
    );

    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/connections");
    await abrirFicha(page);

    const sw = page.locator("#allow-sunday");
    await expect(sw).toBeVisible({ timeout: 10_000 });
    await expect(sw).toHaveAttribute("data-state", "checked"); // herdando o default `true`
    await sw.click(); // AGORA sim: uma escolha de verdade
    await expect(sw).toHaveAttribute("data-state", "unchecked");

    await page.getByTestId("anti-ban-save").click();
    await expect(page.getByText("Proteção de envio atualizada.")).toBeVisible({ timeout: 15_000 });

    // `false`, não `null`: quem escolheu desligar precisa continuar desligado.
    await expect
      .poll(() => lerAllowSunday(sessionId), {
        timeout: 10_000,
        message: "o Switch virou decorativo — a tela oferece e o banco ignora",
      })
      .toBe(false);
  });
});
