/**
 * O INBOX CABE NA TELA — regressão de layout, medida por ferramenta.
 *
 * ## O defeito que esta sonda existe para não deixar voltar
 *
 * O `xl` do Tailwind dispara em 1280px, e era ali que a terceira coluna do
 * inbox nascia — no ponto exato em que não havia espaço para ela. Medido: o
 * painel de CRM ficava **311px fora da viewport em 1280px** e 151px em 1440px.
 * Alcançável só rolando o `main` de lado, que ninguém faz. Na prática, em
 * 1280px o atendente não via contexto nenhum do cliente.
 *
 * A causa não era o grid: era o `ConversationHeader`, cujo `min-content` era
 * **707px** porque a barra de ações era `shrink-0`. `1fr` é
 * `minmax(auto, 1fr)` e não encolhe abaixo do conteúdo.
 *
 * ## Por que sonda de browser e não teste unitário
 *
 * `min-content`, quebra de flex e resolução de `grid-template-columns` são
 * cálculo de layout. O jsdom não tem engine de layout: um teste lá mediria
 * zero em tudo e passaria feliz — verde por ausência de motor, o pior falso
 * verde que existe. Só um browser real responde a esta pergunta.
 *
 * A catraca barata que roda no CI é `tests/unit/inbox-header-nao-trava.test.tsx`;
 * esta sonda é a medição de verdade.
 *
 * Uso: `npx tsx tests/sonda-inbox-cabe-na-tela.ts`
 * Requer o app na 3100 apontando para o Supabase LOCAL.
 */
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.E2E_PORT ? `http://127.0.0.1:${process.env.E2E_PORT}` : "http://127.0.0.1:3100";
const CONVERSA = "8b9fcd5f-252d-4f6b-9538-f7c2c538807f";
const c = JSON.parse(readFileSync("/Users/rafaelmelgaco/SonghaiCRM/.e2e-creds.json", "utf8"));

/** 1280 e 1366 são as apertadas; 1920 é o controle de que nada regrediu no largo. */
const LARGURAS = [1280, 1366, 1440, 1536, 1920];

/**
 * Piso de leitura da conversa. Abaixo disso o thread fica mais estreito que o
 * próprio composer (min-content medido: 370px) e a coluna volta a travar. O
 * número é a régua, e viaja com o resultado — sem ele, "cabe" não diz se cabe
 * com folga ou por um fio.
 */
const THREAD_MIN = 400;

async function main(): Promise<void> {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const erros: string[] = [];
  p.on("console", (m) => {
    if (m.type() === "error") erros.push(m.text());
  });

  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.click('input[type="email"]');
  await p.locator('input[type="email"]').pressSequentially(c.users.manager.email, { delay: 6 });
  await p.click('input[type="password"]');
  await p.locator('input[type="password"]').pressSequentially(c.password, { delay: 6 });
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/app/, { timeout: 30000 });
  await p.goto(`${BASE}/app/inbox?id=${CONVERSA}`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2500);

  const linhas: Array<Record<string, unknown>> = [];
  for (const w of LARGURAS) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.waitForTimeout(600);
    linhas.push(
      (await p.evaluate(`(() => {
        var sec = document.querySelector('[data-testid="inbox-demandas"]');
        if (!sec) return { viewport: window.innerWidth, sem_painel: true };
        var aside = sec.closest("aside");
        var grid = aside.parentElement;
        while (grid && getComputedStyle(grid).display !== "grid") grid = grid.parentElement;
        var meio = grid.children[1];
        var hdr = meio.children[0];
        var main = grid.closest("main");
        var ar = aside.getBoundingClientRect();
        var hr = hdr.getBoundingClientRect();
        // Ação perdida = largura zero, ou fora do retângulo do próprio header.
        // Reorganizar é aceitável; esconder ação de quem atende, não.
        //
        // "Ver contato" fica de FORA desta contagem por decisão explícita: a
        // partir de xl ele some do header porque o painel lateral, que acabou de
        // entrar na tela, tem a mesma porta para o mesmo contato. A verificação
        // dele é o caso contato_alcancavel abaixo — que é a pergunta certa
        // ("dá para chegar ao contato?"), e não "este botão específico está
        // visível aqui".
        var acoes = hdr.children[1];
        var botoes = Array.prototype.slice
          .call(acoes.querySelectorAll("button, a"))
          .filter(function (x) { return !/Ver contato/.test(x.innerText || ""); });
        // A porta para o contato existe em ALGUM lugar da tela — header ou painel.
        var portas = Array.prototype.slice
          .call(document.querySelectorAll("a"))
          .filter(function (x) {
            return /Ver contato/.test(x.innerText || "") && x.getBoundingClientRect().width > 0;
          });
        return {
          viewport: window.innerWidth,
          aside_fora: Math.round(Math.max(0, ar.right - window.innerWidth)),
          aside_w: Math.round(ar.width),
          thread_w: Math.round(meio.getBoundingClientRect().width),
          header_h: Math.round(hr.height),
          botoes: botoes.length,
          botoes_perdidos: botoes.filter(function (x) {
            var r = x.getBoundingClientRect();
            return r.width < 1 || r.right > hr.right + 1;
          }).length,
          contato_alcancavel: portas.length > 0,
          // Duas portas idênticas na mesma tela é a duplicata que empurrava o
          // header para duas linhas em 1280px.
          portas_para_o_contato: portas.length,
          main_rola_de_lado: main ? main.scrollWidth > main.clientWidth : null,
          doc_rola_de_lado:
            document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      })()`)) as Record<string, unknown>,
    );
  }
  await p.screenshot({ path: "evidence/inbox-cabe-1920.png" });
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.waitForTimeout(500);
  await p.screenshot({ path: "evidence/inbox-cabe-1280.png" });
  await b.close();

  console.log(
    "vp".padStart(6) +
      "fora".padStart(7) +
      "painel".padStart(8) +
      "thread".padStart(8) +
      "hdr_h".padStart(7) +
      "acoes".padStart(8) +
      "portas".padStart(8) +
      "  rola(main/doc)",
  );
  for (const r of linhas) {
    console.log(
      String(r.viewport).padStart(6) +
        String(r.aside_fora).padStart(7) +
        String(r.aside_w).padStart(8) +
        String(r.thread_w).padStart(8) +
        String(r.header_h).padStart(7) +
        `${r.botoes_perdidos}/${r.botoes}`.padStart(8) +
        String(r.portas_para_o_contato).padStart(8) +
        `  ${r.main_rola_de_lado}/${r.doc_rola_de_lado}`,
    );
  }

  const casos: Array<[string, boolean]> = [
    ["mediu todas as larguras (guarda de vacuidade)", linhas.length === LARGURAS.length],
    ["o painel de CRM existe em toda largura xl+", linhas.every((r) => !r.sem_painel)],
    ["o painel NUNCA fica fora da viewport", linhas.every((r) => r.aside_fora === 0)],
    ["nenhuma ação do header se perde", linhas.every((r) => r.botoes_perdidos === 0)],
    ["o header tem ações para perder (vacuidade)", linhas.every((r) => Number(r.botoes) > 0)],
    [`a conversa nunca fica abaixo de ${THREAD_MIN}px`, linhas.every((r) => Number(r.thread_w) >= THREAD_MIN)],
    ["o inbox não rola de lado em largura nenhuma", linhas.every((r) => r.main_rola_de_lado === false)],
    ["dá para chegar ao contato em toda largura", linhas.every((r) => r.contato_alcancavel === true)],
    ["e por UMA porta só — sem duplicata na tela", linhas.every((r) => r.portas_para_o_contato === 1)],
    ["sem erro de console", erros.length === 0],
  ];

  let falhas = 0;
  console.log("");
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
