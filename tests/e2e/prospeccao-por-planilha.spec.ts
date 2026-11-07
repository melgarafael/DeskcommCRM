import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal, destinoEhLocal } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

/**
 * PROSPECÇÃO A PARTIR DA PRÓPRIA PLANILHA (spec 30).
 *
 * Quem tem a lista de empresas (feira, associação, planilha antiga) sobe um .csv e ela vira
 * uma campanha em rascunho, SEM busca paga e SEM chave de provedor. O que esta spec prova
 * PELA TELA, com valores exatos:
 *
 * 1. a aba "Usar minha planilha" funciona com a instalação sem chave de busca configurada;
 * 2. um CSV de 5 linhas (3 válidas, 1 sem telefone, 1 telefone repetido) mostra o resumo
 *    "3 entraram" e as duas recusadas com o número da linha como a planilha mostra;
 * 3. a campanha nova aparece com o rótulo "Planilha" e as 3 empresas na lista.
 *
 * Pré-requisitos (banco local do baseline, app buildada, SEM chave de provedor):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/prospeccao-por-planilha.spec.ts
 */

const env = carregarEnvLocal();
const URL_SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const admin = createClient(URL_SUPABASE, env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
  auth: { autoRefreshToken: false, persistSession: false },
});

const EVIDENCIA = path.join(process.cwd(), "evidence", "prospeccao-por-planilha");
const NOME_CAMPANHA = "E2E Lista da feira QA";

const CSV = [
  "empresa;telefone;site;segmento",
  "Padaria Alfa QA;(11) 98765-0001;;padaria",
  "Padaria Beta QA;(11) 98765-0002;;padaria",
  "Padaria Gama QA;(11) 98765-0003;;padaria",
  "Padaria Sem Fone QA;;;padaria",
  "Padaria Repetida QA;(11) 98765-0001;;padaria",
].join("\r\n");

async function limparCampanha(orgId: string): Promise<void> {
  const { data: campanhas } = await admin
    .from("prospecting_campaigns")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", NOME_CAMPANHA);
  for (const c of campanhas ?? []) {
    const id = (c as { id: string }).id;
    await admin.from("prospecting_candidates").delete().eq("organization_id", orgId).eq("campaign_id", id);
    await admin.from("prospecting_campaigns").delete().eq("organization_id", orgId).eq("id", id);
  }
}

function orgDoTeste(): string {
  const creds = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8")) as {
    org_id: string;
  };
  return creds.org_id;
}

test.describe("Prospecção a partir da própria planilha (spec 30)", () => {
  test.beforeAll(async () => {
    if (!destinoEhLocal(URL_SUPABASE)) {
      throw new Error(`RECUSADO: ${URL_SUPABASE} não é loopback — esta spec não escreve fora do local.`);
    }
    await limparCampanha(orgDoTeste());
  });

  test.afterAll(async () => {
    await limparCampanha(orgDoTeste());
  });

  test("sem chave de busca: 5 linhas viram 3 empresas, 2 recusadas com a linha, campanha 'Planilha'", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/prospecting");

    await page.getByRole("tab", { name: "Usar minha planilha" }).click();
    await expect(page.getByRole("tab", { name: "Usar minha planilha" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page
      .locator("#prospecting-arquivo")
      .setInputFiles({ name: "lista-qa.csv", mimeType: "text/csv", buffer: Buffer.from(CSV, "utf8") });
    await page.locator("#prospecting-lista-nome").fill(NOME_CAMPANHA);
    await page.locator("#prospecting-lista-nicho").fill("padarias");
    await page.locator("#prospecting-lista-origem").fill("clientes da feira QA");

    // 0. a conferência (#3724): mostra o que entra e o que fica de fora, e NÃO cria campanha.
    await page.getByRole("button", { name: "Conferir a lista antes de importar" }).click();
    await expect(page.getByText("3 entram · 2 ficam de fora", { exact: true })).toBeVisible();
    await expect(page.getByText("Linha 5: Sem telefone.", { exact: true })).toBeVisible();
    await expect(page.getByText("Nada foi importado ainda", { exact: false })).toBeVisible();
    const { count: campanhasNaPrevia } = await admin
      .from("prospecting_campaigns")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgDoTeste())
      .eq("name", NOME_CAMPANHA);
    expect(campanhasNaPrevia).toBe(0);

    // Não depende da chave do provedor: o botão está habilitado numa instalação sem ela.
    const importar = page.getByRole("button", { name: "Importar planilha" });
    await expect(importar).toBeEnabled();
    await importar.click();

    // 1. o resumo, com valores exatos.
    await expect(page.getByText("5 linhas · 3 entraram", { exact: false })).toBeVisible();
    await expect(page.getByText("2 ficam de fora", { exact: false })).toBeVisible();

    // 2. as recusadas, cada uma com o número da linha como a planilha mostra.
    await expect(page.getByText("Linha 5: Sem telefone.", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Linha 6: Telefone repetido na planilha. (linha 2)", { exact: true }),
    ).toBeVisible();

    // 3. a campanha nova, com o rótulo "Planilha" e as 3 empresas na lista.
    //
    // O nome aparece DUAS vezes na tela, e as duas são legítimas — não é duplicata
    // de UI: o `h2` é o título do painel da campanha (`_client.tsx`) e o `h3` é o
    // cabeçalho do resumo do agente (`_agent-summary.tsx`), que nasce com o nome da
    // campanha como padrão (`_create-agent.tsx`: `draft.name || campaign.name`).
    // Um `getByRole("heading", { name })` cru casa os dois e cai em strict mode
    // violation. O alvo desta asserção é o título do PAINEL, então o nível 2 é o
    // escopo certo: diz QUAL heading, em vez de esconder a duplicação com `.first()`.
    await expect(
      page.getByRole("heading", { level: 2, name: NOME_CAMPANHA, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: new RegExp(`${NOME_CAMPANHA}.*Planilha · .*3 empresas`) }),
    ).toBeVisible();
    await expect(page.getByRole("row", { name: /Padaria (Alfa|Beta|Gama) QA/ })).toHaveCount(3);
    await expect(page.getByRole("row", { name: /Padaria (Sem Fone|Repetida) QA/ })).toHaveCount(0);

    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "importacao-da-planilha.png"), fullPage: true });
  });
});
