/**
 * "MINHAS TAREFAS" NO CELULAR — o endereço que o lembrete abre, provado pela tela.
 *
 * O lembrete de prazo e o push de tarefa criada levam a
 * `/app/tasks?assigned_to=me`. O que só a tela responde:
 *  · por essa URL aparecem as tarefas da pessoa, e as dos colegas não;
 *  · "Todos", no seletor Responsável, traz as dos colegas de volta;
 *  · a 390px os controles têm alvo de dedo (44px), a caixa de concluir alcança
 *    44px sem crescer o desenho, e o lápis aparece sem hover;
 *  · tocar na caixa conclui a tarefa no banco.
 *
 * As tarefas são deste spec (título com `SUFIXO`) e saem no `afterAll`: o banco
 * de e2e é compartilhado.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/minhas-tarefas-no-celular.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Locator, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { HREF_MINHAS_TAREFAS } from "../../lib/tarefas/tipos";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA =
  process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), "evidence/minhas-tarefas-no-celular");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;
const SUFIXO = `${Date.now()}`.slice(-7);
const PREFIXO = "Tarefa celular E2E";
const MINHA = `${PREFIXO} minha ${SUFIXO}`;
const ALHEIA = `${PREFIXO} alheia ${SUFIXO}`;

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function limparFixtures(): Promise<void> {
  await admin
    .from("crm_tasks")
    .delete()
    .eq("organization_id", creds.org_id)
    .like("title", `${PREFIXO} %`);
}

/** A linha da tarefa: o ancestral mais próximo com a classe `group` (ver `ListaDeTarefas.tsx`). */
function linha(page: Page, titulo: string): Locator {
  return page
    .getByText(titulo, { exact: true })
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' group ')][1]");
}

async function altura(alvo: Locator): Promise<number> {
  return alvo.evaluate((el) => el.getBoundingClientRect().height);
}

test.describe("Minhas tarefas no celular — o que o lembrete abre", () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    // O worker reinicia depois de um vermelho e o `beforeAll` roda de novo com
    // outro `SUFIXO`: sem esta linha as tarefas da rodada anterior ficam.
    await limparFixtures();

    const prazo = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const { error } = await admin.from("crm_tasks").insert([
      {
        organization_id: creds.org_id,
        title: MINHA,
        status: "pending",
        due_date: prazo,
        assigned_to: creds.users.agent!.id,
        created_by: creds.users.manager!.id,
      },
      {
        organization_id: creds.org_id,
        title: ALHEIA,
        status: "pending",
        due_date: prazo,
        assigned_to: creds.users.manager!.id,
        created_by: creds.users.manager!.id,
      },
    ]);
    if (error) throw new Error(`tarefas: ${error.message}`);
  });

  test.afterAll(async () => {
    await limparFixtures();
  });

  test("pela URL do lembrete só as minhas; 'Todos' traz as outras; alvos de dedo; tocar conclui", async ({
    page,
  }) => {
    await login(page, creds.users.agent!.email, creds.password);
    // A MESMA constante que o lembrete e o push levam: trocar o endereço sem
    // trocar a página (ou o inverso) quebra aqui, e não só no celular de alguém.
    await page.goto(HREF_MINHAS_TAREFAS);
    const tela = page.getByRole("main");

    await expect(tela.getByText(MINHA, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(tela.getByText(ALHEIA, { exact: true })).toHaveCount(0);
    await captura(page, "01-minhas-pela-url-do-lembrete");

    // Pré-condição da emulação: sem ela, as réguas abaixo mediriam o desktop.
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches && matchMedia("(hover: none)").matches),
      "o navegador precisa se apresentar como toque (pointer: coarse, hover: none)",
    ).toBe(true);

    const seletor = tela.getByRole("combobox", { name: "Responsável" });
    await expect(seletor).toContainText("Minhas");
    const hSeletor = await altura(seletor);
    expect(hSeletor, `"Responsável" com ${hSeletor}px de altura — alvo de dedo é 44px`).toBeGreaterThanOrEqual(44);
    for (const nome of ["Atualizar", "Nova tarefa"]) {
      const h = await altura(tela.getByRole("button", { name: nome, exact: true }));
      expect(h, `"${nome}" com ${h}px de altura — alvo de dedo é 44px`).toBeGreaterThanOrEqual(44);
    }
    await expect(tela.getByRole("button", { name: "Calendário", exact: true })).toBeHidden();

    const minha = linha(page, MINHA);
    const caixa = minha.getByRole("checkbox", { name: "Marcar como concluída" });
    const alcance = await caixa.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const pontos: Array<[number, number]> = [
        [cx - 20, cy],
        [cx + 20, cy],
        [cx, cy - 20],
        [cx, cy + 20],
      ];
      return {
        desenho: r.width,
        acertos: pontos.map(([x, y]) => document.elementFromPoint(x, y)?.closest("button") === el),
      };
    });
    expect(alcance.desenho, "o desenho da caixa continua pequeno").toBeLessThan(24);
    expect(alcance.acertos, "a 20px do centro, o toque ainda cai na caixa").toEqual([true, true, true, true]);

    const lapis = minha.getByRole("button", { name: "Editar a tarefa" });
    const medidaDoLapis = await lapis.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, opacidade: Number(getComputedStyle(el.parentElement!).opacity) };
    });
    expect(medidaDoLapis.w).toBeGreaterThanOrEqual(44);
    expect(medidaDoLapis.h).toBeGreaterThanOrEqual(44);
    expect(medidaDoLapis.opacidade, "sem hover, o lápis precisa estar à vista").toBeGreaterThan(0.9);

    const sobra = await page.evaluate(
      () => document.body.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sobra, `a página rola ${sobra}px para o lado`).toBeLessThanOrEqual(1);
    // O body só enxerga a casca: a coluna de conteúdo tem `min-w-0` e o <main>
    // tem `overflow-auto` (AppShell), então o que estoura na tela de Tarefas
    // rola DENTRO do <main>. É ele o rolador que a régua precisa medir.
    const sobraNoMain = await tela.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(sobraNoMain, `o conteúdo rola ${sobraNoMain}px para o lado dentro do <main>`).toBeLessThanOrEqual(1);

    await seletor.tap();
    await page.getByRole("option", { name: "Todos", exact: true }).tap();
    await expect(tela.getByText(ALHEIA, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(tela.getByText(MINHA, { exact: true })).toBeVisible();
    await captura(page, "02-todos");

    await caixa.tap();
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("crm_tasks")
            .select("status")
            .eq("organization_id", creds.org_id)
            .eq("title", MINHA)
            .single();
          return (data as { status: string } | null)?.status;
        },
        { timeout: 30_000 },
      )
      .toBe("done");
    // Com "Em aberto" (o padrão), a concluída sai da lista: é isso que a 03 mostra.
    await expect(tela.getByText(MINHA, { exact: true })).toHaveCount(0, { timeout: 30_000 });
    await captura(page, "03-concluida-pelo-toque");
  });
});
