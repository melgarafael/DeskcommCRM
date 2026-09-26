/**
 * O LOGO SUBIDO PELA TELA CHEGA À TELA — nas duas camadas, e sem uma vazar na outra.
 *
 * ═══ POR QUE ESTA SPEC EXISTE, E POR QUE NÃO BASTA `curl` ═══
 *
 * O produto é distribuído open-source: a experiência de quem instala numa VPS É o
 * produto. O que se prova aqui é a cadeia inteira que uma pessoa percorre — abrir
 * a tela, escolher um arquivo, ver a barra lateral mudar — e ela tem quatro elos
 * que uma chamada de API não exercita: o `<input type=file>`, o `fetch` do
 * componente, o `router.refresh()` que traz o render novo, e o `<img>` que o
 * navegador de fato baixa do bucket **público** (uma URL assinada vencida, ou um
 * bucket privado, aparece exatamente aqui e em lugar nenhum antes).
 *
 * ═══ AS QUATRO PROPRIEDADES, E A ORDEM EM QUE ELAS SE PROVAM ═══
 *
 *   1. **A camada da instalação pinta a fachada.** O logo do dono do servidor
 *      aparece na barra lateral E no `/login` de quem não entrou — a P0 de
 *      primeira impressão.
 *   2. **A camada da organização NÃO vaza para a fachada.** O logo do cliente
 *      final troca a barra lateral dele e o `/login` continua sendo o do
 *      revendedor. É a propriedade que separa "marca própria" de "qualquer um
 *      repinta a instalação".
 *   3. **O que não é imagem não entra.** Um SVG renomeado para `.png` é recusado
 *      pelos BYTES, com a razão dita em português, e nada muda na tela.
 *   4. **Logo grande é ajustado antes de subir, e o teto continua de pé.** Um
 *      PNG acima de 512 KB com margem transparente é recortado e reduzido pelo
 *      `<canvas>` do navegador, e o arquivo gravado cabe no teto (issue #1655).
 *
 * ═══ CADA CASO MONTA A PRÓPRIA PRECONDIÇÃO (issue #306) ═══
 *
 * Nenhum caso lê o que outro escreveu. Quem precisa de uma camada com logo sobe
 * esse logo — pela tela, com o papel que alcança aquela tela — nas primeiras
 * linhas do próprio caso, e desfaz o que subiu no fim dele.
 *
 * Até esta mudança a spec era `mode: "serial"` e os casos se encadeavam DE
 * PROPÓSITO: o (2) media o logo que o (1) subiu, o (4) começava asseverando o
 * logo que o (3) subiu, o (5) removia o do (3) e o (6) o que o (1) deixou. O
 * preço foi medido pelo autor da issue: 4 reprovações em 8 execuções em dois
 * dias, em casos DIFERENTES — e o caso (4) reprovando na PRECONDIÇÃO ("a barra
 * precisa entrar neste caso COM logo da empresa"), derrubando PRs que não tocam
 * marca. Um caso que depende do anterior reprova por um motivo que não é dele, e
 * a mensagem não diz isso.
 *
 * ═══ QUEM É QUEM ═══
 *
 * O dono do servidor é `e2e-dono@deskcomm.test` (dedicado, `platform_admins`), e
 * o admin de tenant é `e2e-admin@deskcomm.test` — a separação e o porquê estão em
 * `tests/e2e/utils/precondicao.ts`. Os dois entram por `/login/mfa`, e a razão é o
 * CADASTRO, não o papel: `signInWithPassword.ts:93-97` desvia para o desafio
 * quando o usuário tem um fator TOTP verificado, e o seed cadastra um para cada um
 * destes dois (`scripts/seed-e2e-credentials.ts`). Desde a MFA opcional,
 * `requiresMfa` (`lib/auth/server.ts:176-206`) consulta duas políticas cujo padrão
 * é NÃO exigir — ela decide quem é obrigado a cadastrar, e não decide nada sobre
 * quem já cadastrou. Uma versão anterior deste cabeçalho dizia que o gate era
 * `platform_admin || role === "admin"`; isso descreve a regra que o produto tinha
 * antes, e quem lesse aqui concluiria que basta despromover para pular o desafio.
 *
 * ⚠️ Esta spec ESCREVE marca. A restauração (remover os dois logos) é pela ROTA,
 * não por SQL: quem invalida o memo de 30s da marca da instalação é o código do
 * produto (`invalidarMarcaDaInstalacao`), e um `update` direto no banco deixaria a
 * spec seguinte medindo a sobra. Ela mora num `test.afterAll` — o porquê, medido,
 * está no comentário do hook lá embaixo.
 *
 * A limpeza é UMA só — o `test.afterAll` lá embaixo — e já não há limpeza por
 * caso: a subida de cada caso somada à limpeza do anterior batia no teto de
 * trocas de logo que o PRÓPRIO PRODUTO cobra (10 por usuário a cada 5 min, POST e
 * DELETE contando igual), e a suíte reprovava com 429 num defeito que não existia.
 * A NOTA DO TETO DE TROCAS, no caso (1), traz a conta e a medição.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { test, expect, type Page, type Browser, type Locator } from "./helpers/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";
import { TAMANHO_MAXIMO_DO_LOGO } from "@/lib/branding/logo";
import { lerPng, montarPng, ruidoQuantizado } from "../helpers/png-sintetico";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "marca-logo");

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
    return !c.users?.dono || !c.admin_totp?.secret || !c.dono_totp?.secret || !c.org_id;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  // Promove `dono` a platform admin e REVOGA a promoção do `admin` — idempotente.
  // Sem a revogação, o admin de tenant desta spec passaria pelo gate da camada da
  // instalação e o caso (3) mediria o escape, não a separação de camadas.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-system-update.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

const creds = loadCreds();

// ── Os arquivos de teste, gerados aqui ──────────────────────────────────────
//
// PNG de verdade, montado byte a byte, e não um base64 colado: um blob opaco no
// meio da spec é impossível de auditar (ninguém sabe se aquilo é mesmo uma
// imagem), e o caso do SVG depende de os bytes estarem exatamente errados.

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

/** Um PNG sólido de `lado`×`lado`, RGB, sem transparência. */
function pngSolido(lado: number, cor: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const linhas: Buffer[] = [];
  for (let y = 0; y < lado; y++) {
    const linha = Buffer.alloc(1 + lado * 3);
    for (let x = 0; x < lado; x++) {
      linha[1 + x * 3] = cor[0];
      linha[2 + x * 3] = cor[1];
      linha[3 + x * 3] = cor[2];
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

const PNG_DA_PLATAFORMA = pngSolido(48, [0x1d, 0x4e, 0xd8]);
const PNG_DA_ORGANIZACAO = pngSolido(48, [0xd8, 0x4e, 0x1d]);
/** Um SVG legítimo com script — o arquivo que o produto tem de recusar. */
const SVG_DISFARCADO = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><script>fetch("/x")</script><rect width="48" height="48"/></svg>',
  "utf8",
);

/**
 * O PNG da issue #1655: 1536×1024, logo 704×286 no meio, volta 100% transparente
 * com RGB sujo (é o que infla o arquivo) e um furo transparente DENTRO do logo.
 * Mesma geometria de `tests/unit/ajuste-de-logo.test.ts`, que mede o ajuste com o
 * motor sintético; o caso (7) mede o mesmo arquivo com o `<canvas>` real.
 */
const CAIXA_DO_DESIGNER = { x: 416, y: 369, largura: 704, altura: 286 };
const FURO_DO_DESIGNER = { x: 100, y: 60, lado: 24 };

function pngDoDesigner(): Buffer {
  const [largura, altura] = [1536, 1024];
  const rgba = ruidoQuantizado(largura, altura, 0x1671);
  const c = CAIXA_DO_DESIGNER;
  const f = FURO_DO_DESIGNER;
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      const [rx, ry] = [x - c.x, y - c.y];
      const noLogo = rx >= 0 && rx < c.largura && ry >= 0 && ry < c.altura;
      const noFuro = rx >= f.x && rx < f.x + f.lado && ry >= f.y && ry < f.y + f.lado;
      rgba[(y * largura + x) * 4 + 3] = noLogo && !noFuro ? 255 : 0;
    }
  }
  return Buffer.from(montarPng(largura, altura, rgba));
}

// ── Helpers de tela ─────────────────────────────────────────────────────────

/**
 * Entra com senha + TOTP, e só volta quando a tentativa TERMINOU.
 *
 * ⚠️ O LAÇO ANTERIOR DESISTIA NO RELÓGIO E REDIGITAVA EM CIMA DE UMA TELA QUE
 * JÁ TINHA IDO EMBORA. Ele esperava a URL virar `/app/…` por 8s e, no estouro,
 * dormia até a janela do TOTP virar e clicava em `Dígito 1` de novo. Mas 8s é um
 * palpite sobre a MÁQUINA, não sobre o produto: numa máquina carregada o
 * `verifyMfa` demora mais que isso e o código entra DEPOIS do estouro — aí a
 * página já é `/app/inbox`, `input[aria-label="Dígito 1"]` não existe mais, e
 * como `playwright.config.ts` não define `actionTimeout` (o default do
 * Playwright é 0, ou seja SEM teto) esse clique espera até o timeout do CASO.
 *
 * MEDIDO neste worktree, com o mesmo laço antigo numa sonda que replica o caso
 * (1) sob `Emulation.setCPUThrottlingRate` — 2 reprovações em 18 execuções
 * (rate 8 e rate 4), as duas idênticas:
 *
 *   Error: locator.click: Test timeout of 180000ms exceeded.
 *     - waiting for locator('input[aria-label="Dígito 1"]')
 *   NAV http://localhost:3001/app/inbox   (+30862ms)
 *   FIM url=http://localhost:3001/app/inbox
 *
 * E a captura do momento da falha é a CASCA DO TENANT (`navigation
 * "Navegação principal"`, "Inbox" sob "Atendimento") — exatamente o
 * `test-failed-1.png` que a issue #274 descreve como "o navegador está no inbox
 * do tenant, não em /admin/marca". Não há desvio de modo no produto: quem larga
 * a página lá é este helper.
 *
 * O conserto não é um teto maior — um relógio maior continua sendo um relógio.
 * É esperar um ESTADO TERMINAL, e só existem dois depois de digitar os 6
 * dígitos: ou a sessão subiu (a URL vira `/app/…`), ou o formulário disse não
 * (`MfaForm.tsx` renderiza um `role="alert"` dentro do `<form>`; o `TOTPInput`
 * fica `disabled` enquanto a ação está em voo, então antes disso NENHUM dos
 * dois é verdade). Os dois são disjuntos: o sucesso redireciona sem nunca
 * escrever o alerta, e a recusa nunca troca a URL.
 *
 * A única espera por relógio que fica é a da JANELA do TOTP, e ela não é aposta
 * na máquina: dentro da mesma janela de 30s o `generateTotp` devolve o MESMO
 * código que o servidor acabou de recusar, então o que muda o próximo código é
 * o relógio do protocolo, e só ele.
 */
async function loginComTotp(page: Page, email: string, secret: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click({ timeout: 15_000 });
  await page.waitForURL(/\/login\/mfa/);

  const digito1 = page.locator('input[aria-label="Dígito 1"]');
  // Escopado no `<form>` de propósito: o `<Toaster/>` do layout raiz também
  // emite elementos com papel de aviso, e um toast de outra tela seria lido
  // aqui como recusa do desafio.
  const recusa = page.locator("form").getByRole("alert");

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    // Teto EXPLÍCITO no clique: sem `actionTimeout` no config, um controle que
    // sumiu esperaria até o timeout do caso e a reprovação sairia como "Test
    // timeout" apontando para o clique — sem dizer que o login já tinha entrado.
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
      throw new Error(
        `o desafio de MFA de ${email} não terminou em 60s: a URL não virou /app/… ` +
          `e o formulário não recusou. url=${page.url()}`,
      );
    }
    await page.waitForTimeout(msUntilNextTotpWindow() + 200);
  }
  throw new Error(`MFA falhou depois de 2 tentativas para ${email} (url=${page.url()})`);
}

type Escopo = "instalacao" | "organizacao";

async function subir(page: Page, escopo: Escopo, arquivo: {
  nome: string;
  mime: string;
  bytes: Buffer;
}): Promise<void> {
  // A hidratação, e não a visibilidade. `setInputFiles` espera o elemento estar
  // ANEXADO, e o input existe no HTML do SSR antes de o React atar o `onChange`
  // — arquivo posto nessa janela não dispara requisição nenhuma, e o caso morre
  // esperando 15s por um toast sem emissor. Foi o vermelho medido no run
  // 32404132717 (att.1): `load` às 472156ms, `setInputFiles` 46ms depois, e ZERO
  // POST para /api/v1/marca/logo no trace inteiro.
  await expect(
    page.locator(`[data-campo-de-logo='${escopo}'][data-hidratado]`),
    `o campo de logo da camada "${escopo}" não hidratou — pôr o arquivo agora não dispara nada`,
  ).toBeVisible({ timeout: 15_000 });
  await page.locator(`#logo-${escopo}`).setInputFiles({
    name: arquivo.nome,
    mimeType: arquivo.mime,
    buffer: arquivo.bytes,
  });
}

/**
 * Remove o logo desta camada SE houver um — a peça da restauração.
 *
 * Tolerante a "não há nada para remover" de propósito: o botão só é renderizado
 * quando a camada tem logo próprio (`CampoDeLogo.tsx:252`), e o hook precisa poder
 * rodar tanto depois da spec inteira (onde os casos já removeram) quanto depois de
 * um estouro no primeiro caso (onde nada chegou a ser subido). Um `click()` cego
 * nos dois casos esperaria até o timeout e transformaria a limpeza em vermelho.
 */
async function removerLogoSeHouver(page: Page, tela: string, escopo: Escopo): Promise<void> {
  await page.goto(tela);
  const remover = page
    .locator(`[data-campo-de-logo='${escopo}']`)
    .getByRole("button", { name: /^remover$/i });
  if ((await remover.count()) === 0) return;
  await remover.click();
  await expect(page.getByText(/logo removido/i)).toBeVisible({ timeout: 15_000 });
}

/** O que um `<img>` do produto mostra, medido por ferramenta. */
interface LogoNaTela {
  readonly src: string;
  /** A altura pintada. Descritiva — quem prova download é `larguraNatural`. */
  readonly altura: number;
  /** A largura do BITMAP decodificado: 0 = o navegador não tem imagem. */
  readonly larguraNatural: number;
}

/**
 * Mede um `<img>` DEPOIS de o navegador terminar com ele.
 *
 * ⚠️ Quem prova o download é `naturalWidth`, e NÃO a altura na tela — o contrário
 * do que esta spec afirmou. Os dois `<img>` de marca do produto têm altura fixada
 * por CSS (`h-7` em `components/shell/Sidebar.tsx:82`, `h-10` em
 * `app/(public)/layout.tsx:54`), e altura fixa mede o mesmo para quem baixou e
 * para quem não baixou. MEDIDO em chromium, dois `<img>` sob `height: 1.75rem`
 * (o `h-7`), um com PNG válido e outro apontando para um endereço morto:
 *
 *   boa={"nat":1,"altura":28}   quebrada={"nat":0,"altura":28}
 *
 * `altura > 0` passava nos DOIS — ou seja, passava exatamente no cenário (bucket
 * privado, URL assinada vencida) que ela alegava cobrir. `naturalWidth` é a
 * dimensão do bitmap decodificado, e só ele separa os dois casos. Provar este elo
 * é a razão declarada de esta spec existir em vez de um `curl`.
 *
 * A espera pelo `load`/`error` antes de medir não é zelo: sem ela, medir cedo
 * demais devolve `naturalWidth: 0` de uma imagem que estava só a caminho — um
 * vermelho por corrida, no lugar de um vermelho por defeito.
 */
async function medirImagem(img: Locator): Promise<LogoNaTela> {
  await expect(img).toBeVisible();
  await img.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        const imagem = el as HTMLImageElement;
        // `complete` é true também quando o download FALHOU — que é o caso que
        // interessa medir. Ele encerra a espera; quem separa sucesso de falha é
        // o `naturalWidth` logo abaixo.
        if (imagem.complete) return resolve();
        imagem.addEventListener("load", () => resolve(), { once: true });
        imagem.addEventListener("error", () => resolve(), { once: true });
        // Teto próprio: sem ele um download pendurado consumiria o timeout do
        // teste inteiro, e a reprovação sairia como "timed out" sem dizer o quê.
        setTimeout(() => resolve(), 10_000);
      }),
  );
  return img.evaluate((el) => ({
    src: (el as HTMLImageElement).src,
    altura: el.getBoundingClientRect().height,
    larguraNatural: (el as HTMLImageElement).naturalWidth,
  }));
}

/**
 * O logo da barra lateral. `null` = a barra está sem `<img>` (nome em texto).
 *
 * ⚠️ Esta função devolvia `null` para TRÊS estados diferentes, e a asserção que a
 * consome culpava um QUARTO. Um vermelho real disse "a recusa apagou o logo — a
 * gravação não foi atômica", e a investigação provou que nada tinha sido apagado:
 * o `afterAll`, seis segundos depois, clicou "Remover" nas DUAS camadas e recebeu
 * 200 nas duas — o que só acontece com os dois `logo_path` ainda no banco.
 *
 * Os três estados que viravam o mesmo `null`:
 *   1. a barra existe e está sem `<img>`  — o que a asserção quer medir;
 *   2. **não há barra nenhuma** — a página redirecionou (`/login`, `/onboarding`,
 *      `/account-suspended`, `/403`) ou o `MfaEnrollGate` trocou a casca inteira;
 *   3. mediu antes de a casca montar.
 *
 * O (2) é o provável, porque para o (1) acontecer as DUAS camadas de marca teriam
 * de estar vazias — e a da instalação não foi tocada pelo caso que falhou.
 *
 * Agora a casca é provada ANTES: `toHaveURL(/\/app\//)` separa "redirecionou" de
 * "a barra perdeu o logo" a custo zero, e a espera pelo `<aside>` separa o (3).
 * Nenhuma asserção ficou mais frouxa: o caso continua vermelho se o logo sumir
 * de verdade — só passa a dizer QUAL das coisas aconteceu.
 */
async function logoDaBarra(page: Page): Promise<LogoNaTela | null> {
  await expect(
    page,
    `saiu de /app — ${page.url()}. A barra não sumiu: a PÁGINA é outra ` +
      `(redirect de auth, onboarding, suspensão, 403 ou o gate de MFA).`,
  ).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });

  const casca = page.locator("aside").first();
  await expect(
    casca,
    `a casca do app não montou em /app — ${page.url()}. Sem <aside> não há o que medir.`,
  ).toBeAttached({ timeout: 15_000 });

  const img = casca.locator("img").first();
  // `count()` é a ÚNICA leitura sem auto-espera do helper, e por isso era ela
  // que media durante a troca de documento: `goto("/app")` cai num
  // `redirect("/app/inbox")` (app/app/page.tsx tem 3 linhas), o Next serve /app
  // com 200 e HTML completo, e emite a redireção depois — o `count()` corria no
  // documento novo ainda vazio e devolvia 0 com a barra CERTA a caminho.
  // Medido no run 32403198687: `queryCount` levou 541ms e voltou 0; 44ms depois
  // o bitmap do logo baixou, e o `test-failed-1.png` mostra a barra com o logo.
  // `toBeAttached` com teto preserva a ausência como resposta legítima — só que
  // agora ela significa "5s sem <img>", não "não havia <img> naquele milissegundo".
  try {
    await expect(img).toBeAttached({ timeout: 5_000 });
  } catch {
    return null;
  }
  return medirImagem(img);
}

/** O que prova que o logo BAIXOU, e não só que o `src` está escrito. */
function baixou(logo: LogoNaTela, onde: string): void {
  expect(
    logo.larguraNatural,
    `${onde}: o <img> tem src mas o bitmap veio vazio — o navegador não baixou do bucket público`,
  ).toBeGreaterThan(0);
}

/**
 * Prova que a medição SEGUINTE acontece na tela que o caso diz medir.
 *
 * ⚠️ O TOAST NÃO PROVA ISSO, e é essa confusão que a issue #274 custou. O
 * `<Toaster/>` mora no layout RAIZ (`app/layout.tsx`), irmão de `{children}` e
 * com `duration={4000}`: ele sobrevive a qualquer troca de rota do lado do
 * cliente. E `enviar()` (`CampoDeLogo.tsx`) chama `toast.success` de dentro de
 * uma função async solta — o toast aparece mesmo que o campo JÁ tenha
 * desmontado. Ou seja "Logo atualizado." verde + prévia ausente é EXATAMENTE o
 * que se vê quando a página não é mais a de marca, e sem esta âncora a
 * reprovação sai como `element(s) not found`, que manda quem lê procurar
 * defeito na prévia — que foi o que aconteceu.
 *
 * Mesma lição de `logoDaBarra()` logo acima, aplicada ao outro lado da tela: a
 * asserção não fica mais frouxa (a prévia continua sendo exigida), ela só passa
 * a dizer QUAL das duas coisas aconteceu.
 */
async function aindaNaTelaDeMarca(page: Page, rota: RegExp, escopo: Escopo): Promise<void> {
  await expect(
    page,
    `a página não é mais ${rota} — url=${page.url()}. O toast de sucesso não desmente ` +
      `isto: ele mora no layout raiz e sobrevive à troca de rota.`,
  ).toHaveURL(rota, { timeout: 15_000 });
  await expect(
    page.locator(`[data-campo-de-logo='${escopo}']`),
    `a rota é ${rota} mas o campo de logo da camada "${escopo}" não está montado`,
  ).toBeAttached({ timeout: 15_000 });
}

// ── A precondição de cada caso: a camada, a tela, o papel e o arquivo ───────
//
// Tudo o que um caso precisa para montar o próprio estado mora aqui (issue #306).
// As peças de cada camada estão no MESMO lugar de propósito: quem lê o caso (3)
// não tem de descobrir em outro caso qual arquivo sobe naquela tela, nem com qual
// login — era exatamente esse o fio solto que a issue mediu.

interface Camada {
  /** A tela que edita ESTA camada. */
  readonly tela: string;
  /** A rota daquela tela, para a âncora provar que a medição seguinte é ali. */
  readonly rota: RegExp;
  /** O papel que alcança a tela: o `dono` é platform admin, o `admin` é do tenant. */
  readonly papel: "dono" | "admin";
  readonly arquivo: { nome: string; mime: string; bytes: Buffer };
}

const CAMADAS: Record<Escopo, Camada> = {
  instalacao: {
    tela: "/admin/marca",
    rota: /\/admin\/marca(\/|$)/,
    papel: "dono",
    arquivo: { nome: "logo-da-plataforma.png", mime: "image/png", bytes: PNG_DA_PLATAFORMA },
  },
  organizacao: {
    tela: "/app/settings/marca",
    rota: /\/app\/settings\/marca(\/|$)/,
    papel: "admin",
    arquivo: { nome: "logo-da-empresa.png", mime: "image/png", bytes: PNG_DA_ORGANIZACAO },
  },
};

/** A credencial do papel que alcança a camada — e o erro diz QUAL credencial falta. */
function credencialDaCamada(escopo: Escopo): { email: string; secret: string } {
  const { papel } = CAMADAS[escopo];
  const email = papel === "dono" ? creds.users.dono?.email : creds.users.admin?.email;
  const secret = (papel === "dono" ? creds.dono_totp : creds.admin_totp)?.secret;
  expect(
    email,
    `sem \`${papel}\` em \`users\` do .e2e-creds.json — rode seed-e2e-credentials.ts`,
  ).toBeTruthy();
  expect(
    secret,
    `sem \`${papel}_totp\` no .e2e-creds.json — rode seed-e2e-credentials.ts`,
  ).toBeTruthy();
  return { email: email!, secret: secret! };
}

/**
 * Entra na sessão da camada. UM login por página, sempre: as fixtures `page` e
 * `context` são de escopo de TESTE (ver o comentário do `describe`), e uma segunda
 * entrada no mesmo contexto passaria por um `/login` já autenticado. Quem precisa
 * de dois papéis abre dois contextos — é o que os casos (3) e (5) fazem.
 */
async function entrarNaCamada(page: Page, escopo: Escopo): Promise<void> {
  const { email, secret } = credencialDaCamada(escopo);
  await loginComTotp(page, email, secret);
}

/**
 * Deixa a camada COM logo próprio, PELA TELA — a precondição que cada caso monta
 * para si mesmo (issue #306).
 *
 * Substitui o encadeamento: quem precisa da camada da empresa pintada não espera
 * mais que outro caso a tenha pintado, e o arquivo sobe na tela daquela camada,
 * com o login daquela camada.
 */
async function subirLogoDaCamada(page: Page, escopo: Escopo): Promise<void> {
  const camada = CAMADAS[escopo];
  await page.goto(camada.tela);
  // O sinal de prontidão é a HIDRATAÇÃO, não a visibilidade do input de arquivo:
  // o próprio `CampoDeLogo.tsx` diz que "visível" é propriedade do SSR e o input
  // existe no HTML antes de o React atar o `onChange`. O vermelho do run
  // 35091061135 nasceu aqui — `#logo-instalacao` ainda não estava no DOM aos 5s do
  // `expect` padrão, e o caso (6) morreu na PRECONDIÇÃO com "element(s) not found".
  await expect(
    page.locator(`[data-campo-de-logo='${escopo}'][data-hidratado]`),
    `o campo de logo da camada "${escopo}" não apareceu em ${camada.tela}`,
  ).toBeVisible({ timeout: 15_000 });
  await subir(page, escopo, camada.arquivo);
  await expect(page.getByText(/logo atualizado/i)).toBeVisible({ timeout: 15_000 });
  // A âncora da issue #274 fecha a subida: o toast mora no layout raiz e sobrevive
  // à troca de rota, então ele sozinho não prova em que tela a medição acontece.
  await aindaNaTelaDeMarca(page, camada.rota, escopo);
}

/**
 * A barra lateral PASSOU a mostrar o logo desta camada — esperando o VALOR.
 *
 * ⚠️ O POST volta 200 com o `logo_url`, mas quem pinta a barra é o render do
 * SERVIDOR que o `router.refresh()` traz — e este arquivo já documentou esse mesmo
 * refresh sendo descartado (`ERR_ABORTED` na rajada de prefetch RSC da barra, run
 * 31888655412, sem retentativa). Medir o `src` UMA vez logo depois do toast é
 * apostar nesse pacote, e é a classe exata que a issue #306 mediu reprovando em
 * caso diferente a cada execução. `toHaveAttribute` POLLA o valor (a cada 100ms,
 * até o teto): a espera é pelo estado da tela, não por um relógio.
 *
 * O que se espera é o endereço da camada CERTA, e não "uma imagem qualquer": com
 * `activeOrg?.marca?.logoUrl || brand.logoUrl` (`Sidebar.tsx`), "a barra tem logo"
 * fica verde com o logo da camada de BAIXO — que é o caso em que a precondição
 * teria de reprovar.
 */
async function barraMostraLogoDe(
  page: Page,
  caminhoNoBucket: string,
  onde: string,
): Promise<LogoNaTela> {
  await expect(
    page.locator("aside").first().locator("img").first(),
    `${onde}: a barra lateral não passou a mostrar o logo da camada — esperava um src ` +
      `com "brand-logos/${caminhoNoBucket}" e há outro (ou nenhum)`,
  ).toHaveAttribute("src", new RegExp(`brand-logos/${caminhoNoBucket}`), { timeout: 15_000 });
  const logo = await logoDaBarra(page);
  expect(logo, `${onde}: a barra tem o src certo no HTML mas nenhum <img> medível`).not.toBeNull();
  baixou(logo!, onde);
  return logo!;
}

/**
 * O logo da FACHADA (as telas de antes de entrar), visto por quem não entrou.
 *
 * O seletor é o `data-testid` do `<img>` de `app/(public)/layout.tsx`, e não "a
 * primeira imagem da página": a asserção de NEGAÇÃO do caso (3) — a fachada não
 * mostra o logo da empresa — passaria vacuosamente no dia em que qualquer ícone
 * entrasse antes do logo no DOM do `/login`.
 */
async function logoDoLogin(browser: Browser): Promise<LogoNaTela | null> {
  // Contexto NOVO e sem sessão: é o estado de quem acabou de receber o endereço.
  const contexto = await browser.newContext();
  try {
    const pagina = await contexto.newPage();
    await pagina.goto("/login");
    const img = pagina.getByTestId("logo-da-fachada");
    // Ausência é resposta legítima: sem logo em nenhuma camada, o layout não
    // renderiza `<img>` nenhum e a fachada aparece com o nome em texto. Mas
    // `count()` puro tornava "ausente" indistinguível de "ainda não montou" —
    // é a mesma classe do helper da barra, consertada junto por isso.
    try {
      await expect(img).toBeAttached({ timeout: 5_000 });
    } catch {
      return null;
    }
    return await medirImagem(img);
  } finally {
    await contexto.close();
  }
}

const PREFIXO_PUBLICO = "/storage/v1/object/public/brand-logos/";

function evidencia(nome: string): string {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return path.join(EVIDENCIA, nome);
}

// ── A spec ──────────────────────────────────────────────────────────────────

/**
 * SEM `mode: "serial"` (issue #306).
 *
 * O modo serial ENCADEIA por contrato: quando um caso estoura, os seguintes saem
 * como "did not run" — o relatório diz que UMA coisa quebrou e esconde se as
 * outras cinco passariam, que é meia informação em toda investigação. E as
 * dependências que ele existia para expressar ("o (4) só faz sentido depois do
 * (3)") foram removidas: cada caso monta a própria precondição, então a ordem
 * deixou de ser premissa.
 *
 * A ORDEM CONTINUA GARANTIDA, e não por sorte: `playwright.config.ts` roda com
 * `workers: 1` (`:112`) e `fullyParallel: false` (`:95`), e a própria
 * documentação do config diz o que isso significa — "`fullyParallel: false`
 * serializa apenas DENTRO de cada arquivo" (`:97-98`). Sem `serial`, os casos de
 * um arquivo continuam indo para o MESMO worker, em ordem de declaração. O que
 * sai com a linha é o "pula os próximos", não a sequência.
 *
 * E a sequência continua desejada: as duas camadas de marca são as MESMAS linhas
 * do banco para todos os casos, então dois casos correndo juntos se atropelariam.
 */

test.describe("o logo subido pela tela chega à tela", () => {
  /**
   * TODO CASO QUE PRECISA DE SESSÃO FAZ O PRÓPRIO LOGIN. Não existe "um login por
   * papel no arquivo": `mode: "serial"` encadeia a ORDEM e o ESTADO DO BANCO, não
   * a sessão do navegador. As fixtures `context` e `page` são de escopo de TESTE
   * (medido na fonte do Playwright 1.62.1 instalado,
   * `playwright/lib/index.js:425` e `:443`: são funções simples, sem o
   * `{ scope: "worker" }` que fecha a definição de `browser:` — a que começa
   * na linha 216 e traz a opção na 238), então cada `test` recebe um
   * BrowserContext novo, com cookies zerados.
   *
   * Este comentário já afirmou o contrário, e o custo era invisível: os casos (4)
   * e (5) começavam deslogados, `page.goto` caía no redirect de `requireAuth()`, o
   * seletor do campo nunca aparecia — e como `playwright.config.ts` não define
   * `actionTimeout` (o default do Playwright é 0, `lib/index.js:259`), a espera ia
   * até estourar os 120s abaixo.
   *
   * O teto de login não é razão para economizar sessão aqui: o CI roda com
   * `AUTH_RATE_LIMIT_LOGIN_IP: "1000"` (`.github/workflows/e2e.yml`), e as specs
   * vizinhas — `system-update.spec.ts`, seis casos, seis logins — fazem assim.
   *
   * O TETO DO CASO SUBIU PARA 180s junto com a mudança da issue #306: cada caso
   * monta a própria precondição, e três deles passaram a ter DOIS logins com TOTP
   * em vez de um — um por papel, porque o `dono` pinta a camada da instalação e o
   * `admin` do tenant a da empresa (e o admin NÃO alcança `/admin/marca`: é a
   * separação que esta spec prova, então não dá para economizar o login do dono).
   *
   * Dois logins com o relógio do TOTP cabem em 120s no melhor caso e não no pior:
   * quando o código cai no fim da janela, `loginComTotp` espera a janela virar
   * antes de tentar de novo (até ~30s só aí — o número está no comentário do
   * `afterAll`). Nenhum teto INTERNO mudou (15s de toast, 15s de âncora, 60s de
   * URL) e nenhuma asserção ficou mais frouxa: o que mudou é quanto trabalho o
   * caso faz, e o teto dele acompanha o trabalho.
   */
  test.setTimeout(180_000);

  test("(1) o dono do servidor sobe o logo e ele aparece na barra lateral", async ({ page }) => {
    // ESTE CASO NÃO USA `subirLogoDaCamada`, de propósito: a subida é o que ele
    // MEDE, e a ordem na FONTE importa — `tests/unit/marca-logo-spec-ancora-a-rota.test.ts`
    // lê este arquivo e cobra toast antes, âncora no meio e prévia depois. Os
    // outros casos usam o helper justamente porque, para eles, a subida é
    // precondição, e não objeto de medida (issue #306).
    const secret = creds.dono_totp?.secret;
    expect(secret, "sem `dono_totp` no .e2e-creds.json — rode seed-e2e-credentials.ts").toBeTruthy();
    await loginComTotp(page, creds.users.dono!.email, secret!);

    await page.goto("/admin/marca");
    await expect(page.locator("#logo-instalacao")).toBeVisible();
    await subir(page, "instalacao", {
      nome: "logo-da-plataforma.png",
      mime: "image/png",
      bytes: PNG_DA_PLATAFORMA,
    });
    await expect(page.getByText(/logo atualizado/i)).toBeVisible({ timeout: 15_000 });

    // A prévia sobre as DUAS superfícies mostra a imagem real — é o que
    // substituiu o analisador de luminância no servidor.
    //
    // ⚠️ ESTA ASSERÇÃO JÁ FOI INTERMITENTE, E O DEFEITO ERA DO PRODUTO. O
    // comentário anterior dizia "15s, e não o default de 5s: a prévia só nasce
    // quando o RSC do `router.refresh()` volta… os 5s mediam a máquina de quem
    // escreveu" — ou seja, tratava como lentidão o que era uma tela que nunca
    // atualizava. Subir 5s→15s não mudou nada (ela reprovou nos dois), o que já
    // era a pista: não se espera mais por quem não vem.
    //
    // O trace do run 31888655412 mostrou o porquê: o POST voltou 200 com o
    // `logo_url`, o `GET /admin/marca?_rsc=…` do refresh voltou `ERR_ABORTED`
    // (descartado na rajada de prefetch RSC da barra lateral), e não houve
    // retentativa — nenhum pacote nos 14s seguintes. A tela ficou no render
    // anterior com o toast de sucesso na frente.
    //
    // O conserto é no produto: `CampoDeLogo` aplica o corpo da resposta na
    // prévia e mantém o `refresh()` só para reconciliar o resto da página
    // (`CampoDeLogo.tsx:109-152`, guardado por
    // `tests/unit/marca-previa-do-logo-sem-refresh.test.tsx`). A asserção não
    // foi afrouxada em nada — continua exigindo `<img>` na prévia; o que mudou é
    // que o produto passou a prometê-la de forma determinística. Os 15s ficam
    // como folga de máquina carregada, não como aposta no refresh.
    //
    // A ÂNCORA VEM ANTES DA MEDIÇÃO, e não é zelo: o toast acima é do layout
    // raiz e sobrevive à troca de rota, então ele sozinho não prova que ainda
    // estamos aqui. Ver `aindaNaTelaDeMarca` (issue #274).
    await aindaNaTelaDeMarca(page, /\/admin\/marca(\/|$)/, "instalacao");
    await expect(page.locator("[data-previa-do-logo='claro'] img")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("[data-previa-do-logo='escuro'] img")).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: evidencia("1-admin-marca-previa.png"), fullPage: true });

    await page.goto("/app/inbox");
    const barra = await logoDaBarra(page);
    expect(barra, "nenhuma <img> na barra lateral depois do upload").not.toBeNull();
    expect(barra!.src).toContain(`${PREFIXO_PUBLICO}platform/`);
    baixou(barra!, "barra lateral do dono");
    await page.screenshot({ path: evidencia("2-sidebar-do-dono.png") });

    // ── A NOTA DO TETO DE TROCAS (issue #306) ────────────────────────────────
    // Este caso NÃO limpa o que subiu, e nenhum outro limpa: a limpeza é a do
    // `afterAll` no fim do arquivo.
    //
    // O motivo é MEDIDO, não estilo: o produto cobra 10 trocas de logo por usuário
    // a cada 5 min (`app/api/v1/marca/logo/route.ts` — o teto do POST e o do
    // DELETE são o mesmo, então REMOVER conta tanto quanto subir). Com subida +
    // limpeza por caso, a conta do `dono` (casos 1, 2, 3, 5 e 6) fechava a PRIMEIRA
    // tentativa em DEZ operações — o teto inteiro. A retentativa do caso (6) é a
    // 11ª, e é ela que voltou 429 ("Muitas trocas de logo seguidas"): o toast de
    // erro tomou o lugar do de sucesso, e o caso morreu esperando 15s por um toast
    // que o produto tinha razão em não dar. MEDIDO no trace do run 35095930532,
    // caso (6): `POST /api/v1/marca/logo → 429`.
    //
    // Sem a limpeza por caso as contas ficam em 7 (`dono`) e 5 (`admin`) — 8 e 6 no
    // pior caso, com o `afterAll` ainda tendo o que limpar. Isso deixa margem para
    // uma retentativa, e o teto CONTINUA valendo: quem somar operações aqui precisa
    // caber nele.
    //
    // Nada depende da sobra: cada caso monta a própria precondição, e o `afterAll`
    // limpa as duas camadas para as specs seguintes do mesmo banco.
  });

  test("(2) quem NÃO entrou vê o logo do dono na tela de acesso — a P0", async ({
    page,
    browser,
  }) => {
    // ── A PRECONDIÇÃO QUE ESTE CASO MONTA PARA SI MESMO (issue #306) ──────────
    // "O logo do dono" só está nesta tela se a camada da INSTALAÇÃO estiver
    // pintada, e quem a pinta é este caso. Antes ele media o que o caso (1)
    // tivesse deixado: "o logo do dono" e "a sobra do caso (1)" eram
    // indistinguíveis daqui, e o caso reprovava por causa de outro.
    await entrarNaCamada(page, "instalacao");
    await subirLogoDaCamada(page, "instalacao");

    const fachada = await logoDoLogin(browser);
    expect(fachada, "a tela de acesso não renderizou logo nenhum").not.toBeNull();
    expect(fachada!.src).toContain(`${PREFIXO_PUBLICO}platform/`);
    // A P0 é ver o logo, não ter o endereço dele escrito: é aqui que um bucket
    // privado apareceria, e é a única tela onde ninguém está logado para ver.
    baixou(fachada!, "tela de acesso");

    const contexto = await browser.newContext();
    const pagina = await contexto.newPage();
    await pagina.goto("/login");
    await pagina.screenshot({ path: evidencia("3-login-deslogado.png"), fullPage: true });
    await contexto.close();

    // Sem `limparCamada` aqui: o teto de trocas por usuário do produto — ver a
    // NOTA DO TETO no caso (1).
  });

  test("(3) o logo da EMPRESA troca a barra dela e NÃO vaza para a tela de acesso", async ({
    page,
    browser,
  }) => {
    // ── AS DUAS PRECONDIÇÕES DESTE CASO, MONTADAS AQUI (issue #306) ───────────
    // (a) A EMPRESA com logo: é o que este caso mede na barra, e quem sobe é o
    //     `admin` do tenant, na tela dele.
    // (b) A INSTALAÇÃO com logo, embaixo: a asserção "a fachada continua a do
    //     revendedor" só prova separação de camadas se houver uma camada de baixo
    //     para continuar sendo ela. Sem ela, a fachada mostraria o `APP_LOGO_URL`
    //     do `.env` (ou nada) e a asserção ficaria verde pelo motivo errado — e
    //     era o caso (1) que a pintava, o encadeamento que esta issue remove.
    // A camada de baixo entra na sessão DO DONO, num contexto próprio: dois papéis
    // são dois logins, e um contexto com dois `loginComTotp` em sequência passaria
    // por um `/login` já autenticado.
    const ctxInstalacao = await browser.newContext();
    const paginaInstalacao = await ctxInstalacao.newPage();
    try {
      await entrarNaCamada(paginaInstalacao, "instalacao");
      await subirLogoDaCamada(paginaInstalacao, "instalacao");

      await entrarNaCamada(page, "organizacao");
      await subirLogoDaCamada(page, "organizacao");

      await page.goto("/app/inbox");
      // A espera é no VALOR: o POST volta 200 antes de a barra refletir, e medir o
      // `src` uma única vez é a classe que a issue #306 mediu reprovando em caso
      // diferente a cada execução.
      const barra = await barraMostraLogoDe(page, `${creds.org_id}/`, "barra lateral da empresa");
      expect(barra.src, "a barra lateral mostrou outro logo, não o da empresa").toContain(
        `${PREFIXO_PUBLICO}${creds.org_id}/`,
      );
      await page.screenshot({ path: evidencia("4-sidebar-da-empresa.png") });

      // A camada de cima NÃO alcança a fachada: quem não entrou continua vendo o
      // logo do revendedor. Sem esta asserção, o caso (1) e o (3) seriam
      // indistinguíveis de "o último upload repinta tudo".
      const noLogin = await logoDoLogin(browser);
      expect(noLogin, "a tela de acesso ficou sem logo depois do upload da empresa").not.toBeNull();
      expect(noLogin!.src).toContain(`${PREFIXO_PUBLICO}platform/`);
      expect(noLogin!.src).not.toContain(`${PREFIXO_PUBLICO}${creds.org_id}/`);

      // Sem `limparCamada` aqui: o teto de trocas por usuário do produto — ver a
      // NOTA DO TETO no caso (1).
    } finally {
      await ctxInstalacao.close();
    }
  });

  test("(4) SVG renomeado para .png é recusado pelos BYTES, com a razão dita", async ({ page }) => {
    // ── A PRECONDIÇÃO QUE ESTE CASO MONTA PARA SI MESMO (issue #306) ──────────
    // Até esta mudança o caso (4) começava asseverando o logo que o caso (3)
    // tinha subido, e a reprovação saía exatamente assim — no relato do autor da
    // issue: "5ª execução: caso (4) falhou na precondição — a barra precisa entrar
    // neste caso COM logo da empresa". Ou seja: um PR que não toca marca caía por
    // causa de um estado que outro caso devia ter deixado. Aqui ele SOBE o próprio
    // logo da empresa e espera a barra refletir, então uma falha dele é dele.
    await entrarNaCamada(page, "organizacao");
    await subirLogoDaCamada(page, "organizacao");

    await page.goto("/app/inbox");
    // O estado de partida é o logo que ESTE caso subiu, e a espera é no VALOR —
    // `barraMostraLogoDe` POLLA o endereço da camada CERTA. `Sidebar.tsx` faz
    // `activeOrg?.marca?.logoUrl || brand.logoUrl`: se a camada da organização
    // ainda não tivesse chegado à barra, o que estaria lá é o logo da INSTALAÇÃO,
    // a comparação lá embaixo (`depois === antes`) viraria tautologia — comparando
    // o logo da instalação consigo mesmo — e o caso se chama "o logo da empresa
    // sobrevive à recusa". Então é o da empresa que a precondição tem de provar,
    // e é isso que o poll garante.
    const antes = await barraMostraLogoDe(page, `${creds.org_id}/`, "precondição do caso (4)");
    expect(antes.src, "a barra lateral mostrou outro logo, não o da empresa").toContain(
      `${PREFIXO_PUBLICO}${creds.org_id}/`,
    );

    await page.goto("/app/settings/marca");
    await subir(page, "organizacao", {
      // Nome E `Content-Type` mentem — os dois campos que o atacante escolhe.
      nome: "logo.png",
      mime: "image/png",
      bytes: SVG_DISFARCADO,
    });
    // A recusa tem código próprio para a frase falar de SVG, e não "tipo de
    // mídia não suportado": é o formato em que um designer entrega logo.
    //
    // ⚠️ A âncora é DUPLA de propósito, e nenhuma metade é decorativa. O texto de
    // ajuda do campo (`CampoDeLogo.tsx:258-262`) diz, o tempo todo e antes de
    // qualquer upload, "SVG não é aceito: ele pode executar código…" — então
    // `getByText(/SVG não é aceito/i)` casava aquele `<p>` em t=0 e ficava verde
    // sem o toast jamais ter existido (e virava violação de strict mode quando o
    // toast aparecia no mesmo poll, com 2 elementos). O contêiner do toast
    // (`[data-sonner-toast]`) exclui o texto de ajuda; "aceito COMO LOGO" é a
    // frase que só a rota escreve (`app/api/v1/marca/logo/route.ts:396`).
    const recusa = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: /SVG não é aceito como logo/i });
    await expect(recusa).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: evidencia("5-svg-recusado.png"), fullPage: true });

    await page.goto("/app/inbox");
    const depois = await logoDaBarra(page);
    // ⚠️ As mensagens NÃO acusam mais a gravação. A versão anterior dizia "a
    // recusa apagou o logo — a gravação não foi atômica", e isso é impossível
    // por construção: a recusa por bytes sai da rota com 415 em
    // `route.ts:399-406`, treze linhas ANTES da primeira leitura do banco
    // (`:419`) e vinte antes do primeiro toque no storage. Uma mensagem que
    // nomeia uma causa impossível manda o próximo leitor investigar o lugar
    // errado — foi o que aconteceu, e custou caro.
    expect(
      depois,
      `a barra ficou sem logo depois de uma recusa (a recusa não escreve nada — ` +
        `se isto reprovar, o logo sumiu por outro caminho)`,
    ).not.toBeNull();
    expect(depois!.src, "a recusa trocou o logo por outro").toBe(antes.src);

    // Sem `limparCamada` aqui: o teto de trocas por usuário do produto — ver a
    // NOTA DO TETO no caso (1).
  });

  test("(5) remover devolve o logo da camada de baixo", async ({ page, browser }) => {
    // ── AS DUAS PRECONDIÇÕES DESTE CASO, MONTADAS AQUI (issue #306) ───────────
    // "Devolve o logo da camada de baixo" precisa das DUAS camadas: a de cima,
    // para haver o que remover, e a de baixo, para haver o que aparecer no lugar.
    // A de baixo era o que o caso (1) tivesse deixado — e é a razão de este caso
    // poder reprovar junto com ele.
    const ctxInstalacao = await browser.newContext();
    const paginaInstalacao = await ctxInstalacao.newPage();
    try {
      await entrarNaCamada(paginaInstalacao, "instalacao");
      await subirLogoDaCamada(paginaInstalacao, "instalacao");

      await entrarNaCamada(page, "organizacao");
      await subirLogoDaCamada(page, "organizacao");

      // A barra já mostra o DA EMPRESA antes de a remoção começar, e a espera é no
      // VALOR (ver `barraMostraLogoDe`): sem ela, "sobrou o da instalação" e "a
      // barra nunca chegou a pintar o da empresa" seriam o mesmo verde — a barra
      // cai no logo da instalação pelo mesmo `||` que faz o caso passar.
      await page.goto("/app/inbox");
      await barraMostraLogoDe(page, `${creds.org_id}/`, "precondição do caso (5)");

      await page.goto("/app/settings/marca");
      // O botão só existe quando ESTA camada tem logo próprio (`CampoDeLogo.tsx:252`):
      // a asserção nomeia a precondição em vez de deixá-la sair como um clique que
      // esperou até o timeout.
      const remover = page.locator("[data-campo-de-logo='organizacao']").getByRole("button", {
        name: /^remover$/i,
      });
      await expect(
        remover,
        "precondição: a empresa precisa entrar neste caso COM logo próprio — " +
          "quem o subiu foi este caso, três passos acima",
      ).toBeVisible();
      await remover.click();
      await expect(page.getByText(/logo removido/i)).toBeVisible({ timeout: 15_000 });

      await page.goto("/app/inbox");
      const barra = await barraMostraLogoDe(
        page,
        "platform/",
        "barra lateral depois de remover o logo da empresa",
      );
      expect(barra.src, "a barra lateral não voltou para o logo da instalação").toContain(
        `${PREFIXO_PUBLICO}platform/`,
      );
      await page.screenshot({ path: evidencia("6-volta-ao-da-instalacao.png") });

      // Sem `limparCamada` aqui: o teto de trocas por usuário do produto — ver a
      // NOTA DO TETO no caso (1). (A camada de CIMA este caso removeu como AÇÃO
      // dele, não como limpeza — é o que ele mede.)
    } finally {
      await ctxInstalacao.close();
    }
  });

  test("(6) o dono remove o logo da instalação e a fachada volta ao que era", async ({
    page,
    browser,
  }) => {
    // ── A PRECONDIÇÃO DESTE CASO, MONTADA AQUI (issue #306) ──────────────────
    // "Volta ao que era" precisa dizer o que era, e o ANTES é medido por este
    // caso: a fachada como ela está agora (sem logo nenhum, ou com o
    // `APP_LOGO_URL` do `.env`, se houver). Antes, o que ele pressupunha era o
    // logo que o caso (1) tinha subido — e um estouro no (1) derrubava ESTE caso,
    // num PR que não toca marca.
    //
    // E o "agora" tem de ser medido com a instalação SEM logo PRÓPRIO: os casos
    // acima terminam com o logo DELES no ar (não limpam mais — ver a NOTA DO TETO
    // no caso (1)), e um `fachadaAntes` que já fosse o arquivo desta spec faria a
    // asserção final comparar o padrão do sistema com ele mesmo. Uma requisição
    // quando há logo para tirar; nenhuma quando não há.
    await entrarNaCamada(page, "instalacao");
    await removerLogoSeHouver(page, "/admin/marca", "instalacao");
    const fachadaAntes = await logoDoLogin(browser);
    await subirLogoDaCamada(page, "instalacao");

    // A subida chegou à fachada: sem esta medição, "voltou ao que era" ficaria
    // verde numa fachada que nunca mudou. É o mesmo elo que o caso (2) mede — e
    // aqui ele é precondição da asserção, não a asserção.
    const comLogo = await logoDoLogin(browser);
    expect(comLogo, "a fachada não mostrou o logo depois de o dono subi-lo").not.toBeNull();
    expect(comLogo!.src).toContain(`${PREFIXO_PUBLICO}platform/`);
    baixou(comLogo!, "tela de acesso depois de o dono subir o logo");

    // A remoção é a AÇÃO deste caso, não a restauração — quem garante a
    // restauração num estouro no meio é o `afterAll` abaixo.
    await page.goto("/admin/marca");
    const remover = page.locator("[data-campo-de-logo='instalacao']").getByRole("button", {
      name: /^remover$/i,
    });
    await expect(
      remover,
      "precondição: a instalação precisa entrar neste caso COM logo próprio — " +
        "quem o subiu foi este caso, dois passos acima",
    ).toBeVisible();
    await remover.click();
    await expect(page.getByText(/logo removido/i)).toBeVisible({ timeout: 15_000 });

    const noLogin = await logoDoLogin(browser);
    if (fachadaAntes === null) {
      // `null` (nenhuma imagem): o que NÃO pode sobrar é o arquivo desta spec.
      expect(
        noLogin === null || !noLogin.src.includes(PREFIXO_PUBLICO),
        "a fachada ficou com o logo do bucket depois de o dono removê-lo",
      ).toBe(true);
    } else {
      // Havia algo antes (o `APP_LOGO_URL` do `.env`, se houver): a fachada tem de
      // voltar EXATAMENTE àquele endereço.
      expect(
        noLogin?.src,
        `a fachada não voltou ao estado de partida — antes era ${fachadaAntes.src}`,
      ).toBe(fachadaAntes.src);
    }
  });

  test("(7) logo acima do teto é recortado e reduzido no navegador, e o que chega cabe", async ({
    page,
  }) => {
    // O caso da issue #1655, agora com o `<canvas>` DE VERDADE: as suítes de unidade
    // do PR #1671 trocam o motor por um codec PNG sintético, então `createImageBitmap`
    // e `toBlob` só rodam aqui. Camada da EMPRESA, com o `admin`: a conta dele fica
    // em 6 trocas (7 no pior caso) no teto de 10 — ver a NOTA DO TETO no caso (1).
    const original = pngDoDesigner();
    expect(original.length, "a precondição: o arquivo passa do teto ANTES do ajuste").toBeGreaterThan(
      TAMANHO_MAXIMO_DO_LOGO,
    );

    await entrarNaCamada(page, "organizacao");
    await page.goto(CAMADAS.organizacao.tela);
    const resposta = page.waitForResponse(
      (r) => r.url().includes("/api/v1/marca/logo") && r.request().method() === "POST",
      { timeout: 30_000 },
    );
    await subir(page, "organizacao", {
      nome: "logo-do-designer.png",
      mime: "image/png",
      bytes: original,
    });
    const post = await resposta;
    expect(post.status(), "o servidor recusou o que o navegador ajustou").toBe(200);
    await expect(page.getByText(/logo atualizado/i)).toBeVisible({ timeout: 15_000 });

    const { data } = (await post.json()) as { data: { logo_url: string } };
    const gravado = await page.request.get(data.logo_url);
    expect(gravado.ok(), `o arquivo gravado não baixou: ${data.logo_url}`).toBe(true);
    const bytes = await gravado.body();
    expect(bytes.length, "o que chegou ao bucket passa do teto").toBeLessThanOrEqual(
      TAMANHO_MAXIMO_DO_LOGO,
    );

    // O recorte se prova pela PROPORÇÃO: o arquivo inteiro é 3:2, a caixa útil
    // 704×286. A largura é uma das da escada que cabem abaixo da caixa (704, 640,
    // 512) — qual delas depende do encoder PNG do Chromium, e não é o que se mede.
    const png = lerPng(bytes);
    expect([704, 640, 512], `largura gravada ${png.largura}`).toContain(png.largura);
    expect(
      Math.abs(png.largura / png.altura - CAIXA_DO_DESIGNER.largura / CAIXA_DO_DESIGNER.altura),
      `${png.largura}×${png.altura} não tem a proporção da caixa útil — o recorte não aconteceu`,
    ).toBeLessThan(0.02);

    // PNG continua PNG COM transparência: o furo dentro do logo não virou fundo.
    const escala = png.largura / CAIXA_DO_DESIGNER.largura;
    const cx = Math.round((FURO_DO_DESIGNER.x + FURO_DO_DESIGNER.lado / 2) * escala);
    const cy = Math.round((FURO_DO_DESIGNER.y + FURO_DO_DESIGNER.lado / 2) * escala);
    expect(png.rgba[(cy * png.largura + cx) * 4 + 3], "o furo do logo perdeu a transparência").toBe(0);

    // Sem `limparCamada` aqui: o teto de trocas por usuário do produto — ver a
    // NOTA DO TETO no caso (1).
  });

  /**
   * A RESTAURAÇÃO — e ela é um `afterAll`, ao contrário do que este arquivo
   * afirmou.
   *
   * A versão anterior justificava fazer a limpeza num caso dizendo que "`afterAll`
   * não roda quando a spec estoura no meio". É o contrário do que o Playwright
   * faz. MEDIDO com o Playwright 1.62.1 deste repo, num `describe` serial de três
   * casos (A passa, B lança, C depois) mais um `afterAll` que registra a ordem:
   *
   *   MEDIDO ordem=["A","B","afterAll"]
   *   1 failed · 1 did not run · 1 passed
   *
   * O `afterAll` RODOU; o caso seguinte ao estouro NÃO. Ou seja a justificativa
   * escolhia o mecanismo estritamente pior justamente para o modo de falha que ela
   * nomeava: se o caso (3) estourasse depois de subir o logo da empresa, uma
   * limpeza escrita como caso seria pulada com os demais, e a marca ficaria de pé
   * para as specs seguintes do mesmo banco (as duas partes do job `e2e` rodam
   * contra o MESMO banco, sem reset — ver `.github/workflows/e2e.yml`).
   *
   * Limpa as DUAS camadas, e não só a da instalação: um estouro no meio deixa para
   * trás o logo da EMPRESA com a mesma facilidade.
   *
   * É a ÚNICA limpeza do arquivo desde a NOTA DO TETO DE TROCAS (caso 1): a
   * limpeza por caso somava com a subida do caso seguinte e batia no teto de 10
   * trocas/5min por usuário do próprio produto (medido: 429 no trace do run
   * 35095930532).
   *
   * Um login só, e do `dono`, porque ele é platform admin E `admin` da mesma
   * organização (`scripts/seed-e2e-credentials.ts:79-84`) — alcança `/admin/marca`
   * e `/app/settings/marca`.
   */
  test.afterAll(async ({ browser }) => {
    // O `test.setTimeout` do topo do `describe` vale para os CASOS; um hook nasce
    // com o timeout do config (30s). E aqui cabe um login com TOTP, que na
    // segunda tentativa espera a janela virar (até ~30s em `loginComTotp`) — sem
    // esta linha a restauração viraria vermelho por relógio, não por defeito.
    test.setTimeout(120_000);
    const contexto = await browser.newContext();
    try {
      const pagina = await contexto.newPage();
      await loginComTotp(pagina, creds.users.dono!.email, creds.dono_totp!.secret);
      await removerLogoSeHouver(pagina, "/app/settings/marca", "organizacao");
      await removerLogoSeHouver(pagina, "/admin/marca", "instalacao");
    } finally {
      await contexto.close();
    }
  });
});
