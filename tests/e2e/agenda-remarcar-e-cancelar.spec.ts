import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect } from "./helpers/test";

import { escolherDiaDesenhado, irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";

/**
 * REMARCAR E CANCELAR PELA TELA — as duas ações que só a IA conseguia fazer.
 *
 * ─── O defeito que esta spec fecha ───────────────────────────────────────
 *
 * `HistoricoDaAgenda` aceita `onRemarcar`/`onCancelar` desde que nasceu, com
 * `disabled={!onRemarcar}` nos botões, e `_client.tsx` montava o componente com
 * QUATRO props e nenhuma callback. Os dois botões nasciam cinzas em toda linha,
 * de toda organização, para sempre.
 *
 * E o `title` do botão cinza dizia *"Disponível quando a agenda estiver
 * conectada"* — falso, e pior que o silêncio: `PATCH`/`DELETE
 * /api/v1/agenda/agendamentos" não tocam o Google. Quem lia acreditava que
 * faltava conectar a agenda, quando faltava a fiação.
 *
 * Medido antes de consertar: `grep -rn "cancelarAgendamentoHandler|
 * alterarAgendamentoHandler" app/ components/ hooks/` → zero em `components/`,
 * zero em `hooks/`, zero em qualquer `app/app/**`. Inbox, ficha de contato e de
 * lead incluídos.
 *
 * ─── Por que a primeira asserção é sobre estar HABILITADO ────────────────
 *
 * Porque é exatamente o estado que existia. Uma spec que só testasse o fluxo
 * feliz passaria a existir DEPOIS do conserto e nunca provaria que o botão
 * deixou de ser decorativo — e controle decorativo é um defeito que esta base
 * já pagou uma vez (PR #295, cinco deles).
 */

/**
 * ⚠️ SEM `APP_URL`: as navegações são RELATIVAS, e o `baseURL` do
 * `playwright.config.ts` resolve.
 *
 * Isto era `process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"`, e o
 * fallback é o defeito: **o CI não define `PLAYWRIGHT_BASE_URL`**. Local eu
 * exportava a variável, então passava; no runner a spec batia em `:3000`, onde
 * não há nada, e as seis caíam em bloco com `ERR_CONNECTION_REFUSED` — que se
 * parece com "o servidor morreu" e é "eu bati na porta errada".
 *
 * O log mostra o formato exato: `··········FFFFFF` — dez testes passam, os seis
 * meus caem juntos, e os seguintes voltam a passar. Servidor vivo o tempo todo.
 *
 * As irmãs já faziam certo de dois jeitos: `agenda-tela-do-produto` usa caminho
 * relativo, e `agente-marca-consulta` usa `E2E_PORT ?? 3001`. Nenhuma inventa
 * 3000.
 */
const RAIZ = path.resolve(__dirname, "../..");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: { tipo_nome: string; tipo_slug: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

async function entrar(page: import("@playwright/test").Page, creds: Creds): Promise<string[]> {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await page.goto("/app/agenda");
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 20_000 });
  // ⚠️ A SEMANA SEGUINTE, e ela é a condição de os dois casos existirem.
  //
  // O caso de remarcar precisa de DOIS horários livres no mesmo dia ("só havia
  // um horário livre — o cenário não distingue remarcar de repetir"), e o dia
  // que o painel oferecia era hoje. Medido com o motor real numa sexta: 4 vagas
  // às 15h, 2 às 16h, ZERO das 17h em diante — e zero o sábado inteiro. Um dia
  // inteiro da semana seguinte oferece 18, a qualquer hora e em qualquer dia da
  // semana. Tabela em `helpers/agenda-semana-integra`.
  return irParaASemanaSeguinte(page);
}

/** Marca um compromisso pela tela e devolve o rótulo do horário escolhido. */
async function marcarUm(
  page: import("@playwright/test").Page,
  tipoNome: string,
  dias: readonly string[],
): Promise<string> {
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("tipos-de-agendamento")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: new RegExp(`^${tipoNome}`) }).click();
  await escolherDiaDesenhado(page, dias);
  const horario = page.locator('[data-testid^="horario-"]').first();
  await expect(horario).toBeVisible({ timeout: 15_000 });
  const rotulo = (await horario.getAttribute("data-testid"))!.replace("horario-", "");
  await horario.click();
  await page.getByTestId("confirmar-marcacao").click();
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  return rotulo;
}

// O teto padrão do Playwright é 30s, e estes dois casos fazem DUAS jornadas
// completas cada um (login + marcar + a ação). Estourar o teto vira "timeout",
// que é indistinguível de defeito — e foi o que aconteceu na primeira execução.
test.describe.configure({ timeout: 120_000 });

test("cancelar pela tela: o motivo é exigido, e o compromisso sai dos próximos", async ({ page }) => {
  const creds = lerCreds();
  if (!creds.agenda) throw new Error("sem bloco agenda");
  const diasDaSemana = await entrar(page, creds);
  await marcarUm(page, creds.agenda.tipo_nome, diasDaSemana);

  const historico = page.getByTestId("historico-da-agenda");
  const cancelarBotao = historico.getByRole("button", { name: /^Cancelar$/ }).first();

  // ── A asserção que nomeia o defeito ────────────────────────────────────
  await expect(
    cancelarBotao,
    "o botão nasceu DESABILITADO — é o estado que existia antes da fiação, com " +
      "`disabled={!onCancelar}` e nenhuma callback passada",
  ).toBeEnabled({ timeout: 15_000 });

  // ⚠️ A CONTAGEM É LIDA ANTES DE ABRIR A FOLHA, e isso não é estilo.
  //
  // O Sheet do Radix marca o resto da página com `aria-hidden` enquanto está
  // aberto, e `getByRole` IGNORA subárvore escondida — o locator do `tab` nunca
  // resolve. A primeira versão lia o contador com o painel aberto e estourava o
  // teto do teste em `locator.textContent`, o que aparece como "timeout" e é
  // indistinguível de produto quebrado. Levei duas execuções (30s e 120s) para
  // ver que o problema não era orçamento.
  const antesCancelados = await historico.getByRole("tab", { name: /Cancelados/ }).textContent();

  await cancelarBotao.click();
  await expect(page.getByTestId("painel-de-cancelamento")).toBeVisible({ timeout: 10_000 });

  const confirmar = page.getByTestId("confirmar-cancelamento");
  // O mínimo de 3 é o da ROTA. A tela o respeita para não produzir um 422 que a
  // pessoa não tem como prever.
  await expect(confirmar, "aceitou confirmar sem motivo — a rota devolveria 422").toBeDisabled();
  await page.getByTestId("motivo-do-cancelamento").fill("ab");
  await expect(confirmar, "dois caracteres passam, e a rota exige três").toBeDisabled();

  await page.getByTestId("motivo-do-cancelamento").fill("o paciente pediu por telefone");
  await expect(confirmar).toBeEnabled();

  await confirmar.click();

  // Sem `reload()`: a mutação invalida `["agenda"]` e o histórico repinta.
  await expect
    .poll(async () => historico.getByRole("tab", { name: /Cancelados/ }).textContent(), {
      timeout: 20_000,
      message: "a aba Cancelados não mudou — a tela não repintou depois do DELETE",
    })
    .not.toBe(antesCancelados);
});

test("remarcar pela tela: o painel abre em modo remarcar e o horário muda", async ({ page }) => {
  const creds = lerCreds();
  if (!creds.agenda) throw new Error("sem bloco agenda");
  const diasDaSemana = await entrar(page, creds);
  const rotuloOriginal = await marcarUm(page, creds.agenda.tipo_nome, diasDaSemana);

  const historico = page.getByTestId("historico-da-agenda");
  const remarcarBotao = historico.getByRole("button", { name: /^Remarcar$/ }).first();
  await expect(
    remarcarBotao,
    "o botão nasceu DESABILITADO — mesmo defeito do Cancelar",
  ).toBeEnabled({ timeout: 15_000 });

  await remarcarBotao.click();

  // O título prova que a tela sabe que é OUTRA operação — reusar o painel sem
  // dizer qual é faria a pessoa achar que está criando um segundo compromisso.
  await expect(page.getByRole("heading", { name: /Remarcar agendamento/ })).toBeVisible({
    timeout: 10_000,
  });

  await escolherDiaDesenhado(page, diasDaSemana);

  // Um horário DIFERENTE do original — senão "remarcou" e "não mudou nada" são
  // indistinguíveis, e a asserção passaria pelo motivo errado.
  const outro = page.locator(`[data-testid^="horario-"]:not([data-testid="horario-${rotuloOriginal}"])`).first();
  await expect(outro, "só havia um horário livre — o cenário não distingue remarcar de repetir").toBeVisible({
    timeout: 15_000,
  });
  const rotuloNovo = (await outro.getAttribute("data-testid"))!.replace("horario-", "");
  expect(rotuloNovo).not.toBe(rotuloOriginal);
  await outro.click();
  await page.getByTestId("confirmar-marcacao").click();

  await expect
    .poll(async () => (await historico.textContent()) ?? "", {
      timeout: 20_000,
      message: "o histórico não passou a mostrar o horário novo",
    })
    .toContain(rotuloNovo);
});
