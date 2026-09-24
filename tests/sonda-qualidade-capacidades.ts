/**
 * Sonda de QUALIDADE da tela de capacidades — não de funcionamento.
 *
 * O E2E já provou comportamento (liga o pacote, o crítico não entra, o painel
 * mostra número real). Isto aqui pergunta outra coisa: **ficou bom?** É a
 * pergunta que o teste verde não responde, e é onde eu tinha parado.
 *
 * O gatilho: no screenshot do E2E havia um widget flutuante cobrindo parte do
 * card "Atender e responder", e eu descartei como "artefato do screenshot do
 * elemento" — explicação conveniente, não medida. Aqui ela é medida com
 * `elementFromPoint`, que responde quem o usuário atinge ao clicar.
 *
 * Rode com o `next start` já de pé:
 *   E2E_PORT=3011 npx tsx tests/sonda-qualidade-capacidades.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { chromium, type Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "./e2e/utils/totp";

const PORT = process.env.E2E_PORT ?? "3011";
const BASE = `http://localhost:${PORT}`;
const CREDS = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8"),
) as {
  password: string;
  users: Record<string, { email: string }>;
  admin_totp?: { secret: string };
  capacidades: { agent_id: string };
};

const achados: string[] = [];
function achado(gravidade: "DEFEITO" | "ATENCAO" | "OK", texto: string): void {
  achados.push(`[${gravidade}] ${texto}`);
  console.info(`[${gravidade}] ${texto}`);
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill(CREDS.users.manager!.email);
  await page.locator("#password").fill(CREDS.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/);
}

async function main(): Promise<void> {
  const browser = await chromium.launch();

  // ---- 1. QUEM O USUÁRIO ATINGE AO CLICAR NO CARD ----
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await login(page);
  await page.goto(`${BASE}/app/ai/agents/${CREDS.capacidades.agent_id}`);
  await page.getByTestId("tool-picker").waitFor({ state: "visible", timeout: 90_000 });

  await page.getByTestId("pacote-atender").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const sobreposicao = await page.getByTestId("pacote-atender").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const pontos = [
      { nome: "canto superior direito", x: r.right - 30, y: r.top + 30 },
      { nome: "centro", x: r.left + r.width / 2, y: r.top + r.height / 2 },
      { nome: "contagem (rodapé do cabeçalho)", x: r.left + 120, y: r.top + 70 },
    ];
    return pontos.map((p) => {
      // CONTROLE POSITIVO: ponto fora da viewport faz elementFromPoint devolver
      // null, e null lido como "coberto" produz DEFEITO onde não há defeito.
      // Foi o que aconteceu na primeira execução desta sonda.
      const noQuadro =
        p.x >= 0 && p.y >= 0 && p.x <= window.innerWidth && p.y <= window.innerHeight;
      if (!noQuadro) return { ponto: p.nome, medivel: false, dentro: false, intruso: null };
      const alvo = document.elementFromPoint(p.x, p.y);
      const dentro = alvo ? el.contains(alvo) : false;
      return {
        ponto: p.nome,
        medivel: true,
        dentro,
        intruso: dentro ? null : (alvo?.className?.toString?.() ?? alvo?.tagName ?? "null"),
      };
    });
  });
  const mediveis = sobreposicao.filter((s) => s.medivel);
  if (mediveis.length === 0) {
    achado("ATENCAO", "sobreposição: nenhum ponto ficou dentro da viewport — medição inválida, não conclusão");
  } else {
    for (const s of mediveis) {
      if (!s.dentro) achado("DEFEITO", `algo cobre o card no ponto "${s.ponto}": ${s.intruso}`);
    }
    if (mediveis.every((s) => s.dentro)) {
      achado(
        "OK",
        `nada cobre o card do pacote em 1280x800 (${mediveis.length} pontos medidos) — o widget do screenshot era do render do elemento, não da tela`,
      );
    }
  }

  // ---- 2. CONTRASTE DOS BADGES DE RISCO (WCAG AA = 4.5:1 para texto pequeno) ----
  // O esbuild do tsx injeta `__name` em QUALQUER função declarada aqui dentro
  // (nomeada ou arrow atribuída) e o browser estoura com "__name is not
  // defined". Por isso o corpo abaixo não declara função nenhuma: só expressões.
  const contrastes = await page.evaluate(() => {
    const out: Array<{ texto: string; razao: number; tamanhoPx: number }> = [];
    for (const el of document.querySelectorAll(
      '[data-testid^="capacidade-"] *, [data-testid^="pacote-"] *, [data-testid^="uso-"] *, [data-testid="tool-picker"] p, [data-testid="tool-picker"] label',
    )) {
      const t = (el.textContent ?? "").trim();
      if (!t || t.length > 40 || el.children.length > 0) continue;
      const cs = getComputedStyle(el);

      let fundo = "rgb(255, 255, 255)";
      let atual: Element | null = el;
      while (atual) {
        const bg = getComputedStyle(atual).backgroundColor;
        if (bg && !/rgba?\(0, 0, 0, 0\)/.test(bg)) {
          fundo = bg;
          break;
        }
        atual = atual.parentElement;
      }

      const lums: number[] = [];
      for (const cor of [cs.color, fundo]) {
        const m = cor.match(/\d+(\.\d+)?/g);
        if (!m) {
          lums.push(0);
          continue;
        }
        const canais: number[] = [];
        for (const v of m.slice(0, 3)) {
          const c = Number(v) / 255;
          canais.push(c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        }
        lums.push(0.2126 * canais[0]! + 0.7152 * canais[1]! + 0.0722 * canais[2]!);
      }

      const razao = (Math.max(lums[0]!, lums[1]!) + 0.05) / (Math.min(lums[0]!, lums[1]!) + 0.05);
      out.push({
        texto: t.slice(0, 34),
        razao: Math.round(razao * 100) / 100,
        tamanhoPx: parseFloat(cs.fontSize),
      });
    }
    return out;
  });

  const ruins = contrastes.filter((c) => c.razao < 4.5);
  if (contrastes.length < 10) {
    achado(
      "ATENCAO",
      `contraste: só ${contrastes.length} textos casaram o seletor — amostra pequena demais para concluir "nenhum abaixo de 4.5". Não é aprovação`,
    );
  }
  if (ruins.length > 0) {
    for (const r of ruins.slice(0, 6)) {
      achado("ATENCAO", `contraste ${r.razao}:1 (mínimo AA 4.5) em "${r.texto}" (${r.tamanhoPx}px)`);
    }
  } else {
    achado("OK", `contraste: ${contrastes.length} textos medidos, nenhum abaixo de 4.5:1`);
  }

  // ---- 3. A TELA CABE? (a doutrina do repo manda medir, não olhar) ----
  for (const vp of [
    { w: 1280, h: 800, nome: "notebook comum" },
    { w: 1024, h: 768, nome: "notebook antigo" },
    { w: 390, h: 844, nome: "celular" },
  ]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      alturaDoPicker: document.querySelector('[data-testid="tool-picker"]')!.getBoundingClientRect().height,
      alturaDaJanela: window.innerHeight,
    }));
    if (m.overflowX > 1) {
      achado(
        "ATENCAO",
        `${vp.nome} (${vp.w}x${vp.h}): a página rola ${m.overflowX}px na horizontal — comparar com o controle abaixo antes de atribuir a esta tela`,
      );
    } else {
      achado("OK", `${vp.nome} (${vp.w}x${vp.h}): sem rolagem horizontal; o bloco de capacidades ocupa ${Math.round(m.alturaDoPicker / m.alturaDaJanela * 10) / 10}x a altura da tela`);
    }
  }
  // Controle: a MESMA medida numa página que não é minha. Sem isto, "rola na
  // horizontal no celular" não distingue defeito desta tela de layout do app.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/app/ai/agents`);
  await page.waitForTimeout(800);
  const controle = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  achado(
    controle > 1 ? "ATENCAO" : "OK",
    `controle em 390x844: a LISTA de agentes (tela que não é desta wave) estoura ${controle}px — este é o piso do app; o que passar disso na tela de capacidades é desta wave`,
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/app/ai/agents/${CREDS.capacidades.agent_id}`);
  await page.getByTestId("tool-picker").waitFor({ state: "visible", timeout: 90_000 });

  // ---- 4. DÁ PARA USAR SÓ COM TECLADO? ----
  // ARMADILHA: esta sonda loga como MANAGER, e para manager a página inteira é
  // readOnly (RBAC pré-existente) — o switch nasce `disabled`, e controle
  // desabilitado não recebe foco POR DEFINIÇÃO. Medir aqui responderia sobre o
  // RBAC e seria lido como defeito de acessibilidade. Então: só vale a medição
  // se o controle estiver habilitado; senão, declara-se não-medido.
  const teclado = await page.evaluate(() => {
    const alvo = document.querySelector('[data-testid="switch-pacote-atender"]') as HTMLButtonElement | null;
    if (!alvo) return { existe: false, habilitado: false, focavel: false };
    if (alvo.disabled) return { existe: true, habilitado: false, focavel: false };
    alvo.focus();
    return { existe: true, habilitado: true, focavel: document.activeElement === alvo };
  });
  if (!teclado.habilitado) {
    achado(
      "ATENCAO",
      "teclado (manager): não medido — o switch está desabilitado por readOnly. Medido abaixo com sessão de admin",
    );
  } else if (!teclado.focavel) {
    achado("DEFEITO", "o switch do pacote não recebe foco de teclado");
  } else {
    achado("OK", "o switch do pacote recebe foco de teclado");
  }

  // ---- 4b. TECLADO, NO CENÁRIO EM QUE O CONTROLE EXISTE (admin) ----
  const ctxAdmin = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const admin = await ctxAdmin.newPage();
  await admin.goto(`${BASE}/login`);
  await admin.locator("#email").fill(CREDS.users.admin!.email);
  await admin.locator("#password").fill(CREDS.password);
  await admin.getByRole("button", { name: "Entrar", exact: true }).click();
  await admin.waitForURL(/\/login\/mfa/);
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (msUntilNextTotpWindow() < 3_000) await admin.waitForTimeout(msUntilNextTotpWindow() + 200);
    await admin.locator('input[aria-label="Dígito 1"]').click();
    await admin.keyboard.type(generateTotp(CREDS.admin_totp!.secret), { delay: 40 });
    try {
      await admin.waitForURL(/\/app\//, { timeout: 8_000 });
      break;
    } catch {
      await admin.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  await admin.goto(`${BASE}/app/ai/agents/${CREDS.capacidades.agent_id}`);
  await admin.getByTestId("tool-picker").waitFor({ state: "visible", timeout: 90_000 });
  const tecladoAdmin = await admin.evaluate(() => {
    const alvo = document.querySelector('[data-testid="switch-pacote-atender"]') as HTMLButtonElement | null;
    if (!alvo || alvo.disabled) return { medivel: false, focavel: false, rotulo: null as string | null };
    alvo.focus();
    return {
      medivel: true,
      focavel: document.activeElement === alvo,
      rotulo: alvo.getAttribute("aria-label"),
    };
  });
  if (!tecladoAdmin.medivel) {
    achado("ATENCAO", "teclado (admin): switch ainda desabilitado — cenário não alcançado");
  } else {
    // Liga pelo TECLADO e confere que a tela reagiu: foco sem ação não é uso.
    await admin.keyboard.press("Space");
    const ligou = await admin
      .getByTestId("pacote-atender")
      .getAttribute("data-estado")
      .catch(() => null);
    achado(
      tecladoAdmin.focavel && ligou === "ligado" ? "OK" : "DEFEITO",
      `teclado (admin): foco=${tecladoAdmin.focavel}, rótulo="${tecladoAdmin.rotulo}", ligar com Espaço deixou o pacote em "${ligou}"`,
    );
  }

  // ---- 5. TEMA ESCURO ----
  const ctxDark = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  const dark = await ctxDark.newPage();
  await login(dark);
  await dark.goto(`${BASE}/app/ai/agents/${CREDS.capacidades.agent_id}`);
  await dark.getByTestId("tool-picker").waitFor({ state: "visible", timeout: 90_000 });
  const temaEscuro = await dark.evaluate(() => {
    const root = document.documentElement;
    const bloco = document.querySelector('[data-testid="criticas-atender"]') as HTMLElement | null;
    return {
      classeDark: root.className.includes("dark"),
      fundoDaPagina: getComputedStyle(document.body).backgroundColor,
      corDoAvisoCritico: bloco ? getComputedStyle(bloco.querySelector("p")!).color : null,
    };
  });
  // O sinal não é a classe `dark` no html (o app pode chavear por media query
  // ou data-attribute): o sinal é a cor que o usuário vê. Fundo escuro = tema
  // escuro em vigor.
  const canaisFundo = (temaEscuro.fundoDaPagina.match(/\d+/g) ?? ["255"]).map(Number);
  const fundoEscuro = canaisFundo.slice(0, 3).reduce((a, b) => a + b, 0) / 3 < 80;
  achado(
    fundoEscuro ? "OK" : "DEFEITO",
    `tema escuro ${fundoEscuro ? "em vigor" : "NÃO aplicado"}: fundo=${temaEscuro.fundoDaPagina}, aviso crítico=${temaEscuro.corDoAvisoCritico}`,
  );
  fs.mkdirSync(path.join(process.cwd(), "evidence", "ia-360-w1"), { recursive: true });
  await dark
    .getByTestId("tool-picker")
    .screenshot({ path: "evidence/ia-360-w1/w1-tema-escuro.png" });

  // ---- 6. O ESTADO DE ERRO DA ABA DE USO ----
  // Contexto NOVO: o React Query desta tela tem staleTime de 30s, e a página já
  // foi aberta nesta aba — reusar o contexto serviria do cache e o "sem recado"
  // seria falso positivo do instrumento, não defeito da tela.
  const ctxErro = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pErro = await ctxErro.newPage();
  await login(pErro);
  let requisicaoBloqueada = false;
  await pErro.route("**/api/v1/ai/agents/*/tool-usage*", (r) => {
    requisicaoBloqueada = true;
    return r.abort();
  });
  await pErro.goto(`${BASE}/app/ai/agents/${CREDS.capacidades.agent_id}`);
  await pErro.getByRole("tab", { name: /capacidades/i }).click();
  // `isVisible()` NÃO espera — a opção `timeout` dele não faz o locator aguardar
  // o elemento aparecer, e a chamada devolve `false` na hora. Foi assim que esta
  // sonda acusou "não mostra recado" numa tela que mostra o recado em 96 ms.
  // Quem espera é `waitFor`.
  const erro = await pErro
    .getByText(/não foi possível carregar/i)
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!requisicaoBloqueada) {
    achado("ATENCAO", "estado de erro: não medido — a requisição nem chegou a ser feita (rota não interceptada)");
  }
  else {
    achado(
      erro ? "OK" : "DEFEITO",
      erro
        ? "aba Capacidades com a rota fora do ar: mostra recado, não tela em branco"
        : "aba Capacidades com a rota fora do ar: NÃO mostra recado ao usuário",
    );
  }

  await browser.close();

  console.info(`\n===== RESUMO =====`);
  console.info(`defeitos: ${achados.filter((a) => a.startsWith("[DEFEITO")).length}`);
  console.info(`atenção:  ${achados.filter((a) => a.startsWith("[ATENCAO")).length}`);
  console.info(`ok:       ${achados.filter((a) => a.startsWith("[OK")).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
