/**
 * A MOLDURA CLARA DO LOGO NO TEMA ESCURO — QUEM A RECEBE, E QUEM NÃO RECEBE.
 *
 * ═══ O QUE ESTA SPEC MEDE, E POR QUE ELA EXISTE ═══
 *
 * O PR #659 (@felipebnt) põe uma moldura clara por trás do logo ENVIADO por
 * quem hospeda quando o tema é escuro (`rounded-md dark:bg-white dark:px-…
 * dark:py-… dark:shadow-sm`). Sem ela, arte escura sobre `--color-surface`
 * escuro (`#1d1c17`) simplesmente some — sem erro, sem aviso, e sem nada na
 * tela dizendo que sumiu.
 *
 * Já existe uma cerca para isso: `tests/unit/logo-nao-some-no-tema-escuro.ts`.
 * Ela lê a FONTE e prova que o `<img>` continua embrulhado pelo chip — e o
 * cabeçalho dela diz, em voz alta, o que ela NÃO faz:
 *
 *   > O que ele NÃO faz é medir contraste num navegador — isso é Playwright com
 *   > `getComputedStyle`, e está anotado como pendência.
 *
 * Esta spec é essa pendência. Ela não relê a fonte: ela abre a tela, escolhe o
 * tema como uma pessoa escolhe, e pergunta ao NAVEGADOR qual cor foi pintada.
 * A diferença não é de rigor formal — uma classe `dark:` escrita no JSX e uma
 * classe `dark:` que o Tailwind de fato compilou para o seletor certo
 * (`@custom-variant dark (&:where([data-theme="dark"], …))`, `app/globals.css`)
 * são coisas diferentes, e só a segunda pinta pixel.
 *
 * ═══ A FRONTEIRA QUE A RECONCILIAÇÃO CRIOU ═══
 *
 * O #659 foi escrito antes de a `main` ganhar o ramo `marcaDoProduto` (#642) —
 * a identidade PRÓPRIA do produto, um `<svg>` inline desenhado para os dois
 * temas. A reconciliação preservou os dois e disse a fronteira:
 *
 *   - logo ENVIADO por quem hospeda  → recebe a moldura (contraste desconhecido)
 *   - arte do PRODUTO (`marcaDoProduto`) → NÃO recebe (já serve os dois temas)
 *
 * O caso (5) é essa fronteira, e é o que mais importa: pôr a moldura na marca do
 * produto seria dar o remédio a quem não tem a doença — e violaria a condição
 * com que o dono aprovou a mudança ("desde que não quebre o visual que já
 * existe e está consolidado há meses").
 *
 * ═══ A CONDIÇÃO DO DONO É MENSURÁVEL, E O CASO (6) A MEDE ═══
 *
 * "Não quebrar o que já existe" tem um sentido geométrico exato para quem NÃO
 * enviou logo: o cabeçalho da barra lateral tem de ocupar o MESMO retângulo que
 * ocupava. O caso (6) mede `getBoundingClientRect` nos dois temas e exige
 * igualdade — e grava os números em `evidence/` para que a comparação com um
 * build ANTERIOR ao #659 seja aritmética, não impressão.
 *
 * ═══ AS TRÊS SUPERFÍCIES ═══
 *
 * O #659 toca três telas, e consertar uma só devolveria o defeito nas outras
 * duas. As três são medidas aqui:
 *
 *   1. a barra lateral do app   (`components/shell/Sidebar.tsx`)   — casos 1,2,5,6
 *   2. a tela de entrada        (`app/(public)/layout.tsx`)        — caso 3
 *   3. a PRÉVIA da tela de marca(`components/branding/CampoDeLogo.tsx`) — caso 4
 *
 * A terceira é a que mais engana: se a prévia mostrar o logo cru onde o app real
 * desenha a moldura, ela deixa de ser prévia — o operador aprova uma coisa na
 * tela de marca e recebe outra no produto.
 *
 * ═══ COMO O TEMA É ESCOLHIDO (e por que de dois jeitos) ═══
 *
 * Dentro de `/app/*` existe um controle de verdade — `ThemeToggle`
 * (`components/theme/theme-toggle.tsx`), dentro do `UserMenu` —, então lá o tema
 * é trocado CLICANDO, que é o caminho da pessoa.
 *
 * Em `/login` não há controle nenhum: a fachada é anterior à sessão. Lá o estado
 * é semeado em `localStorage` ANTES do primeiro byte (`addInitScript`), que é
 * exatamente o que o navegador de quem já escolheu escuro e saiu da conta faz —
 * `THEME_INIT_SCRIPT` (`app/layout.tsx:122`) lê `deskcomm-theme` no `<head>`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { test, expect, type Page, type Locator } from "./helpers/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "logo-moldura-tema-escuro");

interface E2ECreds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  admin_totp?: { factor_id: string; secret: string };
  dono_totp?: { factor_id: string; secret: string };
}

function loadCreds(): E2ECreds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
    return !c.users?.dono || !c.dono_totp?.secret || !c.org_id;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  // Promove `dono` a platform admin (e revoga a do `admin`) — idempotente. Sem
  // isto `/admin/marca` responde 403 e a spec mede a tela de recusa.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-system-update.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

const creds = loadCreds();

// ── Um PNG de verdade, montado byte a byte ──────────────────────────────────
//
// Mesma construção de `marca-logo.spec.ts`, e pelo mesmo motivo: um base64
// colado no meio da spec é um blob que ninguém consegue auditar. A COR importa
// aqui — azul-marinho é a arte do relato original (o logo que sumia), e é
// justamente o pior caso contra `#1d1c17`.

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tipo: string, dados: Buffer): Buffer {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, "latin1"), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}

function pngSolido(lado: number, cor: [number, number, number], bordaTransparente = false): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolor + alpha: a fixture também mede transparência real.
  const linhas: Buffer[] = [];
  for (let y = 0; y < lado; y++) {
    const linha = Buffer.alloc(1 + lado * 4);
    for (let x = 0; x < lado; x++) {
      linha[1 + x * 4] = cor[0];
      linha[2 + x * 4] = cor[1];
      linha[3 + x * 4] = cor[2];
      linha[4 + x * 4] =
        bordaTransparente && (x < 12 || y < 12 || x >= lado - 12 || y >= lado - 12) ? 0 : 255;
    }
    linhas.push(linha);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(linhas))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Azul-marinho: a arte do relato — invisível contra `#1d1c17` sem a moldura. */
const PNG_AZUL_MARINHO = pngSolido(64, [16, 24, 64]);

// ── Medição ─────────────────────────────────────────────────────────────────

interface Caixa {
  readonly x: number;
  readonly y: number;
  readonly largura: number;
  readonly altura: number;
}

interface Moldura {
  /** A tag do elemento que embrulha o logo — `div` com a moldura, outra coisa sem. */
  readonly tagDoPai: string;
  readonly classeDoPai: string;
  /** `getComputedStyle().backgroundColor` do pai — o que o NAVEGADOR pintou. */
  readonly fundo: string;
  /** [topo, direita, baixo, esquerda], em px. */
  readonly padding: readonly number[];
  readonly sombra: string;
  readonly raio: string;
  readonly caixaDoPai: Caixa;
  readonly caixaDoLogo: Caixa;
}

const px = (s: string): number => Number.parseFloat(s) || 0;

/**
 * Mede o elemento que EMBRULHA o logo — o pai direto, seja ele qual for.
 *
 * O seletor é deliberadamente cego à classe da moldura. Perguntar por
 * `.dark\:bg-white` acharia o elemento pela classe que se quer provar, e passaria
 * verde num DOM onde a moldura existe mas não embrulha nada (a sabotagem do
 * "chip irmão auto-fechado" que derrubou a primeira versão da cerca unitária).
 * Partindo do `<img>` e subindo um nível, o que se mede é o que de fato está
 * atrás do logo — se a moldura for movida para um irmão, o pai medido passa a
 * ser outro e o fundo volta a ser transparente.
 */
async function medirMoldura(logo: Locator): Promise<Moldura> {
  await expect(logo).toBeVisible({ timeout: 15_000 });
  const bruto = await logo.evaluate((el) => {
    const pai = el.parentElement as HTMLElement;
    const cs = getComputedStyle(pai);
    const rp = pai.getBoundingClientRect();
    const rl = el.getBoundingClientRect();
    return {
      tagDoPai: pai.tagName.toLowerCase(),
      classeDoPai: typeof pai.className === "string" ? pai.className : "",
      fundo: cs.backgroundColor,
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
      sombra: cs.boxShadow,
      raio: cs.borderRadius,
      caixaDoPai: { x: rp.x, y: rp.y, largura: rp.width, altura: rp.height },
      caixaDoLogo: { x: rl.x, y: rl.y, largura: rl.width, altura: rl.height },
    };
  });
  return { ...bruto, padding: bruto.padding.map(px) };
}

/** `rgb(r,g,b)` / `rgba(r,g,b,a)` → canais + alfa. `null` quando não é cor. */
function canais(cor: string): { r: number; g: number; b: number; a: number } | null {
  const m = cor.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/);
  if (!m) return null;
  return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: m[4] === undefined ? 1 : +m[4]! };
}

/**
 * "Fundo claro" medido, não adjetivado: opaco E com os três canais altos.
 *
 * O limiar é 200/255 porque a moldura do produto é `bg-white` puro (255) e o
 * `--color-surface` escuro é `#1d1c17` (29,28,23) — não há nada entre os dois
 * que este número precise arbitrar.
 */
function fundoEClaro(cor: string): boolean {
  const c = canais(cor);
  if (!c || c.a < 0.9) return false;
  return c.r >= 200 && c.g >= 200 && c.b >= 200;
}

/** Nenhum fundo pintado: o `rgba(0, 0, 0, 0)` que o Chromium devolve. */
function fundoETransparente(cor: string): boolean {
  const c = canais(cor);
  return c !== null && c.a === 0;
}

async function temaDaPagina(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

/**
 * Troca o tema CLICANDO no controle que a pessoa clica.
 *
 * `ThemeToggle` cicla claro → escuro → sistema → claro. O laço clica até o
 * `data-theme` do `<html>` ser o pedido, com teto: um controle que parou de
 * funcionar tem de reprovar aqui, não consumir o timeout do caso.
 */
async function escolherTemaPelaTela(page: Page, alvo: "dark" | "light"): Promise<void> {
  const botao = page.getByRole("button", { name: /^Tema:/ });
  await expect(botao, "o controle de tema não está na tela").toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < 4; i++) {
    if ((await temaDaPagina(page)) === alvo) return;
    await botao.click();
    // O `setTheme` escreve o atributo no mesmo tick do clique; a espera curta é
    // para o repaint, não para a lógica.
    await page.waitForTimeout(150);
  }
  throw new Error(
    `o controle de tema não chegou em "${alvo}" em 4 cliques ` +
      `(data-theme=${await temaDaPagina(page)})`,
  );
}

type Escopo = "instalacao" | "organizacao";

async function loginComTotp(page: Page, email: string, secret: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click({ timeout: 15_000 });
  await page.waitForURL(/\/login\/mfa/);

  const digito1 = page.locator('input[aria-label="Dígito 1"]');
  const recusa = page.locator("form").getByRole("alert");

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    await digito1.click({ timeout: 15_000 });
    await page.keyboard.type(generateTotp(secret), { delay: 40 });

    const desfecho = await Promise.race([
      page.waitForURL(/\/app\//, { timeout: 60_000 }).then(
        () => "entrou" as const,
        () => "sem-desfecho" as const,
      ),
      recusa.waitFor({ state: "visible", timeout: 60_000 }).then(
        () => "recusado" as const,
        () => "sem-desfecho" as const,
      ),
    ]);
    if (desfecho === "entrou") return;
    if (desfecho === "sem-desfecho") {
      throw new Error(`o desafio de MFA de ${email} não terminou em 60s (url=${page.url()})`);
    }
    await page.waitForTimeout(msUntilNextTotpWindow() + 200);
  }
  throw new Error(`MFA falhou depois de 2 tentativas para ${email} (url=${page.url()})`);
}

async function subir(
  page: Page,
  escopo: Escopo,
  arquivo: { nome: string; mime: string; bytes: Buffer },
  tema: "claro" | "escuro" = "claro",
): Promise<void> {
  // A HIDRATAÇÃO, e não a visibilidade: o input existe no HTML do SSR antes de o
  // React atar o `onChange`, e arquivo posto nessa janela não dispara requisição
  // nenhuma. Ver o comentário homônimo em `marca-logo.spec.ts`.
  await expect(
    page.locator(`[data-campo-de-logo='${escopo}'][data-hidratado]`),
    `o campo de logo da camada "${escopo}" não hidratou`,
  ).toBeVisible({ timeout: 15_000 });
  const entrada = tema === "escuro" ? `#logo-escuro-${escopo}` : `#logo-${escopo}`;
  const resposta = page.waitForResponse(
    (r) => r.url().includes("/api/v1/marca/logo") && r.request().method() === "POST",
  );
  await page.locator(entrada).setInputFiles({
    name: arquivo.nome,
    mimeType: arquivo.mime,
    buffer: arquivo.bytes,
  });
  expect((await resposta).ok()).toBe(true);
  await expect(page.getByText(/logo atualizado/i).last()).toBeVisible({ timeout: 15_000 });
}

async function removerLogoSeHouver(page: Page, tela: string, escopo: Escopo): Promise<void> {
  await page.goto(tela);
  const campo = page.locator(`[data-campo-de-logo='${escopo}'][data-hidratado]`);
  await expect(campo).toBeVisible();
  for (const nome of [/^remover logo escuro$/i, /^remover$/i]) {
    const remover = campo.getByRole("button", { name: nome });
    if ((await remover.count()) === 0) continue;
    const resposta = page.waitForResponse(
      (r) => r.url().includes("/api/v1/marca/logo") && r.request().method() === "DELETE",
    );
    await remover.click();
    expect((await resposta).ok()).toBe(true);
    await expect(remover).toHaveCount(0);
  }
}

function evidencia(nome: string): string {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return path.join(EVIDENCIA, nome);
}

/** Grava o número medido ao lado do screenshot: comparação vira aritmética. */
function anotar(nome: string, dado: unknown): void {
  fs.writeFileSync(evidencia(nome), JSON.stringify(dado, null, 2) + "\n", "utf8");
}

/** O cabeçalho da barra lateral: o primeiro filho do `<aside>` (`h-14`, `border-b`). */
function cabecalhoDaBarra(page: Page): Locator {
  return page.locator("aside > div").first();
}

async function medirCaixa(alvo: Locator): Promise<Caixa> {
  await expect(alvo).toBeVisible({ timeout: 15_000 });
  return alvo.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, largura: r.width, altura: r.height };
  });
}

// ── A spec ──────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.describe("a moldura do logo no tema escuro", () => {
  // Cada caso faz o próprio login: `mode: "serial"` encadeia ORDEM e estado do
  // BANCO, não a sessão do navegador (as fixtures `page`/`context` são de escopo
  // de teste). Ver o comentário longo em `marca-logo.spec.ts`.
  test.setTimeout(120_000);

  const secret = (): string => {
    const s = creds.dono_totp?.secret;
    expect(s, "sem `dono_totp` no .e2e-creds.json — rode seed-e2e-credentials.ts").toBeTruthy();
    return s!;
  };

  test("(1) tema ESCURO + logo ENVIADO: a barra lateral pinta a moldura clara", async ({
    page,
  }) => {
    await loginComTotp(page, creds.users.dono!.email, secret());

    await page.goto("/admin/marca");
    await subir(page, "instalacao", {
      nome: "logo-azul-marinho.png",
      mime: "image/png",
      bytes: PNG_AZUL_MARINHO,
    });

    await page.goto("/app/inbox");
    await escolherTemaPelaTela(page, "dark");
    expect(await temaDaPagina(page), "o <html> não ficou no tema escuro").toBe("dark");

    const logo = page.locator("aside img").first();
    const m = await medirMoldura(logo);
    anotar("1-barra-escuro.json", m);
    await page.screenshot({ path: evidencia("1-barra-escuro.png") });

    expect(
      fundoEClaro(m.fundo),
      `a moldura não foi pintada: o pai do <img> tem background-color=${m.fundo} ` +
        `(tag=${m.tagDoPai}, classe="${m.classeDoPai}")`,
    ).toBe(true);
    expect(
      m.padding.every((p) => p > 0),
      `a moldura não tem folga: padding=${m.padding}`,
    ).toBe(true);
    expect(m.sombra, "a moldura não tem sombra").not.toBe("none");

    // CONTENÇÃO, não proximidade: a moldura tem de ser MAIOR que o logo nos dois
    // eixos e contê-lo. Uma moldura irmã (a sabotagem que derrubou a primeira
    // versão da cerca unitária) teria fundo claro e não conteria nada.
    expect(m.caixaDoPai.largura).toBeGreaterThan(m.caixaDoLogo.largura);
    expect(m.caixaDoPai.altura).toBeGreaterThan(m.caixaDoLogo.altura);
    expect(m.caixaDoPai.x).toBeLessThanOrEqual(m.caixaDoLogo.x);
    expect(m.caixaDoPai.y).toBeLessThanOrEqual(m.caixaDoLogo.y);
  });

  test("(2) tema CLARO + logo ENVIADO: NÃO há moldura — as classes são `dark:`", async ({
    page,
  }) => {
    await loginComTotp(page, creds.users.dono!.email, secret());
    await page.goto("/app/inbox");
    await escolherTemaPelaTela(page, "light");
    expect(await temaDaPagina(page)).toBe("light");

    const m = await medirMoldura(page.locator("aside img").first());
    anotar("2-barra-claro.json", m);
    await page.screenshot({ path: evidencia("2-barra-claro.png") });

    expect(
      fundoETransparente(m.fundo),
      `no tema claro o logo ganhou fundo pintado (${m.fundo}) — as classes deveriam ser só \`dark:\``,
    ).toBe(true);
    expect(m.padding, "no tema claro a moldura não pode ter folga").toEqual([0, 0, 0, 0]);
    expect(m.sombra, "no tema claro a moldura não pode ter sombra").toBe("none");
  });

  test("(3) a TELA DE ENTRADA repete as duas medidas, sem sessão nenhuma", async ({ browser }) => {
    // Contexto novo e deslogado: é o estado de quem só recebeu o endereço. O tema
    // é semeado antes do primeiro byte porque a fachada não tem controle — é o
    // que o navegador de quem escolheu escuro e saiu da conta já faz sozinho.
    for (const tema of ["dark", "light"] as const) {
      const contexto = await browser.newContext();
      try {
        const pagina = await contexto.newPage();
        await pagina.addInitScript((t) => window.localStorage.setItem("deskcomm-theme", t), tema);
        await pagina.goto("/login");
        expect(await temaDaPagina(pagina), `a fachada não ficou em ${tema}`).toBe(tema);

        const m = await medirMoldura(pagina.getByTestId("logo-da-fachada"));
        anotar(`3-fachada-${tema}.json`, m);
        await pagina.screenshot({ path: evidencia(`3-fachada-${tema}.png`) });

        if (tema === "dark") {
          expect(
            fundoEClaro(m.fundo),
            `a fachada no escuro desenhou o logo CRU (fundo=${m.fundo}) — o defeito ` +
              `volta inteiro na tela de primeira impressão`,
          ).toBe(true);
          expect(
            m.padding.every((p) => p > 0),
            `fachada escura sem folga: ${m.padding}`,
          ).toBe(true);
          expect(m.caixaDoPai.largura).toBeGreaterThan(m.caixaDoLogo.largura);
          expect(m.caixaDoPai.altura).toBeGreaterThan(m.caixaDoLogo.altura);
        } else {
          expect(
            fundoETransparente(m.fundo),
            `a fachada no claro ganhou moldura (${m.fundo})`,
          ).toBe(true);
          expect(m.padding).toEqual([0, 0, 0, 0]);
        }
      } finally {
        await contexto.close();
      }
    }
  });

  test("(4) a PRÉVIA da tela de marca prevê o que o app desenha", async ({ page }) => {
    await loginComTotp(page, creds.users.dono!.email, secret());
    await page.goto("/admin/marca");

    // As duas caixas convivem no MESMO tema real (o fundo é simulado por
    // `style`), então a condição lá é o rótulo da caixa — e é justamente por isso
    // que a prévia pode divergir do app sem nada gritar.
    const escura = await medirMoldura(page.locator("[data-previa-do-logo='escuro'] img"));
    const clara = await medirMoldura(page.locator("[data-previa-do-logo='claro'] img"));
    anotar("4-previa-escura.json", escura);
    anotar("4-previa-clara.json", clara);
    await page.screenshot({ path: evidencia("4-previa.png"), fullPage: true });

    expect(
      fundoEClaro(escura.fundo),
      `a prévia da aparência ESCURA mostra o logo cru (fundo=${escura.fundo}) — ela deixa ` +
        `de prever o que o app desenha, e o operador aprova uma coisa e recebe outra`,
    ).toBe(true);
    expect(escura.padding.every((p) => p > 0)).toBe(true);
    expect(
      fundoETransparente(clara.fundo),
      `a prévia da aparência CLARA ganhou moldura (${clara.fundo}) — o app não desenha isso`,
    ).toBe(true);
  });

  test("(5) A FRONTEIRA: no escuro, a marca do PRODUTO não recebe moldura", async ({ page }) => {
    await loginComTotp(page, creds.users.dono!.email, secret());
    // Tira o logo enviado: sem ele, e com o nome padrão, a barra cai no ramo
    // `marcaDoProduto` — o `<svg>` inline desenhado para os dois temas.
    await removerLogoSeHouver(page, "/admin/marca", "instalacao");

    await page.goto("/app/inbox");
    await escolherTemaPelaTela(page, "dark");
    expect(await temaDaPagina(page)).toBe("dark");

    const barra = page.locator("aside").first();
    await expect(
      barra.locator("img"),
      "ainda há um <img> na barra — o logo enviado não foi removido, e o caso mediria outra coisa",
    ).toHaveCount(0, { timeout: 15_000 });

    const marca = barra.getByRole("img", { name: "DeskcommCRM" });
    await expect(
      marca,
      "a barra não caiu no ramo `marcaDoProduto` — sem ele não há fronteira para medir",
    ).toBeVisible({ timeout: 15_000 });

    // A negação é sobre TODA a cadeia entre a marca e o `<aside>`, e não só sobre
    // o pai: uma moldura acrescentada em qualquer avô pintaria igual na tela, e
    // uma asserção sobre um nível só passaria verde ao lado do defeito.
    const cadeia = await marca.evaluate((el) => {
      const saida: { tag: string; classe: string; fundo: string; padding: string }[] = [];
      let no = el as HTMLElement | null;
      while (no && no.tagName.toLowerCase() !== "aside") {
        const cs = getComputedStyle(no);
        saida.push({
          tag: no.tagName.toLowerCase(),
          classe: typeof no.className === "string" ? no.className : "",
          fundo: cs.backgroundColor,
          padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        });
        no = no.parentElement;
      }
      return saida;
    });
    anotar("5-marca-do-produto-escuro.json", cadeia);
    await page.screenshot({ path: evidencia("5-marca-do-produto-escuro.png") });

    const comMoldura = cadeia.filter((n) => fundoEClaro(n.fundo));
    expect(
      comMoldura,
      `a marca do PRODUTO ganhou moldura clara no tema escuro — é o remédio dado a quem ` +
        `não tem a doença, e quebra o visual que já existia: ${JSON.stringify(comMoldura)}`,
    ).toEqual([]);
  });

  test("(6) A CONDIÇÃO DO DONO: sem logo enviado, o cabeçalho não muda de retângulo", async ({
    page,
  }) => {
    await loginComTotp(page, creds.users.dono!.email, secret());
    await page.goto("/app/inbox");

    await escolherTemaPelaTela(page, "light");
    const claro = await medirCaixa(cabecalhoDaBarra(page));
    await page.screenshot({ path: evidencia("6-cabecalho-claro.png") });

    await escolherTemaPelaTela(page, "dark");
    const escuro = await medirCaixa(cabecalhoDaBarra(page));
    await page.screenshot({ path: evidencia("6-cabecalho-escuro.png") });

    anotar("6-cabecalho-sem-logo.json", { claro, escuro });

    // A igualdade é o sentido geométrico exato de "não quebra o que já existe"
    // para quem NUNCA enviou logo: a moldura é do outro ramo, e nenhum pixel do
    // cabeçalho dessa instalação pode se mover ao trocar de tema.
    expect(
      escuro,
      `o cabeçalho da barra MUDOU de retângulo entre os temas numa instalação SEM logo ` +
        `enviado — claro=${JSON.stringify(claro)} escuro=${JSON.stringify(escuro)}`,
    ).toEqual(claro);
    // E ele continua sendo o `h-14` de sempre, no topo: a igualdade acima passaria
    // se os DOIS tivessem mudado junto.
    expect(escuro.altura, "o cabeçalho deixou de ser `h-14` (56px)").toBe(56);
    expect(escuro.y, "o cabeçalho saiu do topo da barra").toBe(0);
  });

  test("(7) dois logos: troca real de tema, fachada e remoção independente", async ({
    page,
    browser,
  }) => {
    await loginComTotp(page, creds.users.dono!.email, secret());
    await removerLogoSeHouver(page, "/app/settings/marca", "organizacao");
    await removerLogoSeHouver(page, "/admin/marca", "instalacao");
    const clara = { nome: "logo-claro.png", mime: "image/png", bytes: PNG_AZUL_MARINHO };
    const escura = {
      nome: "logo-escuro.png",
      mime: "image/png",
      bytes: pngSolido(64, [255, 255, 255], true),
    };
    await subir(page, "instalacao", clara);
    await subir(page, "instalacao", escura, "escuro");
    const previaClara = page.locator("[data-previa-do-logo='claro'] img");
    const previaEscura = page.locator("[data-previa-do-logo='escuro'] img");
    await expect(previaEscura).toBeVisible();
    const urlClara = await previaClara.getAttribute("src");
    const urlEscura = await previaEscura.getAttribute("src");
    expect(urlEscura).toBeTruthy();
    expect(urlEscura).not.toBe(urlClara);
    expect(fundoETransparente((await medirMoldura(previaEscura)).fundo)).toBe(true);
    await page.screenshot({ path: evidencia("7-duas-artes-previa.png"), fullPage: true });

    await page.goto("/app/inbox");
    for (const tema of ["dark", "light"] as const) {
      await escolherTemaPelaTela(page, tema);
      const logo = page.locator("aside img:visible").first();
      await expect(logo).toHaveAttribute("src", (tema === "dark" ? urlEscura : urlClara)!);
      expect(fundoETransparente((await medirMoldura(logo)).fundo)).toBe(true);
      await page.screenshot({ path: evidencia(`7-barra-${tema}.png`) });
      const contexto = await browser.newContext();
      try {
        const fachada = await contexto.newPage();
        await fachada.addInitScript((t) => localStorage.setItem("deskcomm-theme", t), tema);
        await fachada.goto("/login");
        const logoPublico = fachada.getByTestId(
          tema === "dark" ? "logo-escuro-da-fachada" : "logo-da-fachada",
        );
        await expect(logoPublico).toHaveAttribute("src", (tema === "dark" ? urlEscura : urlClara)!);
        expect(fundoETransparente((await medirMoldura(logoPublico)).fundo)).toBe(true);
        await fachada.screenshot({ path: evidencia(`7-login-${tema}.png`) });
      } finally {
        await contexto.close();
      }
    }
    // Remover só o segundo arquivo deve recuperar o chip anterior sem apagar o primeiro.
    await page.goto("/admin/marca");
    const resposta = page.waitForResponse(
      (r) => r.url().includes("tema=escuro") && r.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: "Remover logo escuro", exact: true }).click();
    expect((await resposta).ok()).toBe(true);
    await expect(page.locator("[data-previa-do-logo='escuro'] img")).toHaveAttribute(
      "src",
      urlClara!,
    );
    expect(
      fundoEClaro((await medirMoldura(page.locator("[data-previa-do-logo='escuro'] img"))).fundo),
    ).toBe(true);
    await page.reload();
    await expect(page.locator("[data-previa-do-logo='claro'] img")).toHaveAttribute(
      "src",
      urlClara!,
    );
  });

  /**
   * A restauração. Num `afterAll` porque ele roda mesmo quando um caso estoura —
   * medido: com A→B(estouro)→C, a ordem observada é ["A","B","afterAll"], ou
   * seja o hook rodou e o caso seguinte não. Deixar a limpeza num caso final a
   * transformaria em refém do caso anterior.
   */
  test.afterAll(async ({ browser }) => {
    const contexto = await browser.newContext();
    try {
      const pagina = await contexto.newPage();
      await loginComTotp(pagina, creds.users.dono!.email, secret());
      await removerLogoSeHouver(pagina, "/admin/marca", "instalacao");
    } finally {
      await contexto.close();
    }
  });
});
