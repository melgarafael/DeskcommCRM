import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

import { escolherUltimoDiaCheio } from "./helpers/agenda-semana-integra";

/**
 * "VER NA AGENDA" LEVA ATÉ O COMPROMISSO — o botão que não fazia nada.
 *
 * ═══ O defeito ═══════════════════════════════════════════════════════════════
 * O dono do produto marcou um compromisso na v1.8.0, viu a confirmação com o
 * botão "Ver na agenda", clicou, e **nada aconteceu**. O relato foi exatamente
 * esse — ele não tinha o que reportar além de "não acontece nada".
 *
 * Medido: `<Button size="sm" data-testid="ver-na-agenda">Ver na agenda</Button>`
 * — SEM `onClick`. Controle decorativo na sua forma mais pura: ele nem ficava
 * cinza, o cursor virava mãozinha, e o clique caía no vazio.
 *
 * ═══ Por que fechar o painel não bastaria ════════════════════════════════════
 * O compromisso recém-marcado costuma ser de OUTRA semana — o do relato era 8 de
 * setembro —, e a grade abre na semana corrente. Um handler que só fechasse o
 * Sheet devolveria o usuário a uma grade onde o compromisso não aparece: o mesmo
 * "nada acontece", com um passo a mais e ainda mais difícil de reportar.
 *
 * Por isso a asserção é sobre a GRADE mostrar o compromisso, e não sobre o Sheet
 * ter fechado. Fechar é o meio; ver é o fim.
 *
 * ═══ Por que duas specs já existentes não pegaram ════════════════════════════
 * `agenda-marcar-pela-tela` e `agenda-remarcar-e-cancelar` assertam
 * `getByTestId("ver-na-agenda")).toBeVisible()` — elas usam o botão como PROVA
 * DE QUE A MARCAÇÃO FOI ACEITA, e para isso ele só precisa existir. Nenhuma
 * clica nele. Um botão pode estar visível a vida inteira sem nunca ter feito
 * nada, e foi o que aconteceu.
 */
const RAIZ = path.resolve(__dirname, "../..");

test.describe.configure({ timeout: 180_000 });

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: { tipo_nome: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  const c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) throw new Error(".e2e-creds.json sem o bloco `agenda` — rode `scripts/seed-e2e-agenda.ts`");
  return c;
}

async function entrar(page: Page, creds: Creds) {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test("marcar, clicar em 'Ver na agenda', e ENCONTRAR o compromisso na grade", async ({ page }) => {
  const creds = lerCreds();
  await page.setViewportSize({ width: 1280, height: 800 });
  await entrar(page, creds);

  await page.goto("/app/agenda");
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: /Novo agendamento/i }).click();
  // O tipo do seed, e não o primeiro da lista: só ele tem jornada publicada.
  await expect(page.getByTestId("tipos-de-agendamento")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(`^${creds.agenda!.tipo_nome}`) }).click();

  // O ÚLTIMO dia disponível, de propósito: quanto mais longe da semana corrente,
  // mais o defeito aparece. Com o primeiro dia (quase sempre nesta semana) a
  // grade já mostraria o compromisso sem precisar navegar, e o caso passaria
  // mesmo com o botão mudo — verde pelo motivo errado.
  // ⚠️ ERA `dias.last()`, e o último da lista pode ser HOJE. `.last()` é o último
  // dia disponível do MÊS EM TELA — no último dia útil do mês, esse último é o
  // próprio hoje, e o que a spec pegaria seria o resto de um dia já gasto (2
  // horários às 16h, ZERO das 17h em diante). `escolherUltimoDiaCheio` mantém a
  // intenção — o mais longe possível da semana corrente — e exclui hoje.
  await escolherUltimoDiaCheio(page);

  const horario = page.locator('[data-testid^="horario-"]').first();
  await expect(horario, "o dia foi escolhido e não veio horário nenhum").toBeVisible({ timeout: 15_000 });
  await horario.click();

  await expect(page.getByTestId("confirmacao")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("confirmar-marcacao").click();

  const verNaAgenda = page.getByTestId("ver-na-agenda");
  await expect(verNaAgenda, "marquei e a confirmação não apareceu").toBeVisible({ timeout: 20_000 });

  // ── O CLIQUE QUE NINGUÉM DAVA ────────────────────────────────────────────
  await verNaAgenda.click();

  // 1. o painel sai da frente
  await expect(
    page.getByTestId("painel-de-marcacao"),
    "cliquei em 'Ver na agenda' e o painel continuou aberto por cima da grade",
  ).toBeHidden({ timeout: 15_000 });

  // 2. e — o que importa — a GRADE mostra o compromisso. É aqui que um handler
  //    que só fechasse o Sheet seria reprovado: o compromisso é de outra semana,
  //    e sem mover a âncora a grade volta vazia.
  await expect(
    page.getByText(creds.agenda!.tipo_nome, { exact: false }).first(),
    "a grade não mostra o compromisso recém-marcado — o botão fechou o painel e " +
      "deixou a grade na semana corrente, que é o mesmo 'nada acontece' com um passo a mais",
  ).toBeVisible({ timeout: 20_000 });

  await page.screenshot({ path: "evidence/calendario/d2-ver-na-agenda.png", fullPage: false });
});
