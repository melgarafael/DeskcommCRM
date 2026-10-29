/**
 * FICHA COM VÁRIOS TELEFONES — provado PELA TELA (Spec 31, parte B2).
 *
 * O banco (`contact_phones`, `fn_tornar_telefone_principal`, a regra "um número,
 * uma ficha") tem prova própria em `tests/invariants/`. O que este spec guarda é
 * a outra metade, que `curl` não alcança: o bloco "Telefones" da ficha deixa a
 * pessoa adicionar um segundo número com tipo e WhatsApp, tornar o extra
 * principal (e o antigo principal vira extra), remover o extra, e recebe da
 * própria API a recusa de um número que já é de outra ficha.
 *
 * Toda asserção de efeito é relida do BANCO (com a organização das credenciais
 * no filtro) e da TELA depois de `reload()`, porque a lista da ficha fica em
 * cache do React Query. Espera de rede é `waitForResponse`, não tempo fixo.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/ficha-com-varios-telefones.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

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

/**
 * Sufixo único por execução: o banco de e2e é compartilhado e `phone_number` tem
 * índice único por organização. Os números são de celular (DDD 43, nono dígito).
 */
const SUFIXO = `${Date.now()}`.slice(-8);
/** `+55` + DDD 43 + nono dígito `9` + 8 dígitos: 13 dígitos, celular. */
const numeroCom8 = (n: number) => `+55439${String(n % 100_000_000).padStart(8, "0")}`;
const NUMERO_PRINCIPAL = numeroCom8(Number(SUFIXO));
const NUMERO_EXTRA = numeroCom8(Number(SUFIXO) + 1);
const NUMERO_DE_OUTRA_FICHA = numeroCom8(Number(SUFIXO) + 2);
const ROTULO_EXTRA = `Trabalho ${SUFIXO}`;
const NOME_FICHA = `Ficha Telefones ${SUFIXO}`;
const NOME_OUTRA = `Ficha Telefones Outra ${SUFIXO}`;

let idFicha = "";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

/** Apaga as fichas deste spec por prefixo de nome (inclui restos de runs vermelhos). */
async function limparFixtures(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("display_name", "Ficha Telefones%");
  const ids = ((data ?? []) as { id: string }[]).map((c) => c.id);
  if (ids.length === 0) return;
  await admin.from("contacts").update({ is_merged_into: null }).in("id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

async function criarContato(nome: string, telefone: string): Promise<string> {
  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: creds.org_id,
      display_name: nome,
      name: nome,
      phone_number: telefone,
    })
    .select("id")
    .single();
  if (error) throw new Error(`contato ${nome}: ${error.message}`);
  return (data as { id: string }).id;
}

/** Os telefones extras da ficha, lidos do BANCO filtrando pela organização. */
async function extrasNoBanco(contatoId: string): Promise<{ phone_number: string; tipo: string; whatsapp: string; rotulo: string | null }[]> {
  const { data, error } = await admin
    .from("contact_phones")
    .select("phone_number, tipo, whatsapp, rotulo")
    .eq("organization_id", creds.org_id)
    .eq("contact_id", contatoId);
  if (error) throw new Error(`contact_phones: ${error.message}`);
  return (data ?? []) as { phone_number: string; tipo: string; whatsapp: string; rotulo: string | null }[];
}

/** O principal da ficha, lido do BANCO filtrando pela organização. */
async function principalNoBanco(contatoId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("contacts")
    .select("phone_number")
    .eq("organization_id", creds.org_id)
    .eq("id", contatoId)
    .single();
  if (error) throw new Error(`contacts: ${error.message}`);
  return (data as { phone_number: string | null }).phone_number;
}

/** Só os dígitos: a tela formata o número, e o banco guarda o `+55…`. */
function digitos(texto: string): string {
  return texto.replace(/\D/g, "");
}

/** Abre a ficha e espera o nome dela aparecer no título. */
async function abrirFicha(page: Page, id: string): Promise<void> {
  await page.goto(`/app/contacts/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(NOME_FICHA, { timeout: 30_000 });
}

/**
 * O bloco "Telefones" da ficha, e só ele: a ficha tem outras listas, e "Principal"
 * e "Remover" também podem aparecer fora dele.
 */
function blocoDeTelefones(page: Page) {
  return page.locator("dt", { hasText: /^Telefones?$/ }).locator("xpath=..");
}

test.describe("Ficha com vários telefones — editar pela tela", () => {
  test.describe.configure({ timeout: 240_000, mode: "serial" });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limparFixtures();
    idFicha = await criarContato(NOME_FICHA, NUMERO_PRINCIPAL);
    await criarContato(NOME_OUTRA, NUMERO_DE_OUTRA_FICHA);
  });

  test.afterAll(async () => {
    await limparFixtures();
  });

  test("adicionar um celular com WhatsApp: o número aparece na ficha e fica gravado no banco", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await abrirFicha(page, idFicha);

    await page.getByRole("button", { name: "Adicionar telefone", exact: true }).click();
    await page.locator("#telefone-novo-numero").fill(NUMERO_EXTRA);
    await page.locator("#telefone-tipo").click();
    await page.getByRole("option", { name: "Celular", exact: true }).click();
    await page.locator("#telefone-whatsapp").click();
    await page.getByRole("option", { name: "Tem WhatsApp", exact: true }).click();
    await page.locator("#telefone-rotulo").fill(ROTULO_EXTRA);

    const resposta = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/contacts/${idFicha}/phones`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    expect((await resposta).status()).toBeLessThan(300);

    // Relido da tela depois de recarregar: a lista da ficha fica em cache.
    await page.reload();
    await expect(page.locator("dt", { hasText: /^Telefones$/ })).toBeVisible({ timeout: 20_000 });
    const linhaDoExtra = blocoDeTelefones(page).getByRole("listitem").filter({ hasText: ROTULO_EXTRA });
    await expect(linhaDoExtra).toBeVisible();
    expect(digitos(await linhaDoExtra.innerText())).toContain(digitos(NUMERO_EXTRA));
    await expect(linhaDoExtra).toContainText("Tem WhatsApp");

    // Do banco: o extra existe, com o tipo e o WhatsApp escolhidos.
    const extras = await extrasNoBanco(idFicha);
    expect(extras).toHaveLength(1);
    expect(extras[0]).toMatchObject({ tipo: "celular", whatsapp: "sim", rotulo: ROTULO_EXTRA });
  });

  test("tornar principal troca o extra e o principal antigo, nos dois sentidos, e a remoção do principal fica travada", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await abrirFicha(page, idFicha);

    // Enquanto há extra, remover o principal está desabilitado e diz por quê.
    const removerDoPrincipal = blocoDeTelefones(page)
      .getByRole("listitem")
      .filter({ has: page.getByText("Principal", { exact: true }) })
      .getByRole("button", { name: "Remover", exact: true });
    await expect(removerDoPrincipal).toBeDisabled();
    await expect(page.getByText("Torne outro número principal antes de remover este.")).toBeVisible();

    // O extra é a linha sem o selo "Principal". `hasNotText` não serve: ele não diferencia
    // maiúscula e casaria com o botão "Tornar principal", que só o extra tem.
    const linhaDoExtra = blocoDeTelefones(page)
      .getByRole("listitem")
      .filter({ hasNot: page.getByText("Principal", { exact: true }) });
    const resposta = page.waitForResponse(
      (r) => r.url().includes("/primary") && r.request().method() === "POST",
    );
    await linhaDoExtra.getByRole("button", { name: "Tornar principal", exact: true }).click();
    expect((await resposta).status()).toBeLessThan(300);

    // No banco: o principal agora é o número do extra; o antigo virou extra.
    expect(digitos((await principalNoBanco(idFicha)) ?? "")).toBe(digitos(NUMERO_EXTRA));
    const extras = await extrasNoBanco(idFicha);
    expect(extras.map((e) => digitos(e.phone_number))).toContain(digitos(NUMERO_PRINCIPAL));

    // Volta a troca: o número antigo volta a ser o principal, e o outro vira extra.
    await page.reload();
    const linhaDoAntigo = blocoDeTelefones(page)
      .getByRole("listitem")
      .filter({ hasNot: page.getByText("Principal", { exact: true }) });
    await expect(linhaDoAntigo).toHaveCount(1, { timeout: 20_000 });
    const resposta2 = page.waitForResponse(
      (r) => r.url().includes("/primary") && r.request().method() === "POST",
    );
    await linhaDoAntigo.getByRole("button", { name: "Tornar principal", exact: true }).click();
    expect((await resposta2).status()).toBeLessThan(300);
    expect(digitos((await principalNoBanco(idFicha)) ?? "")).toBe(digitos(NUMERO_PRINCIPAL));
  });

  test("remover o extra faz ele sumir da lista e do banco", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await abrirFicha(page, idFicha);

    // Depois da troca de principal o extra perdeu o rótulo: é a linha sem "Principal".
    const linhaDoExtra = blocoDeTelefones(page)
      .getByRole("listitem")
      .filter({ hasNot: page.getByText("Principal", { exact: true }) });
    await expect(linhaDoExtra).toHaveCount(1, { timeout: 20_000 });
    const resposta = page.waitForResponse(
      (r) => r.url().includes("/phones/") && r.request().method() === "DELETE",
    );
    await linhaDoExtra.getByRole("button", { name: "Remover", exact: true }).click();
    expect((await resposta).status()).toBeLessThan(300);

    await page.reload();
    // Sem extra, o selo "Principal" some da lista (a linha volta a ser "Telefone").
    await expect(blocoDeTelefones(page).getByText("Principal", { exact: true })).toHaveCount(0, {
      timeout: 20_000,
    });
    expect(await extrasNoBanco(idFicha)).toHaveLength(0);
  });

  test("um número que já é de outra ficha é recusado na tela, com a mensagem da API", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    // Pré-condição: a outra ficha tem o número. Ele entra como extra da ficha de teste.
    await abrirFicha(page, idFicha);

    await page.getByRole("button", { name: "Adicionar telefone", exact: true }).click();
    await page.locator("#telefone-novo-numero").fill(NUMERO_DE_OUTRA_FICHA);
    const resposta = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/contacts/${idFicha}/phones`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    expect((await resposta).status()).toBe(409);

    await expect(blocoDeTelefones(page).getByRole("alert")).toContainText("Este número já está em outra ficha.");
    // Nada foi gravado: a ficha de teste continua sem extra desse número.
    const extras = await extrasNoBanco(idFicha);
    expect(extras.map((e) => digitos(e.phone_number))).not.toContain(digitos(NUMERO_DE_OUTRA_FICHA));
  });
});
