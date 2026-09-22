import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect as expectBase, test, type Page } from "@playwright/test";

import { criarAtoresDasExtensoes, type AtoresDasExtensoes } from "./fixtures/catalogo-extensoes";

/**
 * A JORNADA QUE A ADR-0003 TORNOU POSSÍVEL, PROVADA PELA TELA.
 *
 * Antes desta entrega, uma extensão instalada só conseguia abrir UMA tela: Tarefas. Todo
 * pacote era o mesmo pacote com outro texto, e a frase "Abre Tarefas" era exibida para
 * qualquer um deles — inclusive, depois da ampliação, para os que não abrem Tarefas.
 *
 * Esta prova dirige o navegador como um usuário faria e responde três perguntas que nenhum
 * teste de unidade responde:
 *
 *   1. A pessoa que vai instalar consegue VER, antes de decidir, quais telas a extensão abre?
 *   2. O botão do cartão leva mesmo para a tela certa — Conversas, e não Tarefas?
 *   3. Duas portas diferentes no mesmo pacote levam a lugares diferentes?
 *
 * O prazo maior nas asserções segue o motivo já registrado na spec irmã: quase toda asserção
 * aqui espera DUAS idas ao servidor (a mutação e a recarga que a tela faz antes de anunciar).
 */
const expect = expectBase.configure({ timeout: 20_000 });
const EVIDENCE = "evidence/extensoes-portas-novas";
const execFileAsync = promisify(execFile);
const CLI = path.join(process.cwd(), "experiments", "extensoes", "catalog", "catalog.py");

test.use({ trace: "on" });
test.describe.configure({ mode: "serial" });

/**
 * TETO DO CASO, declarado — as três specs irmãs declaram o delas (120 s a 480 s) e esta não
 * declarava nada, ficando com o padrão de 30 s do Playwright.
 *
 * Medido: o caso rodou 30,5 s e estourou DENTRO da navegação final, depois de admitir o
 * catálogo, instalar, ativar, salvar, abrir o hub e abrir o guia. Não é lentidão do produto:
 * é uma jornada de ponta a ponta que não cabe em 30 s nem numa máquina descansada.
 *
 * O valor vem da irmã de escopo equivalente (`extensoes-declarativas`, que também admite,
 * instala e configura), em vez de um número escolhido por mim — um teto inventado ou vira
 * apertado demais na primeira máquina cheia, ou esconde lentidão de verdade.
 *
 * NÃO MEDIDO: se a navegação final leva menos de um segundo com folga. O orçamento acabou
 * durante ela, então ela não chegou a ser medida — só sei que o clique aconteceu.
 */
test.setTimeout(300_000);

let atores: AtoresDasExtensoes | undefined;
let bancada: Bancada | undefined;

interface Bancada {
  origem: string;
  arquivoDoCatalogo: string;
  publisher: string;
  name: string;
  version: string;
  parar(): Promise<void>;
}

async function cli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("python3", [CLI, ...args], { encoding: "utf8" });
  return stdout.trim();
}

/**
 * Publica um pacote com DUAS portas novas. O `make-example` da bancada gera o pacote no
 * formato vigente; aqui ele é reescrito para pedir Conversas e Funil — que é exatamente o
 * que era impossível antes desta entrega.
 */
async function montarBancada(): Promise<Bancada> {
  const dir = await mkdtemp(path.join(tmpdir(), "portas-novas-"));
  const banco = path.join(dir, "catalog.sqlite");
  const manifesto = path.join(dir, "pacote.json");
  // A ORIGEM NÃO PODE SER INVENTADA — e foi assim que esta spec reprovou no primeiro
  // veredito em tela. Eu calculava uma porta a partir do PID, e o produto RECUSOU baixar
  // dali, corretamente: `isAllowedLocalOrigin` (lib/extensions/download.ts:59-66) só admite
  // a origem que é EXATAMENTE igual a `EXTENSIONS_LOCAL_CATALOG_ORIGIN`. O sintoma foi o
  // cartão nunca aparecer no catálogo, e as três specs irmãs passando ao lado.
  //
  // Ou seja: o vermelho mediu a guarda de origem funcionando em ambiente real, e o defeito
  // era meu. Lê-se do ambiente, em vez de repetir o literal, para acompanhar quando a porta
  // canônica mudar. Com `workers: 1` no playwright.config, os arquivos rodam em sequência e
  // não há disputa por esta porta.
  const origem = process.env.EXTENSIONS_LOCAL_CATALOG_ORIGIN;
  if (!origem) {
    throw new Error(
      "EXTENSIONS_LOCAL_CATALOG_ORIGIN ausente: o runner E2E não publicou o ambiente canônico.",
    );
  }
  const porta = Number(new URL(origem).port);

  await cli(["init", "--db", banco, "--origin", origem]);
  await cli(["make-example", "--output", manifesto]);

  const sufixo = randomUUID().replaceAll("-", "").slice(0, 8);
  const base = JSON.parse(await readFile(manifesto, "utf8")) as Record<string, unknown>;
  base.publisher = `porta-nova-${sufixo}`;
  base.name = "duas-portas";
  base.permissions = ["navigation.inbox", "navigation.kanban"];
  const display = base.display as Record<string, unknown>;
  display.title = { "pt-BR": "Duas portas", es: "Dos puertas" };
  display.summary = {
    "pt-BR": "Um roteiro que leva às Conversas e ao Funil, sem passar por Tarefas.",
    es: "Una rutina que lleva a Conversaciones y al Embudo.",
  };
  const contribuicoes = base.contributions as { crm_cards: Record<string, unknown>[] };
  const modelo = contribuicoes.crm_cards[0]!;
  contribuicoes.crm_cards = [
    {
      ...modelo,
      id: "falar-com-quem-espera",
      title: { "pt-BR": "Falar com quem está esperando", es: "Hablar con quien espera" },
      action: { label: { "pt-BR": "Abrir Conversas" }, capability: "inbox.open" },
    },
    {
      ...modelo,
      id: "mover-o-que-parou",
      title: { "pt-BR": "Mover o que parou", es: "Mover lo detenido" },
      action: { label: { "pt-BR": "Abrir o Funil" }, capability: "kanban.open" },
    },
  ];
  await writeFile(manifesto, JSON.stringify(base));

  await cli(["publish", "--db", banco, "--manifest", manifesto]);

  // A REVISÃO PRECISA SUCEDER A QUE JÁ FOI ADMITIDA — e foi isto, e não a origem, que
  // deixou a jornada vermelha nas duas primeiras rodadas.
  //
  // As três specs irmãs rodam ANTES desta, na mesma parte do CI e na MESMA origem, e cada
  // uma admite um catálogo. O host recusa revisão menor ou igual à vigente
  // (`fn_extensions_admit_catalog`), então um catálogo exportado sempre como revisão 1 era
  // recusado na admissão — e o sintoma é idêntico ao da origem errada: o cartão nunca
  // aparece. Dois defeitos diferentes no mesmo caminho, com a mesma cara; consertar o
  // primeiro não moveu o resultado, e foi isso que me fez procurar o segundo em vez de
  // repetir a rodada esperando sorte.
  //
  // Mesmo tratamento da fixture irmã: lê a revisão vigente e exporta até superá-la.
  const { data: admitido } = await atores!.db
    .from("extension_catalogs")
    .select("revision")
    .eq("origin", origem)
    .maybeSingle();
  const revisaoVigente = (admitido?.revision as number | undefined) ?? 0;
  // UM ARQUIVO POR PASSADA. O `export` do catálogo de ensaio não sobrescreve — ele recusa com
  // "o arquivo de admissão já existe" e não tem flag para forçar (conferido em `export --help`).
  // A fixture irmã já fazia assim; eu tinha copiado o laço e não o nome do arquivo.
  let arquivoDoCatalogo = "";
  for (let revisao = 1; revisao <= revisaoVigente + 1; revisao += 1) {
    arquivoDoCatalogo = path.join(dir, `catalogo-revisao-${revisao}.json`);
    await cli(["export", "--db", banco, "--output", arquivoDoCatalogo]);
  }
  const exportado = JSON.parse(await readFile(arquivoDoCatalogo, "utf8")) as { revision: number };
  if (exportado.revision !== revisaoVigente + 1) {
    throw new Error(
      `A revisão exportada (${exportado.revision}) não sucede a admitida (${revisaoVigente}). ` +
        `Sem isto a admissão é recusada e o cartão nunca aparece.`,
    );
  }

  const servidor = execFile("python3", [CLI, "serve", "--db", banco, "--port", String(porta)]);

  // Espera o servidor aceitar conexão em vez de dormir um tempo fixo: sob carga, o fixo ora
  // sobra ora falta, e o teste vira medida da máquina.
  //
  // O `else` no fim não é zelo: a primeira versão deste laço ESGOTAVA EM SILÊNCIO. Se o
  // servidor não subisse, ele saía como se tivesse subido, e a falha aparecia oito linhas
  // adiante — na admissão do catálogo — com uma mensagem sobre download, que manda investigar
  // a feature quando o defeito é da bancada. Laço de espera que desiste calado transforma
  // "o ambiente não subiu" em "a funcionalidade quebrou", e são coisas diferentes.
  //
  // A folga também é deliberada: ~45 s no pior caso. Sob carga, lento é o ESPERADO — um teste
  // correto fica lento e passa; prazo sem folga para a variância real fica lento e QUEBRA,
  // e aí o vermelho mede a máquina, não o código.
  const PRAZO_DO_SERVIDOR = 60;
  let noAr = false;
  for (let i = 0; i < PRAZO_DO_SERVIDOR && !noAr; i += 1) {
    try {
      const r = await fetch(`${origem}/`, { signal: AbortSignal.timeout(500) });
      if (r.status > 0) noAr = true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!noAr) {
    servidor.kill("SIGTERM");
    throw new Error(
      `A bancada do catálogo não atendeu em ${origem} após ${PRAZO_DO_SERVIDOR} tentativas. ` +
        `Isto é falha de AMBIENTE, não da extensão: nada foi exercitado.`,
    );
  }

  return {
    origem,
    arquivoDoCatalogo,
    publisher: base.publisher as string,
    name: "duas-portas",
    version: base.version as string,
    parar: async () => {
      servidor.kill("SIGTERM");
      await rm(dir, { recursive: true, force: true });
    },
  };
}


/** O id da instalação nasce no servidor; a tela o usa nos `data-testid`. */
async function esperarInstalacao(publisher: string, name: string): Promise<string> {
  for (let i = 0; i < 60; i += 1) {
    const { data } = await atores!.db
      .from("extension_installations")
      .select("id")
      .eq("publisher", publisher)
      .eq("name", name)
      .is("removed_at", null)
      .maybeSingle();
    if (data?.id) return data.id as string;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`instalação de ${publisher}/${name} não apareceu no banco`);
}

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

test.beforeAll(async () => {
  await mkdir(EVIDENCE, { recursive: true });
  atores = await criarAtoresDasExtensoes();
  bancada = await montarBancada();
});

test.afterAll(async () => {
  await bancada?.parar();
  await atores?.limpar();
});

test("uma extensão de duas portas: a tela diz quais são, e cada botão leva à sua", async ({
  page,
}) => {
  const a = atores!;
  const b = bancada!;

  await login(page, a.usuarios.owner.email, a.senha);
  await page.goto("/app/extensions");

  // ── 1. Admitir o catálogo ────────────────────────────────────────────────
  // Caminho COPIADO da spec irmã, passo a passo, depois de quatro rodadas vermelhas.
  // Cada `expect` daqui é um passo confirmado antes do seguinte — é o que transforma
  // "o cartão não apareceu" em "a admissão não confirmou", que são investigações diferentes.
  await expect(page.getByTestId("extension-catalog-admission")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("extension-catalog-file").setInputFiles(b.arquivoDoCatalogo);
  await expect(page.getByTestId("extension-catalog-submit")).toBeVisible();
  await page.getByTestId("extension-catalog-submit").click();

  // A confirmação da ADMISSÃO, antes de procurar qualquer cartão. Sem ela, uma recusa vira
  // "cartão ausente" vinte segundos depois, longe da causa.
  await expect(page.getByText("Catálogo admitido e disponível para instalação.")).toBeVisible();

  // A ABA. Esta linha é a quarta causa das quatro rodadas vermelhas: os cartões do catálogo
  // vivem numa aba que não é a inicial, e eu procurava o cartão com ela fechada. O elemento
  // existia; a tela é que não o estava mostrando. A irmã já clicava aqui — mais um detalhe
  // que teria vindo de graça se eu tivesse partido dela em vez de escrever do zero.
  await page.getByRole("tab", { name: "Catálogo" }).click();

  const cartao = page.getByTestId(`extension-catalog-${b.publisher}-${b.name}-${b.version}`);

  // Diagnóstico antes da asserção. "Cartão não encontrado em 20 s" foi o MESMO sintoma de três
  // causas diferentes nesta spec, e cada volta custou 20 minutos de fila para descobrir qual.
  // Daqui em diante a falha traz o que a tela diz: o aviso, os cartões presentes e o bloco de
  // admissão. O próximo vermelho nasce com a causa em vez de com um tempo esgotado.
  try {
    await expect(cartao).toBeVisible({ timeout: 30_000 });
  } catch (erro) {
    const aviso = (await page.getByRole("alert").allInnerTexts()).join(" | ").trim();
    const listados = await page
      .locator('[data-testid^="extension-catalog-"]')
      .evaluateAll((nos) => nos.map((n) => n.getAttribute("data-testid")).filter(Boolean) as string[]);
    await page.screenshot({ path: `${EVIDENCE}/0-cartao-ausente.png`, fullPage: true });
    throw new Error(
      `O cartão de ${b.publisher}/${b.name}@${b.version} não apareceu.\n` +
        `Aviso na tela: ${aviso || "(nenhum)"}\n` +
        `Cartões presentes: ${listados.length > 0 ? listados.join(", ") : "(nenhum)"}\n` +
        `Catálogo enviado: ${b.arquivoDoCatalogo}\n` +
        `Causa original: ${(erro as Error).message}`,
    );
  }

  // ── 2. A pergunta que importa: a tela diz o que a extensão abre? ──────────
  // Antes desta entrega, este texto era fixo: "Abre Tarefas" aparecia para TODO pacote.
  await expect(cartao).toContainText("Conversas");
  await expect(cartao).toContainText("Funil");
  await expect(cartao).not.toContainText("Abre Tarefas");
  await page.screenshot({ path: `${EVIDENCE}/1-vitrine-diz-as-portas.png`, fullPage: true });

  // ── 3. Instalar ──────────────────────────────────────────────────────────
  const identidade = `${b.publisher}-${b.name}-${b.version}`;
  await page.getByTestId(`extension-install-${identidade}`).click();
  // Quando há confirmação (troca/reinstalação), ela aparece; numa instalação nova, não.
  const confirmar = page.getByTestId(`extension-install-confirm-${identidade}`);
  if (await confirmar.isVisible().catch(() => false)) await confirmar.click();

  // O id da instalação é UUID, então ele vem do banco — a tela o usa nos data-testid.
  const instalacaoId = await esperarInstalacao(b.publisher, b.name);

  // DE VOLTA PARA A ABA "INSTALADAS". Esta é a quinta causa: para instalar eu precisei ir à aba
  // "Catálogo", e o cartão de gestão da extensão instalada vive na OUTRA aba. A instalação já
  // existia no banco — `esperarInstalacao` devolveu o id — e mesmo assim o cartão "não aparecia",
  // porque eu continuava olhando a aba errada. Mesmo modo de falha da quarta causa, um passo
  // adiante: elemento presente, aba fechada.
  await page.getByRole("tab", { name: "Instaladas" }).click();

  const instalada = page.getByTestId(`extension-installed-${instalacaoId}`);
  await expect(instalada).toBeVisible({ timeout: 30_000 });
  // A irmã rola até o cartão antes de mexer nos controles dele: a lista cresce com o número de
  // extensões, e um clique em elemento fora da viewport falha por motivo que não é o do teste.
  await instalada.scrollIntoViewIfNeeded();
  // A lista de portas também aparece DEPOIS de instalada, no cartão de gestão.
  await expect(instalada).toContainText("Conversas");
  await expect(instalada).toContainText("Funil");

  // ── 4. Ativar na organização ─────────────────────────────────────────────
  // LIGAR NÃO É SALVAR. Esta é a sexta causa: eu clicava no interruptor e seguia em frente,
  // e a ativação nunca era persistida — por isso o card não chegava ao hub, mesmo com tudo
  // instalado. O interruptor muda o estado da TELA; quem grava é o botão de salvar, e a
  // confirmação é a frase. A irmã já fazia os três passos.
  await page.getByTestId(`extension-enabled-${instalacaoId}`).click();
  await expect(page.getByTestId(`extension-enabled-${instalacaoId}`)).toHaveAttribute(
    "data-state",
    "checked",
  );
  await page.getByTestId(`extension-save-${instalacaoId}`).click();
  await expect(page.getByText("Configuração salva.", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/2-instalada-e-ativa.png`, fullPage: true });

  // ── 5. O guia, e a primeira porta ────────────────────────────────────────
  // O card no hub tem identificador próprio — buscar pelo TEXTO do manifesto é frágil por
  // dois motivos: o texto é do pacote (muda com ele) e pode casar com outro lugar da página.
  await page.goto("/app/crm");
  const cardHub = page.getByTestId(`extension-contribution-${instalacaoId}-falar-com-quem-espera`);
  await expect(cardHub).toBeVisible({ timeout: 30_000 });
  await expect(cardHub).toContainText("Falar com quem está esperando");
  await cardHub.click();
  await page.waitForURL(/\/app\/extensions\//, { timeout: 30_000 });
  // A irmã confirma o guia montado antes de usar os botões dele — sem isso, o clique pode cair
  // num guia ainda carregando e falhar por motivo que não é o do teste.
  await expect(page.getByTestId("extension-guide")).toBeVisible({ timeout: 30_000 });
  const urlDoGuia = page.url();
  await page.screenshot({ path: `${EVIDENCE}/3-guia-aberto.png`, fullPage: true });

  await page.getByTestId("extension-open-falar-com-quem-espera").click();
  // A PROVA: vai para Conversas, não para Tarefas.
  await page.waitForURL(/\/app\/inbox/, { timeout: 30_000 });
  await page.screenshot({ path: `${EVIDENCE}/4-abriu-conversas.png`, fullPage: true });

  // ── 6. A segunda porta leva a outro lugar ────────────────────────────────
  // Volta pela URL guardada, e não por `goBack()`: a navegação anterior foi feita pelo roteador
  // do app, e o histórico do navegador pode levar ao hub em vez do guia. Endereço explícito é
  // determinístico; voltar é uma aposta sobre o que o histórico guardou.
  await page.goto(urlDoGuia);
  await expect(page.getByTestId("extension-guide")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("extension-open-mover-o-que-parou").click();
  await page.waitForURL(/\/app\/kanban/, { timeout: 30_000 });
  await page.screenshot({ path: `${EVIDENCE}/5-abriu-o-funil.png`, fullPage: true });
});
