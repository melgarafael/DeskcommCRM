/**
 * PROVA DE TELA — o rótulo da capacidade `crm_list_at_risk_leads` na tela em que
 * o dono do negócio decide se liga a capacidade no agente.
 *
 * Por que isto é prova e não formalidade: o passo 4 fez a capacidade passar a
 * listar TAMBÉM as demandas sem próximo passo. Se o rótulo continuasse dizendo
 * só "quem esfriou e está sem resposta", quem configura ligaria uma coisa
 * achando que ligou outra — invariante 5 (informação com propósito) na
 * superfície de configuração, que é onde a decisão acontece.
 *
 * Uso: `npx tsx tests/sonda-capacidade-radar-tela.ts`
 * Requer o app em produção na 3100 apontando para o Supabase LOCAL.
 */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const BASE = process.env.E2E_PORT ? `http://127.0.0.1:${process.env.E2E_PORT}` : "http://127.0.0.1:3100";
const AGENTE = "36ed74d7-3505-46ab-bc2b-9656626e118c"; // kind=mcp_agent — o rag_bot cai no editor legado, sem ToolPicker
const c = JSON.parse(readFileSync("/Users/rafaelmelgaco/SonghaiCRM/.e2e-creds.json", "utf8"));

async function main(): Promise<void> {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const erros: string[] = [];
  p.on("console", (m) => {
    if (m.type() === "error") erros.push(m.text());
  });

  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.click('input[type="email"]');
  await p.locator('input[type="email"]').pressSequentially(c.users.manager.email, { delay: 8 });
  await p.click('input[type="password"]');
  await p.locator('input[type="password"]').pressSequentially(c.password, { delay: 8 });
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/app/, { timeout: 30000 });

  await p.goto(`${BASE}/app/ai/agents/${AGENTE}`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);

  // A lista completa de capacidades vive atrás do modo avançado.
  const toggle = p.locator('[data-testid="toggle-avancado"]');
  if (await toggle.count()) {
    await toggle.first().click();
    await p.waitForTimeout(800);
  }

  const alvo = p.locator('[data-testid="capacidade-crm_list_at_risk_leads"]');
  await alvo.first().scrollIntoViewIfNeeded().catch(() => {});
  await p.waitForTimeout(300);

  const m = (await p.evaluate(`(() => {
    var el = document.querySelector('[data-testid="capacidade-crm_list_at_risk_leads"]');
    if (!el) return { presente: false };
    var r = el.getBoundingClientRect();
    var texto = el.innerText.replace(/\\s+/g, " ").trim();
    return {
      presente: true,
      texto: texto,
      // Medidas por ferramenta, nunca a olho.
      largura: Math.round(r.width),
      altura: Math.round(r.height),
      visivel: r.width > 0 && r.height > 0,
      dentro_da_viewport: r.left >= 0 && r.right <= window.innerWidth,
      scroll_horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      // O gate de linguagem proíbe jargão para quem configura.
      jargao: ["mcp","api","payload","uuid","schema","query","lead","stage"].filter(function (j) {
        return new RegExp("\\\\b" + j + "s?\\\\b", "i").test(texto);
      }),
    };
  })()`)) as Record<string, unknown>;

  console.log(JSON.stringify({ ...m, erros_de_console: erros }, null, 2));

  await p.screenshot({ path: "evidence/passo4-capacidade-radar.png", fullPage: false });
  await b.close();

  const texto = String(m.texto ?? "");
  const casos: Array<[string, boolean]> = [
    ["a capacidade está na tela", m.presente === true],
    ["o rótulo novo apareceu", texto.includes("ficou sem próximo passo")],
    ["a explicação cita quem está esperando", texto.includes("esperando sem que nada")],
    ["sem jargão para quem configura", (m.jargao as string[]).length === 0],
    ["sem scroll horizontal", m.scroll_horizontal === false],
    ["sem erro de console", erros.length === 0],
  ];
  let falhas = 0;
  for (const [nome, ok] of casos) {
    console.log(`${ok ? "  ok  " : "FALHA "} ${nome}`);
    if (!ok) falhas += 1;
  }
  console.log(falhas === 0 ? "\nTODOS OS CASOS PASSARAM" : `\n${falhas} CASO(S) FALHARAM`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
