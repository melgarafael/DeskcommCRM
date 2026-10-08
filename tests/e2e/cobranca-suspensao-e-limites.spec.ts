/**
 * E2E: planos e limites pela tela (PR 2 da cobrança do revendedor).
 *
 * Spec: `docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md`,
 * §5, §7(g)(h), §9, §12 "E2E pela tela" e §14 (PR 2). A chave ainda NÃO liga
 * pela tela (fica em MODULOS_AINDA_NAO_LIGAVEIS até a PR 3a): o fixture a grava
 * no banco, como a spec manda, e devolve o valor anterior no `finally` — a chave
 * é da instalação, e a spec seguinte da mesma parte do CI não pode herdá-la.
 *
 * Um caso só, porque cada passo depende do estado do anterior:
 *   1. o dono acha a porta Cobrança e cria um plano (1 pessoa, 1 número, 5 dias);
 *   2. atribui o plano à empresa B pelo card do tenant: B entra em teste grátis;
 *   3. a admin de B vê a faixa, e o convite com o plano cheio é recusado ANTES
 *      do e-mail, com a frase do plano (nenhum convite nasce);
 *   4. reativar um membro revogado acima do teto, pela API com a sessão dela,
 *      atravessa o PostgREST real: 409 plan_limit_reached (os testes de rota
 *      usam dublê; só aqui o PT402 passa pelo PostgREST);
 *   5. Billing mostra o teste grátis e o uso 1 de 1;
 *   6. B é suspensa por cobrança (pela função, como a régua da PR 3a fará) e o
 *      dono dá prazo pelo card: B volta na hora;
 *   7. suspensa de novo, o dono desliga a chave em /admin/sistema, que avisa
 *      quantas serão liberadas: B volta, e a porta Cobrança some.
 *
 * Self-contida: orgs, pessoas e plano nascem pelo service role com sufixo
 * próprio e morrem no `finally`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { test, expect, type BrowserContext, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const senha = `Local-${randomUUID()}!`;
const sufixo = randomUUID().slice(0, 8);
const EVIDENCIA = "evidence/cobranca-planos-e-limites";
const CHAVE = "MODULO_COBRANCA";
const NOME_DO_PLANO = `Básico E2E ${sufixo}`;

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function criarPessoa(rotulo: string): Promise<{ id: string; email: string }> {
  const email = `cob-${rotulo}-${sufixo}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (error || !data.user) throw error ?? new Error(`não criou ${rotulo}`);
  return { id: data.user.id, email };
}

async function entrar(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

async function estadoDaOrg(id: string): Promise<{ status: string; suspended_kind: string | null }> {
  const { data, error } = await db.from("organizations").select("status, suspended_kind").eq("id", id).single();
  if (error) throw error;
  return data as { status: string; suspended_kind: string | null };
}

async function suspenderPorCobranca(org: string, ator: string): Promise<void> {
  const r = await db.rpc("fn_suspender_organizacao", {
    p_org: org, p_kind: "cobranca", p_motivo: "e2e: falta de pagamento", p_ator: ator,
  });
  if (r.error) throw r.error;
  expect(r.data).toEqual({ changed: true });
}

/** `YYYY-MM-DD` daqui a N dias, no fuso de quem roda (o do campo de data do navegador). */
function diaDaqui(dias: number): string {
  const d = new Date(Date.now() + dias * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("o dono cria o plano, os limites valem pela tela, e prazo e desligar a chave liberam a suspensa", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(20_000);
  mkdirSync(EVIDENCIA, { recursive: true });
  const pessoas: string[] = [];
  const orgs: string[] = [];
  const contextos: BrowserContext[] = [];
  let planoId: string | null = null;
  let falhaDoCenario: unknown;
  const chaveAntes = await db.from("platform_config").select("valor, eh_segredo, semeado_do_env").eq("chave", CHAVE).maybeSingle();
  if (chaveAntes.error) throw chaveAntes.error;

  try {
    // ── Fixtures ────────────────────────────────────────────────────────────
    const dono = await criarPessoa("dono");
    const adminB = await criarPessoa("admin-b");
    const revogado = await criarPessoa("revogado");
    pessoas.push(dono.id, adminB.id, revogado.id);

    const agora = new Date().toISOString();
    // `created_by` nulo: sem teste grátis automático — quem dá o plano é o dono, pela tela.
    const orgB = await inserir("organizations", {
      slug: `cob-b-${sufixo}`, display_name: `Pagante B ${sufixo}`, legal_name: "Pagante B", onboarded_at: agora,
    });
    const orgDoDono = await inserir("organizations", {
      slug: `cob-dono-${sufixo}`, display_name: `Casa do dono ${sufixo}`, legal_name: "Casa do dono", onboarded_at: agora,
    });
    orgs.push(orgB, orgDoDono);
    const vinculos = await db.from("user_organizations").insert([
      { organization_id: orgB, user_id: adminB.id, role: "admin", accepted_at: agora },
      { organization_id: orgB, user_id: revogado.id, role: "agent", accepted_at: agora, revoked_at: agora },
      { organization_id: orgDoDono, user_id: dono.id, role: "admin", accepted_at: agora },
    ]);
    if (vinculos.error) throw vinculos.error;
    const admins = await db.from("platform_admins").insert({
      user_id: dono.id, granted_by: dono.id, scope: "full", mfa_required: false, reason: "E2E cobrança",
    });
    if (admins.error) throw admins.error;
    const ligar = await db.from("platform_config").upsert(
      { chave: CHAVE, valor: "ligado", eh_segredo: false, semeado_do_env: false },
      { onConflict: "chave" },
    );
    if (ligar.error) throw ligar.error;

    // ── 1. O dono acha a porta e cria o plano ───────────────────────────────
    await entrar(page, dono.email);
    await page.goto("/admin/dashboard");
    await page.getByRole("link", { name: "Cobrança" }).first().click();
    await page.waitForURL("**/admin/cobranca");
    await page.getByLabel("Nome do plano").fill(NOME_DO_PLANO);
    await page.getByLabel("Preço (R$)").fill("49,90");
    await page.getByLabel("Dias de teste grátis").fill("5");
    await page.getByLabel("Máximo de pessoas").fill("1");
    await page.getByLabel("Máximo de números conectados").fill("1");
    await page.getByRole("button", { name: "Salvar plano" }).click();
    await expect(page.getByText(NOME_DO_PLANO)).toBeVisible();
    const plano = await db.from("cobranca_planos").select("id, preco_cents, max_assentos, max_canais, trial_dias").eq("nome", NOME_DO_PLANO).single();
    if (plano.error) throw plano.error;
    planoId = plano.data.id as string;
    expect(plano.data).toMatchObject({ preco_cents: 4990, max_assentos: 1, max_canais: 1, trial_dias: 5 });
    // Medida, não olho: a tela cabe na largura, sem rolagem horizontal.
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `${EVIDENCIA}/admin-cobranca-planos.png`, fullPage: true });

    // ── 2. Atribui o plano a B pelo card ────────────────────────────────────
    await page.goto(`/admin/tenants/${orgB}`);
    await page.locator("#plano-da-empresa").selectOption({ label: NOME_DO_PLANO });
    await page.getByRole("button", { name: "Atribuir plano" }).click();
    await expect(page.getByText("Teste grátis", { exact: true })).toBeVisible();
    const assinatura = await db.from("cobranca_assinaturas").select("estado, plano_id").eq("organization_id", orgB).single();
    if (assinatura.error) throw assinatura.error;
    expect(assinatura.data).toEqual({ estado: "trial", plano_id: planoId });
    await page.screenshot({ path: `${EVIDENCIA}/tenant-card-cobranca.png`, fullPage: true });

    // ── 3. A admin de B: faixa, e o convite recusado antes do e-mail ────────
    const ctxB = await browser.newContext();
    contextos.push(ctxB);
    const pB = await ctxB.newPage();
    pB.setDefaultTimeout(20_000);
    await entrar(pB, adminB.email);
    await pB.goto("/app/team/invite");
    await expect(pB.getByText(/Seu teste grátis termina em 5 dias\./)).toBeVisible();
    await pB.locator("#emails").fill(`nova-${sufixo}@invariant.test`);
    await pB.getByRole("button", { name: "Enviar convites" }).click();
    await expect(pB.getByTestId("convite-limite-do-plano")).toContainText("Seu plano permite 1 pessoa e a vaga está ocupada.");
    const convites = await db.from("team_invites").select("id", { count: "exact", head: true }).eq("organization_id", orgB);
    if (convites.error) throw convites.error;
    expect(convites.count).toBe(0);
    await pB.screenshot({ path: `${EVIDENCIA}/convite-recusado-pelo-plano.png`, fullPage: true });

    // ── 4. O PT402 atravessa o PostgREST real ───────────────────────────────
    const reativar = await pB.request.post(`/api/v1/team/${revogado.id}/reactivate`);
    expect(reativar.status(), await reativar.text()).toBe(409);
    const corpo = (await reativar.json()) as { error: { code: string; details: unknown } };
    expect(corpo.error.code).toBe("plan_limit_reached");
    expect(corpo.error.details).toEqual({ recurso: "assentos", limite: 1 });
    const segueRevogado = await db.from("user_organizations").select("revoked_at")
      .eq("organization_id", orgB).eq("user_id", revogado.id).single();
    expect(segueRevogado.data?.revoked_at).not.toBeNull();

    // ── 5. Billing: o teste grátis e o uso contra o plano ───────────────────
    await pB.goto("/app/settings/billing");
    await expect(pB.getByText(/^Teste grátis até /)).toBeVisible();
    await expect(pB.locator('[data-uso="assentos"]')).toHaveText("1 de 1");
    await pB.screenshot({ path: `${EVIDENCIA}/billing-teste-gratis.png`, fullPage: true });

    // ── 6. Suspensa por cobrança; o dono dá prazo e B volta ─────────────────
    await suspenderPorCobranca(orgB, dono.id);
    expect(await estadoDaOrg(orgB)).toEqual({ status: "suspended", suspended_kind: "cobranca" });
    await page.goto(`/admin/tenants/${orgB}`);
    await expect(page.getByRole("status").filter({ hasText: "Suspensa por falta de pagamento" })).toBeVisible();
    // D-6: a tela diz o TIPO e não oferece o botão genérico, que a rota recusaria.
    await expect(page.getByTestId("tipo-da-suspensao")).toHaveText("Suspensa por falta de pagamento");
    await expect(page.getByRole("button", { name: "Reativar tenant" })).toHaveCount(0);
    await page.locator("#prazo-ate").fill(diaDaqui(10));
    await page.getByRole("button", { name: "Dar prazo" }).click();
    await expect.poll(async () => (await estadoDaOrg(orgB)).status).toBe("active");
    const prazo = await db.from("cobranca_assinaturas").select("prazo_extra_ate").eq("organization_id", orgB).single();
    if (prazo.error) throw prazo.error;
    expect(prazo.data?.prazo_extra_ate).not.toBeNull();

    // ── 7. Suspensa de novo; desligar a chave libera ────────────────────────
    await suspenderPorCobranca(orgB, dono.id);
    await page.goto("/admin/sistema");
    const interruptor = page.getByRole("switch", { name: "Cobrança dos seus clientes" });
    await expect(interruptor).toHaveAttribute("aria-checked", "true");
    // A contagem esperada vem do banco (B já está suspensa por cobrança): a tela tem de somá-la.
    const suspensas = await db.from("organizations").select("id", { count: "exact", head: true })
      .eq("status", "suspended").eq("suspended_kind", "cobranca");
    if (suspensas.error) throw suspensas.error;
    expect(suspensas.count).toBeGreaterThanOrEqual(1);
    await expect(page.getByText(`serão liberadas ao desligar: ${suspensas.count}`)).toBeVisible();
    await page.screenshot({ path: `${EVIDENCIA}/sistema-desligar-libera.png`, fullPage: true });
    await interruptor.click();
    // A ação LIBERA antes de GRAVAR a chave (de propósito: se liberar falhar, a chave
    // fica ligada). Esperar o "active" e ler a chave no mesmo instante disputava com
    // a gravação — o último efeito é a chave, então é por ela que se espera.
    await expect
      .poll(async () => (await db.from("platform_config").select("valor").eq("chave", CHAVE).single()).data?.valor)
      .toBe("desligado");
    expect((await estadoDaOrg(orgB)).status).toBe("active");
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("link", { name: "Cobrança" })).toHaveCount(0);
    expect((await page.goto("/admin/cobranca"))?.status()).toBe(404);
  } catch (erro) {
    falhaDoCenario = erro;
    throw erro;
  } finally {
    try {
      const fechamentos = await Promise.allSettled(contextos.map((c) => c.close()));
      const falhas = fechamentos.filter((r) => r.status === "rejected");
      if (falhas.length) throw new AggregateError(falhas.map((r) => r.reason), "falha ao fechar contextos");
      // A chave volta ao que era ANTES desta spec (Review Focus 5).
      const volta = chaveAntes.data
        ? await db.from("platform_config").upsert(
            {
              chave: CHAVE, valor: chaveAntes.data.valor,
              eh_segredo: chaveAntes.data.eh_segredo, semeado_do_env: chaveAntes.data.semeado_do_env,
            },
            { onConflict: "chave" },
          )
        : await db.from("platform_config").delete().eq("chave", CHAVE);
      if (volta.error) throw volta.error;
      for (const org of orgs) {
        const r = await db.from("organizations").delete().eq("id", org);
        if (r.error) throw r.error;
      }
      const planos = await db.from("cobranca_planos").delete().eq("nome", NOME_DO_PLANO);
      if (planos.error) throw planos.error;
      const pa = await db.from("platform_admins").delete().in("user_id", pessoas);
      if (pa.error) throw pa.error;
      for (const id of pessoas) {
        const r = await db.auth.admin.deleteUser(id);
        if (r.error) throw r.error;
      }
    } catch (erroDaLimpeza) {
      // Não troca a causa original por erro de teardown.
      test.info().annotations.push({ type: "cleanup", description: `limpeza incompleta: orgs ${orgs.join(",")}, plano ${planoId ?? "-"}` });
      if (!falhaDoCenario) throw erroDaLimpeza;
    }
  }
});
