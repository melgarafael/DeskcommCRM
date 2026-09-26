/**
 * O DADO QUE O CLIENTE DISSE, CONFIRMADO POR UMA PESSOA — pela TELA (§4b).
 *
 * A jornada inteira: a IA propõe (pela mesma função que a ferramenta MCP usa),
 * a pessoa abre a ficha do contato, **vê o que o cliente escreveu**, e decide.
 *
 * O que este spec guarda e nenhum teste de banco guardaria:
 *  1. a pendência APARECE, e com o trecho da conversa à vista;
 *  2. confirmar GRAVA na ficha — o dado que a IA nunca gravou sozinha;
 *  3. descartar tira da tela SEM gravar;
 *  4. decidida uma vez, a seção some — não fica botão para o que já acabou.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { email: string }>;
}

function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.users?.manager) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = lerCreds();
const sufixo = `${process.pid}`.slice(-6);

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

/** Cria contato + proposta pendente, como o turno da IA faria. */
async function cenario(page: Page, nome: string, valor: string, trecho: string): Promise<string> {
  const criado = await page.request.post("/api/v1/contacts", {
    data: { display_name: nome, source: "manual" },
  });
  expect(criado.status(), "não deu para criar o contato").toBe(201);
  const contatoId = ((await criado.json()) as { data: { contact: { id: string } } }).data.contact.id;

  const script = `
    import { createClient } from "@supabase/supabase-js";
    import { proporDadoDoContato } from "@/lib/contacts/proposta-de-dado";
    import { credenciaisSupabaseDeTeste } from "./lib/env-de-teste";
    const c = credenciaisSupabaseDeTeste();
    const db = createClient(c.url, c.serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
    async function main() {
      const r = await proporDadoDoContato(db, {
        organizationId: ${JSON.stringify(creds.org_id)},
        contactId: ${JSON.stringify(contatoId)},
        campo: "email",
        valor: ${JSON.stringify(valor)},
        trecho: ${JSON.stringify(trecho)},
      });
      if (!r.criada) throw new Error("proposta não criada: " + JSON.stringify(r));
      console.info("PROPOSTA_OK");
    }
    void main();
  `;
  const tmp = path.join(process.cwd(), "scripts", `zz-proposta-${sufixo}.ts`);
  fs.writeFileSync(tmp, script);
  try {
    // A proposta é criada pela MESMA função que a ferramenta MCP chama — não por
    // um insert à mão, que mentiria sobre a origem e sobre as recusas.
    const saida = execFileSync("npx", ["tsx", tmp], { encoding: "utf8" });
    expect(saida, "a proposta precisa ter sido criada de verdade").toContain("PROPOSTA_OK");
  } finally {
    fs.unlinkSync(tmp);
  }
  return contatoId;
}

test.describe("o dado que o cliente disse espera confirmação", () => {
  test("aparece na ficha com o trecho, e CONFIRMAR grava", async ({ page }) => {
    await login(page);
    const email = `disse.${sufixo}@exemplo.com.br`;
    const contatoId = await cenario(
      page,
      `Cliente Proposta ${sufixo}`,
      email,
      `pode anotar meu email: ${email}`,
    );

    await page.goto(`/app/contacts/${contatoId}`);

    // A pendência aparece — e diz que nada foi salvo ainda.
    await expect(page.getByText(/o assistente ouviu isto na conversa/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/nada foi salvo ainda/i)).toBeVisible();

    // O TRECHO está à vista: confirmar sem ver o que a pessoa escreveu seria
    // um ato de fé, e o botão ficaria mais fácil de clicar do que de conferir.
    await expect(page.getByText(`pode anotar meu email: ${email}`)).toBeVisible();

    // Controle: o e-mail AINDA NÃO está na ficha. Sem esta linha, a asserção
    // final passaria mesmo que a IA tivesse gravado sozinha — que é justamente
    // o que a fila existe para impedir.
    const fichaAntes = await page.request.get(`/api/v1/contacts/${contatoId}`);
    const antes = (await fichaAntes.json()) as { data: { email?: string | null } };
    expect(antes.data.email, "a IA não pode ter gravado").toBeFalsy();

    await page.getByRole("button", { name: /está certo, salvar/i }).click();

    // A pendência some — não fica botão para o que já foi decidido.
    await expect(page.getByText(/o assistente ouviu isto na conversa/i)).toHaveCount(0, {
      timeout: 20_000,
    });

    // ⚠️ O e-mail é procurado NO CABEÇALHO da ficha, não na página inteira.
    //
    // A primeira versão fazia `getByText(email)` solto e passava SEM o dado ter
    // chegado à ficha: o trecho da conversa contém o próprio e-mail
    // ("pode anotar meu email: X"), então o localizador casava com a citação da
    // proposta. Falso verde — e só apareceu ao OLHAR a screenshot, que mostrava
    // o campo EMAIL vazio enquanto o teste dizia verde.
    await expect(
      page.locator("header").getByText(email),
      "o e-mail confirmado tem de aparecer na FICHA, não só na citação",
    ).toBeVisible({ timeout: 20_000 });

    // E veio do banco, não do estado da tela.
    await page.reload();
    await expect(page.locator("header").getByText(email)).toBeVisible({ timeout: 20_000 });

    await page.screenshot({ path: "evidence/spec-17/proposta-confirmada.png", fullPage: true });
  });

  test("DESCARTAR tira da tela sem gravar", async ({ page }) => {
    await login(page);
    const email = `errado.${sufixo}@exemplo.com.br`;
    const contatoId = await cenario(
      page,
      `Cliente Descarte ${sufixo}`,
      email,
      `acho que era ${email}, mas não tenho certeza`,
    );

    await page.goto(`/app/contacts/${contatoId}`);
    await expect(page.getByText(/o assistente ouviu isto na conversa/i)).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("button", { name: /descartar/i }).click();
    await expect(page.getByText(/o assistente ouviu isto na conversa/i)).toHaveCount(0, {
      timeout: 20_000,
    });

    // O dado NÃO entrou. Descartar precisa ser tão real quanto confirmar.
    await page.reload();
    const ficha = await page.request.get(`/api/v1/contacts/${contatoId}`);
    const dados = (await ficha.json()) as { data: { email?: string | null } };
    expect(dados.data.email, "descartar não pode gravar").toBeFalsy();
  });
});
