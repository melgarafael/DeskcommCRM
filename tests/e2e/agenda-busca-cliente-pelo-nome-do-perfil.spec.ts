import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal, destinoEhLocal } from "../../scripts/lib/env-de-teste";

/**
 * QUEM SÓ TEM NOME DE PERFIL DO WHATSAPP PRECISA SER ACHÁVEL (PR #1070).
 *
 * A ingestão grava o `pushName` do aparelho em `contacts.display_name`
 * (`fn_upsert_wa_contact`); `contacts.name` é a coluna que um humano preenche.
 * Num CRM que nasce do WhatsApp, o caso DOMINANTE é o contato que tem
 * `display_name` e **não tem** `name` — e antes do #1070 a rota de vínculos da
 * agenda selecionava `id,name` e buscava com `ilike("name", …)`. Efeito na
 * tela: digitar o nome que a pessoa usa no WhatsApp não achava ninguém, e
 * quando ela vinha por outro caminho o `<option>` saía **em branco**, porque o
 * que a tela desenha é `c.name`.
 *
 * Hoje a rota lê `display_name` também, busca nas duas colunas com um `or(…)` e
 * devolve o rótulo por `rotuloDoContato` — a MESMA régua de nome do resto do
 * produto (issue #906): `name` primeiro, `display_name` depois, telefone por
 * último.
 *
 * ─── O controle é a outra metade da régua ────────────────────────────────
 *
 * Um conserto que simplesmente trocasse a coluna (`display_name` vencendo
 * `name`) também faria o primeiro caso passar — e inverteria a régua do
 * produto: quem editou o cadastro do cliente veria de volta o apelido que o
 * aparelho dele anuncia. Por isso o segundo contato tem as DUAS colunas
 * preenchidas, com valores distinguíveis, e a asserção é sobre QUAL delas
 * aparece.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/agenda-busca-cliente-pelo-nome-do-perfil.spec.ts
 */

const ESPERA = 30_000;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), "evidence/triagem-17set-37-agenda");

/** Só perfil do WhatsApp: `name` NULO de propósito — é o caso que o #1070 fecha. */
const SO_PERFIL = { display_name: "Cíntia Nunes", phone_number: "+5511977770001" };
/** O controle: as duas colunas preenchidas, e o cadastro tem de vencer o apelido. */
const COM_CADASTRO = {
  name: "Maria Controle",
  display_name: "Mari WhatsApp",
  phone_number: "+5511977770002",
};

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: unknown;
}

const env = carregarEnvLocal();
const URL_SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const admin = createClient(URL_SUPABASE, env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
  auth: { autoRefreshToken: false, persistSession: false },
});

function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

/**
 * Semeia os dois contatos, e ANUNCIA o destino antes de escrever.
 *
 * O alarme não é cerimônia: `scripts/lib/env-de-teste.ts` existe porque a suíte
 * já semeou organizações e usuários de teste no banco de PRODUÇÃO por ler o
 * `.env.local` de um checkout de trabalho. Aqui a escrita PARA quando o destino
 * não é loopback, em vez de só avisar.
 */
async function semearContatos(orgId: string): Promise<void> {
  console.info(`[agenda-busca-cliente] escrevendo em ${URL_SUPABASE}`);
  if (!destinoEhLocal(URL_SUPABASE)) {
    throw new Error(`RECUSADO: ${URL_SUPABASE} não é loopback — esta spec não escreve fora do local.`);
  }
  for (const contato of [SO_PERFIL, COM_CADASTRO]) {
    const { data: existente } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("phone_number", contato.phone_number)
      .maybeSingle();
    // Idempotente E auto-curativo: o banco é compartilhado entre frentes, e um
    // contato deixado por outra rodada com as colunas erradas faria esta spec
    // medir a fixture de ontem.
    if (existente) {
      const { error } = await admin
        .from("contacts")
        .update({ name: null, is_anonymized: false, ...contato } as never)
        .eq("id", (existente as { id: string }).id);
      if (error) throw new Error(`contacts update: ${error.message}`);
      continue;
    }
    const { error } = await admin
      .from("contacts")
      .insert({ organization_id: orgId, ...contato } as never);
    if (error) throw new Error(`contacts insert: ${error.message}`);
  }
}

/** Abre "Novo agendamento" e devolve o `<select>` de "Quem será atendido". */
async function abrirONovoAgendamento(page: Page): Promise<Locator> {
  await page.goto("/app/agenda");
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: ESPERA });
  await page.getByTestId("novo-agendamento").click();
  // Antes eram DOIS controles — um campo "Buscar cliente" e um `select`
  // "Quem será atendido". Viraram UM combobox, com o mesmo rótulo do segundo:
  // quem marca digita o nome e escolhe na lista, sem passar por dois lugares.
  // Esperar o rótulo antigo aqui só fazia a spec esgotar os 30s no campo que
  // deixou de existir.
  const quemSeraAtendido = page.getByTestId("quem-sera-atendido");
  await expect(quemSeraAtendido).toBeVisible({ timeout: ESPERA });
  return quemSeraAtendido;
}

/**
 * Os rótulos que a lista oferece, fora o "sem cliente".
 *
 * A lista deixou de ser `<option>` dentro de um `<select>` e passou a ser
 * `role="option"` dentro do `listbox` do combobox — o `aria-controls` do campo
 * diz qual é, então este leitor não depende da ordem dos elementos na página.
 */
async function clientesOferecidos(quemSeraAtendido: Locator) {
  const listaId = await quemSeraAtendido.getAttribute("aria-controls");
  if (!listaId) return [];
  const textos = await quemSeraAtendido
    .page()
    .locator(`#${listaId} [role="option"]`)
    .allTextContents();
  return textos.map((t) => t.trim()).filter((t) => t !== "" && !/sem cliente/i.test(t));
}

test("digitar o nome do perfil do WhatsApp acha o contato — e ele aparece COM nome", async ({
  page,
}) => {
  const creds = lerCreds();
  if (!creds.org_id) throw new Error(".e2e-creds.json sem org_id");
  await semearContatos(creds.org_id);

  // `manager` (>= o piso `agent` da rota de vínculos) e não o admin: o admin do
  // seed tem MFA com challenge, e esta spec não é sobre login.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.locator("#email").fill(usuario.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: ESPERA });

  const quemSeraAtendido = await abrirONovoAgendamento(page);
  await quemSeraAtendido.fill("Cíntia");

  await expect
    .poll(() => clientesOferecidos(quemSeraAtendido), {
      timeout: ESPERA,
      message:
        'busquei "Cíntia" e a lista de clientes não ofereceu ninguém — o contato tem ' +
        "`display_name` e `name` NULO, que é o caso dominante de um CRM de WhatsApp",
    })
    .toContain(SO_PERFIL.display_name);

  // A metade que o "achou" não prova: o `<option>` tem de trazer NOME, e não a
  // string vazia que a rota devolvia quando lia só `contacts.name`.
  const opcao = quemSeraAtendido.page().locator('[role="option"]', { hasText: SO_PERFIL.display_name });
  await expect(opcao).toHaveCount(1);
  expect(
    (await opcao.innerText()).trim(),
    "a opção veio vazia — quem não tem `name` continua sem rótulo na lista",
  ).not.toBe("");

  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, "1070-busca-pelo-nome-do-perfil.png"), fullPage: true });

  // ── CONTROLE: o cadastro vence o apelido do aparelho ──────────────────
  //
  // "Mari" casa as DUAS colunas deste contato, então ele é achado de qualquer
  // jeito. O que se mede é o RÓTULO: `rotuloDoContato` põe `name` primeiro, e um
  // conserto que só trocasse a coluna da busca inverteria a régua do produto —
  // quem editou o cadastro veria de volta o apelido do WhatsApp.
  await quemSeraAtendido.fill("Mari");
  await expect
    .poll(() => clientesOferecidos(quemSeraAtendido), {
      timeout: ESPERA,
      message: 'busquei "Mari" e a lista não ofereceu o contato de controle',
    })
    .toContain(COM_CADASTRO.name);
  await expect(
    quemSeraAtendido.page().locator('[role="option"]', { hasText: COM_CADASTRO.display_name }),
    `a lista mostrou o apelido do aparelho ("${COM_CADASTRO.display_name}") no lugar do ` +
      `cadastro ("${COM_CADASTRO.name}") — na régua de nome do produto o cadastro vem primeiro`,
  ).toHaveCount(0);

  await page.screenshot({ path: path.join(EVIDENCIA, "1070-controle-cadastro-vence-apelido.png"), fullPage: true });

  // ── CONTROLE DA SONDA: ela precisa saber devolver VAZIO ───────────────
  //
  // Sem isto, um seletor quebrado que casasse qualquer coisa deixaria as duas
  // asserções acima passando por vacuidade.
  await quemSeraAtendido.fill("Zzqq Inexistente");
  await expect
    .poll(() => clientesOferecidos(quemSeraAtendido), {
      timeout: ESPERA,
      message: "um termo que não existe devolveu clientes — a sonda não distingue nada",
    })
    .toEqual([]);
});
