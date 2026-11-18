/**
 * Vínculos B2B pela tela (issue #3198, fatia 1).
 *
 * O defeito: com o módulo "Empresas e pessoas" ligado, dava para cadastrar
 * empresa, pessoa e contato — cada um sozinho — mas não ligar os três pela
 * tela. O lead que chega pelo WhatsApp vira contato com `person_id` nulo, e a
 * única forma de dizer "este número é da diretora da empresa X" era montar uma
 * planilha de uma linha e importar.
 *
 * Jornadas provadas:
 *   1. Módulo DESLIGADO: a ficha do contato fica exatamente como era — sem o
 *      cartão "Pessoa" e sem nenhuma chamada a `/api/v1/contacts/:id/person`.
 *   2. Módulo LIGADO, na ficha da pessoa: "Vincular contato" liga o telefone;
 *      o e-mail que só estava na ficha da pessoa vai, por "Juntar ao contato",
 *      para o contato do telefone; "Adicionar a uma empresa" liga a empresa com
 *      cargo e decisor. A ficha do
 *      contato passa a mostrar a pessoa e a empresa; a ficha da empresa mostra a
 *      pessoa; "Remover" desfaz o vínculo pessoa ↔ empresa (rota DELETE nova) e
 *      o banco confirma.
 *   3. Cadastro manual (empresa → pessoa → contato): na ficha da empresa, um nome
 *      que não existe se cria pelo botão do RODAPÉ (antes ele ficava desligado e
 *      a criação era um botão no meio do formulário); "Editar" corrige o decisor
 *      esquecido; na ficha da pessoa, um telefone novo abre "Novo contato", que
 *      grava telefone E e-mail no mesmo contato, já ligado — sem sair da tela; e
 *      a ficha da empresa mostra telefone e e-mail no grupo da pessoa.
 *   4. Lead do WhatsApp: na ficha do contato, "Ligar a uma pessoa" já abre com o
 *      nome do contato na busca e o rodapé cria a pessoa e liga o número.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/b2b-vinculos-pela-tela.spec.ts
 */
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { esperarARevelacaoNasCargas, test, expect, type Page } from "./helpers/test";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

test.describe.configure({ mode: "serial", timeout: 90_000 });

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

const CHAVE_MODULO = "MODULO_CRM_B2B";
const ESPERA = 30_000;
const EVIDENCIA = "evidence/2026-11-09-b2b-vinculos-pela-tela";
const sufixo = Date.now().toString(36).slice(-5);
const EMPRESA = `Família E2E ${sufixo}`;
const PESSOA = `Ana Diretora ${sufixo}`;
const CONTATO = `Ana WhatsApp ${sufixo}`;
const EMAIL_DA_FICHA = `ana.${sufixo}@exemplo.test`;
const TELEFONE = `+55169${Date.now().toString().slice(-8)}`;
// Cadastro manual (empresa → pessoa → contato): nomes e dados que ainda não existem.
const PESSOA_NOVA = `Carlos Novo ${sufixo}`;
const DIGITOS_NOVOS = (Number(Date.now().toString().slice(-8)) + 1).toString().padStart(8, "0");
const TELEFONE_NOVO = `+55169${DIGITOS_NOVOS}`;
const EMAIL_NOVO = `carlos.${sufixo}@exemplo.test`;

let creds: CredsE2E;
// Um login só para as duas jornadas: o TOTP do admin não aceita o mesmo código
// duas vezes, e logar de novo na mesma janela de 30 s derruba a segunda.
let page: Page;
let moduloAntes: string | null = null;
let orgId: string;
let empresaId: string;
let pessoaId: string;
let contatoId: string;
let pessoaNovaId: string | undefined;
let leadId: string | undefined;

async function modulo(valor: "ligado" | "desligado") {
  const r = await db
    .from("platform_config")
    .upsert(
      { chave: CHAVE_MODULO, valor, eh_segredo: false, semeado_do_env: false },
      { onConflict: "chave" },
    );
  if (r.error) throw r.error;
}

test.beforeAll(async ({ browser }, testInfo) => {
  mkdirSync(EVIDENCIA, { recursive: true });
  creds = lerCreds();
  const atual = await db
    .from("platform_config")
    .select("valor")
    .eq("chave", CHAVE_MODULO)
    .maybeSingle();
  if (atual.error) throw atual.error;
  moduloAntes = (atual.data?.valor as string | null) ?? null;

  const org = await db.from("organizations").select("id").eq("slug", "e2e-test-org").single();
  if (org.error ?? !org.data) throw org.error ?? new Error('organização "e2e-test-org" não encontrada');
  orgId = (org.data as { id: string }).id;

  const e = await db
    .from("companies")
    .insert({ organization_id: orgId, legal_name: `${EMPRESA} Ltda`, trade_name: EMPRESA })
    .select("id")
    .single();
  if (e.error) throw e.error;
  empresaId = e.data.id as string;

  const p = await db
    .from("people")
    .insert({
      organization_id: orgId,
      full_name: PESSOA,
      normalized_name: PESSOA.toLowerCase(),
      // E-mail só na ficha da pessoa: o "Juntar ao contato" o leva ao telefone.
      email: EMAIL_DA_FICHA,
    })
    .select("id")
    .single();
  if (p.error) throw p.error;
  pessoaId = p.data.id as string;

  // O contato como o WhatsApp o cria: sem pessoa.
  const c = await db
    .from("contacts")
    .insert({ organization_id: orgId, phone_number: TELEFONE, display_name: CONTATO })
    .select("id")
    .single();
  if (c.error) throw c.error;
  contatoId = c.data.id as string;

  page = await browser.newPage({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  esperarARevelacaoNasCargas(page);
  creds = await loginComoAdmin(page, creds);
});

test.afterAll(async () => {
  await page?.close();
  if (leadId) {
    const lead = await db.from("contacts").select("person_id").eq("id", leadId).maybeSingle();
    await db.from("contacts").delete().eq("id", leadId);
    const pessoaDoLead = (lead.data as { person_id: string | null } | null)?.person_id;
    if (pessoaDoLead) await db.from("people").delete().eq("id", pessoaDoLead);
  }
  if (pessoaNovaId) {
    await db.from("contacts").delete().eq("person_id", pessoaNovaId);
    await db.from("company_people").delete().eq("person_id", pessoaNovaId);
    await db.from("people").delete().eq("id", pessoaNovaId);
  }
  await db.from("contacts").delete().eq("id", contatoId);
  await db.from("company_people").delete().eq("person_id", pessoaId);
  await db.from("people").delete().eq("id", pessoaId);
  await db.from("companies").delete().eq("id", empresaId);
  if (moduloAntes === null) {
    await db.from("platform_config").delete().eq("chave", CHAVE_MODULO);
  } else {
    await modulo(moduloAntes as "ligado" | "desligado");
  }
});

test("módulo desligado: a ficha do contato fica como era, sem cartão nem chamada B2B", async () => {
  await modulo("desligado");
  const chamadasB2b: string[] = [];
  page.on("request", (req) => {
    if (/\/api\/v1\/(contacts\/[^/]+\/person|people|companies|company-people)/.test(req.url())) {
      chamadasB2b.push(req.url());
    }
  });

  await page.goto(`/app/contacts/${contatoId}`);
  await expect(page.getByRole("heading", { name: CONTATO })).toBeVisible({ timeout: ESPERA });
  // Dá tempo de qualquer efeito disparar antes de medir a ausência.
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: "Pessoa", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ligar a uma pessoa" })).toHaveCount(0);
  expect(chamadasB2b).toEqual([]);
  await page.screenshot({ path: `${EVIDENCIA}/1-contato-modulo-desligado.png`, fullPage: true });
});

test("módulo ligado: liga contato e empresa pela ficha da pessoa e desfaz pela da empresa", async () => {
  await modulo("ligado");

  // 1. Ficha do contato: o cartão aparece, ainda sem pessoa.
  await page.goto(`/app/contacts/${contatoId}`);
  await expect(page.getByText("Este telefone ainda não está ligado a uma pessoa.")).toBeVisible({
    timeout: ESPERA,
  });
  await page.screenshot({ path: `${EVIDENCIA}/2-contato-sem-pessoa.png`, fullPage: true });

  // 2. Ficha da pessoa: vincular o contato.
  await page.goto(`/app/people/${pessoaId}`);
  await expect(page.getByRole("heading", { name: PESSOA })).toBeVisible({ timeout: ESPERA });
  await page.getByRole("button", { name: "Vincular contato" }).click();
  const dialogoContato = page.getByRole("dialog");
  await dialogoContato.getByPlaceholder("Buscar contato por nome ou telefone").fill(CONTATO);
  await dialogoContato.getByRole("button", { name: new RegExp(CONTATO) }).click();
  await dialogoContato.getByRole("button", { name: "Vincular", exact: true }).click();
  await expect(dialogoContato).toHaveCount(0);
  await expect(page.getByRole("link", { name: TELEFONE })).toBeVisible({ timeout: ESPERA });

  // 2b. O e-mail que só existia na ficha da pessoa vai para o contato do
  //     telefone: vira clicável e o banco grava no contato.
  await expect(page.getByText("da ficha da pessoa")).toBeVisible();
  await page.getByRole("button", { name: "Juntar ao contato" }).click();
  await expect(page.getByRole("link", { name: EMAIL_DA_FICHA })).toBeVisible({ timeout: ESPERA });
  await expect(page.getByText("da ficha da pessoa")).toHaveCount(0);
  const comEmail = await db.from("contacts").select("email").eq("id", contatoId).single();
  expect(comEmail.data?.email).toBe(EMAIL_DA_FICHA);

  // 3. Ficha da pessoa: adicionar à empresa, com cargo e decisor.
  await page.getByRole("button", { name: "Adicionar a uma empresa" }).click();
  const dialogoEmpresa = page.getByRole("dialog");
  await dialogoEmpresa.getByPlaceholder("Buscar empresa por nome ou CNPJ").fill(EMPRESA);
  await dialogoEmpresa.getByRole("button", { name: new RegExp(EMPRESA) }).click();
  await dialogoEmpresa.getByLabel("Cargo").fill("Diretora financeira");
  await dialogoEmpresa.getByRole("switch").click();
  await page.screenshot({ path: `${EVIDENCIA}/3-pessoa-adicionar-empresa.png` });
  await dialogoEmpresa.getByRole("button", { name: "Adicionar", exact: true }).click();
  await expect(dialogoEmpresa).toHaveCount(0);
  await expect(page.getByRole("link", { name: EMPRESA })).toBeVisible({ timeout: ESPERA });
  await expect(page.getByText("Diretora financeira")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCIA}/4-pessoa-ligada.png`, fullPage: true });

  // O banco confirma o vínculo, com cargo e decisor, na organização certa.
  const vinculos = await db
    .from("company_people")
    .select("organization_id, company_id, job_title, is_decision_maker")
    .eq("person_id", pessoaId);
  expect(vinculos.data).toEqual([
    {
      organization_id: orgId,
      company_id: empresaId,
      job_title: "Diretora financeira",
      is_decision_maker: true,
    },
  ]);
  const contato = await db.from("contacts").select("person_id").eq("id", contatoId).single();
  expect(contato.data?.person_id).toBe(pessoaId);

  // 4. Ficha do contato: agora mostra a pessoa e a empresa.
  await page.goto(`/app/contacts/${contatoId}`);
  await expect(page.getByRole("link", { name: PESSOA })).toBeVisible({ timeout: ESPERA });
  await expect(page.getByRole("link", { name: EMPRESA })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCIA}/5-contato-com-pessoa.png`, fullPage: true });

  // 5. Ficha da empresa: a pessoa aparece; "Remover" desfaz o vínculo.
  await page.goto(`/app/companies/${empresaId}`);
  // O nome aparece duas vezes: no cartão das pessoas e no grupo dos telefones.
  await expect(page.getByRole("link", { name: PESSOA }).first()).toBeVisible({ timeout: ESPERA });
  await page.screenshot({ path: `${EVIDENCIA}/6-empresa-com-pessoa.png`, fullPage: true });
  await page.getByRole("button", { name: "Remover" }).click();
  await expect(page.getByText("Nenhuma pessoa vinculada.")).toBeVisible({ timeout: ESPERA });

  const depois = await db.from("company_people").select("id").eq("person_id", pessoaId);
  expect(depois.data).toEqual([]);
  // Desfazer o vínculo não apaga a pessoa nem a empresa.
  const pessoa = await db.from("people").select("id").eq("id", pessoaId);
  expect(pessoa.data).toHaveLength(1);
  await page.screenshot({ path: `${EVIDENCIA}/7-empresa-desvinculada.png`, fullPage: true });
});

test("cadastro manual: pessoa nova pela empresa, editar decisor e contato novo pela pessoa", async () => {
  await modulo("ligado");

  // 1. Ficha da empresa: nome que não existe + cargo; o botão do RODAPÉ cria.
  await page.goto(`/app/companies/${empresaId}`);
  await page.getByRole("button", { name: "Adicionar pessoa", exact: true }).click();
  const dialogo = page.getByRole("dialog");
  await dialogo.getByPlaceholder("Buscar pessoa por nome ou e-mail").fill(PESSOA_NOVA);
  await dialogo.getByLabel("Cargo").fill("Gerente comercial");
  const criar = dialogo.getByRole("button", { name: `Criar nova pessoa: ${PESSOA_NOVA}` });
  await expect(criar).toBeEnabled({ timeout: ESPERA });
  await page.screenshot({ path: `${EVIDENCIA}/8-empresa-criar-pessoa-pelo-rodape.png` });
  await criar.click();
  await expect(dialogo).toHaveCount(0);
  await expect(page.getByRole("link", { name: PESSOA_NOVA }).first()).toBeVisible({ timeout: ESPERA });

  const criada = await db
    .from("people")
    .select("id")
    .eq("organization_id", orgId)
    .eq("full_name", PESSOA_NOVA)
    .single();
  expect(criada.error).toBeNull();
  pessoaNovaId = (criada.data as { id: string }).id;

  // 2. Esqueceu o decisor: "Editar" corrige sem remover e ligar de novo.
  await page.getByRole("button", { name: `Editar vínculo: ${PESSOA_NOVA}` }).click();
  const edicao = page.getByRole("dialog");
  await expect(edicao.getByLabel("Cargo")).toHaveValue("Gerente comercial");
  await edicao.getByRole("switch").click();
  await edicao.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(edicao).toHaveCount(0);
  const vinculo = await db
    .from("company_people")
    .select("job_title, is_decision_maker")
    .eq("person_id", pessoaNovaId)
    .single();
  expect(vinculo.data).toEqual({ job_title: "Gerente comercial", is_decision_maker: true });
  await page.screenshot({ path: `${EVIDENCIA}/9-empresa-decisor-editado.png`, fullPage: true });

  // 3. Ficha da pessoa: telefone que não existe abre "Novo contato" com ele já
  //    preenchido; o e-mail entra no MESMO contato.
  await page.getByRole("link", { name: PESSOA_NOVA }).first().click();
  await expect(page.getByRole("heading", { name: PESSOA_NOVA })).toBeVisible({ timeout: ESPERA });
  await page.getByRole("button", { name: "Vincular contato" }).click();
  const busca = page.getByRole("dialog");
  const digitado = `16 9${DIGITOS_NOVOS}`;
  await busca.getByPlaceholder("Buscar contato por nome ou telefone").fill(digitado);
  await busca.getByRole("button", { name: `Criar contato: ${digitado}` }).click();

  const novo = page.getByRole("dialog", { name: "Novo contato" });
  await expect(novo.getByLabel("Telefone")).toHaveValue(digitado);
  await novo.getByLabel("E-mail").fill(EMAIL_NOVO);
  await page.screenshot({ path: `${EVIDENCIA}/10-pessoa-novo-contato-telefone-e-email.png` });
  await novo.getByRole("button", { name: "Criar contato", exact: true }).click();
  await expect(novo).toHaveCount(0);

  await expect(page.getByRole("link", { name: TELEFONE_NOVO })).toBeVisible({ timeout: ESPERA });
  await expect(page.getByText(EMAIL_NOVO, { exact: true })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCIA}/10b-pessoa-telefone-e-email.png`, fullPage: true });

  const contatos = await db
    .from("contacts")
    .select("phone_number, email, name, organization_id")
    .eq("person_id", pessoaNovaId);
  expect(contatos.data).toEqual([
    { phone_number: TELEFONE_NOVO, email: EMAIL_NOVO, name: PESSOA_NOVA, organization_id: orgId },
  ]);

  // 4. Ficha da empresa: o número e o e-mail aparecem no grupo da pessoa.
  await page.goto(`/app/companies/${empresaId}`);
  const grupo = page.getByRole("listitem", { name: `Telefones e e-mails: ${PESSOA_NOVA}` });
  await expect(grupo.getByRole("link", { name: TELEFONE_NOVO })).toBeVisible({ timeout: ESPERA });
  await expect(grupo.getByText(EMAIL_NOVO)).toBeVisible();
  await page.screenshot({ path: `${EVIDENCIA}/10c-empresa-agrupada-por-pessoa.png`, fullPage: true });
});

test("lead do WhatsApp: a ficha do contato cria a pessoa com o nome dele e liga", async () => {
  await modulo("ligado");
  const nomeDoLead = `Bruna Lead ${sufixo}`;
  const c = await db
    .from("contacts")
    .insert({
      organization_id: orgId,
      phone_number: `+55169${(Number(DIGITOS_NOVOS) + 1).toString().padStart(8, "0")}`,
      name: nomeDoLead,
    })
    .select("id")
    .single();
  if (c.error) throw c.error;
  leadId = c.data.id as string;

  await page.goto(`/app/contacts/${leadId}`);
  await page.getByRole("button", { name: "Ligar a uma pessoa" }).click({ timeout: ESPERA });
  const dialogo = page.getByRole("dialog");
  await expect(dialogo.getByPlaceholder("Buscar pessoa por nome ou e-mail")).toHaveValue(nomeDoLead);
  const criar = dialogo.getByRole("button", { name: `Criar nova pessoa: ${nomeDoLead}` });
  await expect(criar).toBeEnabled({ timeout: ESPERA });
  await page.screenshot({ path: `${EVIDENCIA}/11-contato-criar-pessoa.png` });
  await criar.click();
  await expect(dialogo).toHaveCount(0);
  await expect(page.getByRole("link", { name: nomeDoLead })).toBeVisible({ timeout: ESPERA });

  const lead = await db.from("contacts").select("person_id").eq("id", leadId).single();
  const pessoa = await db
    .from("people")
    .select("full_name, organization_id")
    .eq("id", (lead.data as { person_id: string }).person_id)
    .single();
  expect(pessoa.data).toEqual({ full_name: nomeDoLead, organization_id: orgId });
  await page.screenshot({ path: `${EVIDENCIA}/12-contato-com-pessoa-criada.png`, fullPage: true });
});
