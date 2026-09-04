/**
 * Sonda visual da migração Tailwind 3 → 4, em ambiente fresco estilo VPS.
 *
 * Mede por ferramenta (`getComputedStyle`), nunca a olho. O que prova, em ordem
 * de risco:
 *
 *  1. Os tokens continuam resolvendo. O `@theme inline` emite, dentro de
 *     `@layer theme`, linhas auto-referentes (`--color-bg: var(--color-bg)`)
 *     porque o produto já batizava seus tokens de `--color-*`. A teoria diz que
 *     elas perdem para o `:root` sem layer; isto é a medição que confirma.
 *  2. O tema escuro ainda troca os tokens.
 *  3. As classes de opacidade sobre token (`bg-muted/40`, `border-border/60`…)
 *     agora PINTAM. No v3 elas eram descartadas em silêncio — a cor com
 *     `var()` sem `<alpha-value>` fazia o Tailwind não emitir a regra.
 *  4. `border` sem cor continua na cor de borda do produto (regra do
 *     `@layer base`), e não em `currentColor`, que é o default novo do v4.
 *
 * ⚠️ Mede só elemento REAL da página. Injetar `<div class="p-7">` por JS não
 * prova nada: a classe não estava na fonte, o scanner nunca a viu, e o zero
 * medido seria artefato da sonda — não regressão.
 *
 * Uso: com o app de pé em :3001 contra o Supabase local,
 *   set -a; . ./.env.e2e; set +a && pnpm exec tsx tests/sonda-tailwind-4.ts
 */
import { chromium, type Page } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.SONDA_BASE ?? "http://localhost:3001";
const EMAIL = process.env.SONDA_EMAIL ?? "qa-tw4@deskcomm.local";
const SENHA = process.env.SONDA_SENHA ?? "SenhaForte#2026tw4";
const SAIDA = "evidence/tailwind-4";

const TOKENS = [
  "--color-bg", "--color-surface", "--color-surface-elevated", "--color-text",
  "--color-text-muted", "--color-border", "--color-accent", "--color-accent-500",
  "--color-error", "--radius-md", "--shadow-md", "--space-6", "--duration-fast",
];

/** As classes que o v3 descartava: se aparecerem na página, têm que pintar. */
const REVIVIDAS = [
  "bg-muted/40", "bg-muted/30", "bg-muted/50", "border-border/60",
  "bg-destructive/10", "border-destructive/30", "bg-primary/10",
  "text-muted-foreground/60", "text-muted-foreground/70", "bg-accent/50",
];

async function tokens(page: Page) {
  return page.evaluate((nomes) => {
    const cs = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const n of nomes) out[n] = cs.getPropertyValue(n).trim();
    out["__body_bg"] = getComputedStyle(document.body).backgroundColor;
    out["__body_color"] = getComputedStyle(document.body).color;
    return out;
  }, TOKENS);
}

/** Varre elementos REAIS da página e devolve o que o browser aplicou neles. */
async function medidasReais(page: Page) {
  return page.evaluate((revividas) => {
    // Sem função nomeada aqui dentro: o esbuild (via tsx) embrulha
    // `const f = () => …` num helper `__name()` que não existe no browser, e o
    // `page.evaluate` morre com "__name is not defined". O regex fica inline.
    const TRANSPARENTE = /^transparent$|rgba\(0,\s*0,\s*0,\s*0\)/;
    const achados: Record<string, unknown> = {};

    for (const classe of revividas) {
      const els = [...document.querySelectorAll<HTMLElement>("*")].filter((e) =>
        typeof e.className === "string" && e.className.split(/\s+/).includes(classe),
      );
      const primeiro = els[0];
      if (!primeiro) continue;
      const cs = getComputedStyle(primeiro);
      const alvo = classe.startsWith("bg-")
        ? cs.backgroundColor
        : classe.startsWith("border-")
          ? cs.borderTopColor
          : cs.color;
      achados[classe] = {
        ocorrencias: els.length,
        valor: alvo,
        // O que se quer ver: cor COM canal alfa < 1. `transparent` significa que
        // a classe não pintou; cor opaca significa que o alfa se perdeu.
        pinta: !TRANSPARENTE.test(alvo),
        temAlfa: /\/\s*0?\.\d+\)|,\s*0?\.\d+\)/.test(alvo),
      };
    }

    // `border` sem NENHUMA classe de cor — é o caso que depende inteiramente da
    // regra do `@layer base`. Duas exclusões que a primeira versão desta sonda
    // não tinha e que a faziam mentir: elemento que TAMBÉM traz `border-<cor>`
    // (aí a cor não vem da regra base), e o elemento em foco (o `<input>`
    // autofocado do login casa `focus-visible:border-accent-500` e media a cor
    // do foco, não a do token).
    const semCor = [...document.querySelectorAll<HTMLElement>("*")].find((e) => {
      if (typeof e.className !== "string") return false;
      const cs = e.className.split(/\s+/);
      if (!cs.includes("border")) return false;
      if (e === document.activeElement) return false;
      return !cs.some((c) => /^border-(?!\d|solid|dashed|dotted|none|t$|b$|l$|r$|[xy]$)/.test(c));
    });
    if (semCor) {
      achados["border (sem cor)"] = {
        ocorrencias: 1,
        valor: getComputedStyle(semCor).borderTopColor,
        corDoToken: getComputedStyle(document.documentElement)
          .getPropertyValue("--color-border").trim(),
      };
    }

    // Raio: `rounded-md` tem que valer o `--radius-md` (8px), que é o que o
    // `rounded` puro valia no v3 antes do renome.
    const arred = document.querySelector<HTMLElement>(".rounded-md");
    if (arred) achados["rounded-md"] = { valor: getComputedStyle(arred).borderTopLeftRadius };

    return achados;
  }, REVIVIDAS);
}

async function retrato(page: Page, nome: string, relatorio: Record<string, unknown>) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
  relatorio[`${nome}/claro`] = { url: page.url(), ...(await medidasReais(page)) };
  await page.screenshot({ path: `${SAIDA}/${nome}-claro.png`, fullPage: true });

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(250);
  relatorio[`${nome}/escuro`] = { tokens: await tokens(page), ...(await medidasReais(page)) };
  await page.screenshot({ path: `${SAIDA}/${nome}-escuro.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.waitForTimeout(150);
}

(async () => {
  fs.mkdirSync(SAIDA, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const relatorio: Record<string, unknown> = {};
  const erros: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
  page.on("pageerror", (e) => erros.push(String(e)));

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  relatorio["tokens/claro"] = await tokens(page);
  await retrato(page, "01-login", relatorio);

  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', SENHA);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);

  // Instalação fresca cai no onboarding — é a primeira impressão, o P0 da
  // doutrina de QA Visual. Percorre o que não depende de WAHA/Resend/Nuvemshop.
  const PASSOS = [
    ["02-onboarding-welcome", "/onboarding/welcome"],
    ["03-onboarding-funil", "/onboarding/funil"],
    ["04-onboarding-equipe", "/onboarding/invite-team"],
    ["05-onboarding-ia", "/onboarding/setup-ai"],
    ["06-onboarding-whatsapp", "/onboarding/connect-whatsapp"],
    ["07-conta", "/app/settings/profile"],
    ["08-seguranca", "/app/settings/security"],
    ["09-legal-privacidade", "/legal/privacy"],
  ] as const;

  for (const [nome, rota] of PASSOS) {
    await page.goto(`${BASE}${rota}`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await retrato(page, nome, relatorio);
  }

  relatorio["erros-de-console"] = erros;
  fs.writeFileSync(`${SAIDA}/medicoes.json`, JSON.stringify(relatorio, null, 2));
  await browser.close();
  console.log(`ok — ${erros.length} erro(s) de console`);
})();
