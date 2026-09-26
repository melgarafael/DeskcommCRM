/**
 * QA EXPLORATÓRIO — o selo de autoria num funil DEPOIS DE USADO.
 *
 * ⚠️ POR QUE ESTE SPEC EXISTE, e é o tipo de coisa que só aparece usando. O E2E
 * da W4 mediu o selo numa instalação recém-nascida: oito etapas de fábrica sem
 * autoria e UMA criada pelo agente. Nesse estado o selo brilha, e foi assim que
 * eu o aprovei.
 *
 * O estado normal do produto não é esse. Depois de algumas semanas, o dono já
 * renomeou, reordenou e marcou etapas — e **toda etapa que ele tocou passa a
 * exibir "alterado por você/time" para sempre**, porque a coluna guarda a última
 * mudança, não um evento que expira. A pergunta que este spec responde é: com o
 * funil já vivido, o selo do ASSISTENTE ainda se distingue, ou afoga no meio das
 * confirmações do próprio usuário?
 *
 * Não é gate: é observação, e o resultado é uma captura para olhar.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const SAIDA = path.join(process.cwd(), "evidence", "ia-360-w4");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

/** Escreve no banco pelo container — é simulação de ESTADO, não de comportamento. */
function sql(query: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", "supabase_db_deskcomm-crm", "psql", "-U", "postgres", "-d", "postgres", "-t", "-c", query],
    { encoding: "utf8" },
  );
}

async function login(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.getByLabel(/e-?mail/i).fill(creds.users.manager!.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test.describe("QA — o selo de autoria com o funil já vivido", () => {
  test("quantos selos o dono vê depois de algumas semanas de uso", async ({ page }) => {
    test.setTimeout(180_000);
    fs.mkdirSync(SAIDA, { recursive: true });

    // Um mês de uso normal: o dono mexeu nas etapas em momentos diferentes.
    sql(`
      update crm_stages s set last_change_actor_kind='user',
             last_change_at = now() - (random()*30 || ' days')::interval
        from crm_pipelines p, organizations o
       where s.pipeline_id=p.id and p.organization_id=o.id and o.slug='e2e-test-org'
         and s.is_archived=false;
    `);
    // E o assistente mexeu em UMA, agora há pouco. É esta que precisa saltar.
    sql(`
      update crm_stages s set last_change_actor_kind='ai', last_change_at = now()
        from crm_pipelines p, organizations o
       where s.pipeline_id=p.id and p.organization_id=o.id and o.slug='e2e-test-org'
         and s.is_archived=false
         and s.id = (select s2.id from crm_stages s2 join crm_pipelines p2 on p2.id=s2.pipeline_id
                      join organizations o2 on o2.id=p2.organization_id
                     where o2.slug='e2e-test-org' and s2.is_archived=false
                     order by s2.position desc limit 1);
    `);

    await login(page);
    await page.goto(`${APP_URL}/app/settings/tenant/pipelines`);
    await page.waitForLoadState("networkidle");

    const doAgente = page.locator('[data-autoria="ai"]');
    const doHumano = page.locator('[data-autoria="user"]');
    const nAgente = await doAgente.count();
    const nHumano = await doHumano.count();

    console.info(`[QA] selos na tela → assistente: ${nAgente} · você/time: ${nHumano}`);
    console.info(
      `[QA] proporção do sinal que importa: ${nAgente}/${nAgente + nHumano} = ` +
        `${Math.round((nAgente / Math.max(1, nAgente + nHumano)) * 100)}%`,
    );

    // Medida por ferramenta, não a olho: quanto da altura da lista é selo?
    const alturas = await page.evaluate(() => {
      const selos = [...document.querySelectorAll("[data-autoria]")];
      const linhas = [...document.querySelectorAll('[data-testid^="etapa-"]')];
      const soma = (els: Element[]) =>
        els.reduce((t, e) => t + (e as HTMLElement).getBoundingClientRect().height, 0);
      return { selos: soma(selos), linhas: soma(linhas) };
    });
    const pct = Math.round((alturas.selos / Math.max(1, alturas.linhas)) * 100);
    console.info(
      `[QA] altura ocupada por selo: ${Math.round(alturas.selos)}px de ${Math.round(alturas.linhas)}px da lista (${pct}%)`,
    );

    await page.screenshot({
      path: path.join(SAIDA, "qa-selo-no-funil-usado.png"),
      fullPage: true,
    });
    console.info("[QA] captura salva: qa-selo-no-funil-usado.png");

    // Guarda de vacuidade: sem selo nenhum, os números acima não medem nada.
    expect(nAgente, "o estado simulado precisa produzir o selo do assistente").toBeGreaterThan(0);
    // Depois da correção: pessoa não gera selo. Se isto voltar a ser > 0, o ruído
    // que a medição de 13% expôs está de volta.
    expect(nHumano, "mudança feita por pessoa não deve gerar selo").toBe(0);
  });
});
