/**
 * O FUNIL ARQUIVADO TEM PORTA DE VOLTA — PELA TELA (issue #979).
 *
 * ─── O que só a tela responde ───────────────────────────────────────────────
 *
 * `tests/unit/funil-arquivado-caminho-de-volta.test.ts` prova a REGRA contra um
 * dublê de banco: `corpo()` separa as duas listas e o PATCH aceita `is_archived:
 * false` sozinho. Ele não renderiza uma linha de `app/app/kanban/_client.tsx` —
 * e a queixa que abriu a issue é sobre a TELA: *"tenho funis arquivados que não
 * consigo deletar"*. Uma rota que aceita o pedido e uma tela que não tem botão
 * para fazê-lo somam zero para quem usa.
 *
 * Quatro coisas, por isso, só aqui:
 *  · A gaveta NASCE FECHADA e é um clique — não uma lista a mais empurrando a
 *    lista de trabalho para baixo.
 *  · O arquivado aparece DENTRO dela e **não vaza** para a lista viva nem para o
 *    seletor de destino da importação. Este é o par de asserções que impede o
 *    conserto de virar regressão: vazamento de funil arquivado em seletor foi o
 *    que os PRs #941 e #944 tiraram de outras telas, e é o que voltaria se
 *    alguém "simplificasse" as duas listas numa só.
 *  · Tirar do arquivo devolve o funil à lista viva, e isso SOBREVIVE AO RELOAD —
 *    a promessa é sobre o que ficou no banco, não sobre o DOM que o clique
 *    acabou de escrever.
 *  · Arquivar pela tela põe o funil na gaveta na MESMA resposta, sem recarregar.
 *    `aplicarResposta` (_client.tsx) aplica as DUAS listas de uma vez de
 *    propósito; aplicar só `pipelines` deixaria a gaveta mostrando o estado
 *    anterior, e o clique seguinte levaria um 404. Nenhum teste de unidade vê
 *    isso, porque o defeito mora entre a resposta e o render.
 *
 * ─── Por que as fixtures são semeadas, e não criadas pela tela ──────────────
 *
 * O estado que a issue descreve é um funil que JÁ ESTAVA arquivado — de antes de
 * existir qualquer porta para ele. Semear `is_archived: true` direto reproduz
 * exatamente esse banco. Criar e arquivar pela tela mediria o caminho de ida,
 * que `pipelines-gestao.spec.ts` já cobre.
 *
 * Cada funil daqui é PRÓPRIO desta spec (prefixo `Arquivo E2E`, apagado no
 * `afterAll`): a tela de Funis lista todos os funis da organização, e o banco do
 * e2e é compartilhado — mexer nos funis dos vizinhos é configuração de
 * organização deixada para trás se a spec quebrar no meio. Mesmo padrão de
 * `lote-no-quadro-do-funil.spec.ts` e `motivos-de-perda-do-funil.spec.ts`.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/funil-arquivado-volta-pela-tela.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Locator, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA =
  process.env.E2E_EVIDENCIA_ARQUIVO ??
  path.join(process.cwd(), ".superpowers/evidence/funil-arquivado-volta");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;
const SUFIXO = `${Date.now()}`.slice(-7);
const PREFIXO = "Arquivo E2E";

/** Arquivado no seed — é ele que a gaveta tem de mostrar e devolver. */
const VOLTA = `${PREFIXO} ${SUFIXO} de volta`;
/** Vivo o tempo todo: o controle POSITIVO do seletor de destino. */
const VIVO = `${PREFIXO} ${SUFIXO} em uso`;
/** Nasce vivo, é arquivado pela tela e excluído de vez da gaveta. */
const DESCARTAVEL = `${PREFIXO} ${SUFIXO} descartavel`;
/** Arquivado e intocado: o que o `agent` não pode enxergar. */
const INVISIVEL = `${PREFIXO} ${SUFIXO} invisivel`;

/** nome do funil → id, preenchido pelo seed. A tela não expõe id ao usuário. */
const ids = new Map<string, string>();

function idDe(nome: string): string {
  const id = ids.get(nome);
  if (!id) throw new Error(`fixture «${nome}» não foi semeada`);
  return id;
}

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Navegação principal" });

/**
 * O caminho do leigo até a tela: o item do menu, não a URL digitada.
 *
 * Quem tem um funil arquivado não sabe que a tela dele mora em `/app/kanban` —
 * ele clica em "Funis". `navegacao.spec.ts` prende que a porta existe no grupo
 * certo; percorrê-la aqui é o que garante que a gaveta seja alcançável pelo
 * mesmo gesto, e não só por quem já sabe o endereço.
 */
async function irParaFunis(page: Page): Promise<void> {
  await sidebar(page).getByRole("link", { name: "Funis", exact: true }).click();
  await page.waitForURL(/\/app\/kanban/);
  await expect(page.getByRole("heading", { name: "Funis", level: 1 })).toBeVisible();
}

/** A linha do funil VIVO, pelo nome — o mesmo locator de `pipelines-gestao`. */
function linhaViva(page: Page, nome: string): Locator {
  return page.locator('li[data-testid^="funil-"]').filter({ hasText: nome });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/**
 * "Aparece" medido por FERRAMENTA, e não por presença no DOM.
 *
 * Um `<li>` dentro de um bloco recolhido continua existindo com altura zero, e
 * `toHaveCount(1)` sobre ele lê exatamente como "o usuário está vendo". A
 * medida vai para `medidas.json` junto da evidência: número que ninguém guarda
 * é número que ninguém confere depois.
 */
async function aparecerDeVerdade(alvo: Locator, contexto: string): Promise<void> {
  await alvo.scrollIntoViewIfNeeded();
  const m = await alvo.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      largura: r.width,
      altura: r.height,
      visibilidade: s.visibility,
      viewport: document.documentElement.clientWidth,
      direita: r.right,
    };
  });
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCIA, `medidas-${contexto.replace(/\W+/g, "-")}.json`),
    JSON.stringify(m, null, 2),
  );
  expect(m.altura, `${contexto}: altura ZERO — presente no DOM e invisível na tela`).toBeGreaterThan(
    0,
  );
  expect(m.largura, `${contexto}: largura ZERO`).toBeGreaterThan(0);
  expect(m.visibilidade, `${contexto}: visibility computado`).toBe("visible");
  // Elemento desenhado FORA da janela é tão inalcançável quanto um invisível —
  // e a lista de funis já teve estouro horizontal mascarado como "a página rola"
  // (commit eff0093ed).
  expect(m.direita, `${contexto}: desenhado fora da janela`).toBeLessThanOrEqual(m.viewport + 1);
}

/** Os nomes que o seletor de destino da importação oferece AGORA. */
async function destinosOferecidos(page: Page): Promise<string[]> {
  await page.getByTestId("abrir-importar-leads").click();
  const dialogo = page.getByRole("dialog", { name: "Importar leads de uma planilha" });
  await expect(dialogo).toBeVisible();
  await dialogo.getByLabel("Funil de destino").click();
  // ⚠️ ESPERAR A PRIMEIRA OPÇÃO ANTES DE LER. `allInnerTexts()` não espera nada:
  // chamado no instante do clique ele devolve `[]`, e lista vazia lê como "o
  // arquivado não está no seletor" — a sonda aprovaria o vazamento que ela
  // existe para achar.
  const opcoes = page.getByRole("option");
  await expect(opcoes.first()).toBeVisible();
  const nomes = await opcoes.allInnerTexts();
  await page.keyboard.press("Escape"); // fecha o seletor
  await page.keyboard.press("Escape"); // fecha o diálogo
  await expect(dialogo).toBeHidden();
  return nomes.map((n) => n.trim());
}

async function semear(nome: string, sufixoDoSlug: string, arquivado: boolean): Promise<void> {
  const { data, error } = await admin
    .from("crm_pipelines")
    .insert({
      organization_id: creds.org_id,
      name: nome,
      slug: `arq-e2e-${sufixoDoSlug}-${SUFIXO}`,
      is_archived: arquivado,
    })
    .select("id")
    .single();
  if (error) throw new Error(`fixture «${nome}»: ${error.message}`);
  ids.set(nome, (data as { id: string }).id);
}

async function limparFixtures(): Promise<void> {
  const { data } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("name", `${PREFIXO} %`);
  const alvos = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (alvos.length === 0) return;
  // Na ordem das FKs: atividade → negócio → etapa → funil. As fixtures nascem
  // sem nada disso, mas uma rodada interrompida no meio pode ter deixado.
  await admin.from("crm_lead_activities").delete().in("pipeline_id", alvos);
  await admin.from("crm_leads").delete().in("pipeline_id", alvos);
  await admin.from("crm_stages").delete().in("pipeline_id", alvos);
  await admin.from("crm_pipelines").delete().in("id", alvos);
}

// O seed de credenciais e os quatro inserts cabem folgado, mas o login espera
// redirecionamento com teto de 60s e o teto global do playwright.config.ts é de
// 30s. Mesma subida de `motivos-de-perda-do-funil` e `lote-no-quadro-do-funil`.
test.describe.configure({ timeout: 240_000 });

test.beforeAll(async () => {
  // A parte 4 do CI NÃO roda o passo "Semear credenciais de teste" (ele é
  // `if: matrix.parte != 4`): lá o job cria só o dono do `bootstrap-owner.ts`.
  // Semear aqui é o que torna esta spec independente do job — o mesmo que
  // `pipelines-gestao` e `motivos-de-perda-do-funil` já fazem.
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!creds.users?.manager || !creds.users?.agent) {
    // Arquivo de uma versão antiga do seed: reescreve em vez de morrer num
    // `undefined` três linhas adiante, que não diz o que fazer.
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  await limparFixtures();

  await semear(VIVO, "vivo", false);
  await semear(DESCARTAVEL, "desc", false);
  await semear(VOLTA, "volta", true);
  await semear(INVISIVEL, "invis", true);
});

test.afterAll(async () => {
  await limparFixtures();
});

test("a gaveta nasce fechada, mostra o arquivado que não vaza para os vivos, e o devolve à lista", async ({
  page,
}) => {
  await login(page, creds.users.manager!.email, creds.password);
  await irParaFunis(page);

  // ── 1. O ARQUIVADO NÃO ESTÁ NA LISTA DE TRABALHO ───────────────────────────
  // A gaveta existe para dar caminho de volta, não para trazer o passado de
  // volta à lista: quem abre esta tela escolhe onde pôr negócio novo, e um funil
  // que não recebe mais nada no meio da lista é escolha errada esperando
  // acontecer.
  await expect(linhaViva(page, VOLTA)).toHaveCount(0);
  // Controle positivo: o funil VIVO está lá. Sem ele, o zero acima também
  // passaria com a lista inteira vazia — isto é, com a tela quebrada.
  await expect(linhaViva(page, VIVO)).toBeVisible();

  // ── 2. NEM NO SELETOR DE DESTINO ───────────────────────────────────────────
  // É o vazamento que os PRs #941 e #944 consertaram em outras telas: funil
  // arquivado num seletor é destino que não existe mais, e quem o escolhe manda
  // a planilha inteira para um quadro que ninguém abre.
  const destinos = await destinosOferecidos(page);
  expect(destinos, "o seletor não abriu — a asserção seguinte seria vácuo").not.toHaveLength(0);
  expect(destinos, "funil arquivado oferecido como destino de importação").not.toContain(VOLTA);
  expect(destinos, "o seletor precisa oferecer os vivos — senão o teste acima mede nada").toContain(
    VIVO,
  );

  // ── 3. A GAVETA NASCE FECHADA ──────────────────────────────────────────────
  // Fechada, e não ausente: arquivo aberto por padrão empurra a lista de
  // trabalho para baixo por um gesto que se faz uma vez por ano.
  const abrir = page.getByTestId("arquivados-abrir");
  await expect(abrir).toBeVisible();
  await aparecerDeVerdade(abrir, "botao da gaveta fechada");
  // `aria-expanded` é a verdade acessível do estado: sem ele, leitor de tela
  // anuncia um botão que não diz se abre ou fecha.
  await expect(abrir).toHaveAttribute("aria-expanded", "false");
  // Fechada de verdade = o conteúdo não está no DOM, não "está e é invisível".
  await expect(page.getByTestId("arquivados-explicacao")).toHaveCount(0);
  await expect(page.getByTestId(`arquivado-${idDe(VOLTA)}`)).toHaveCount(0);
  // O CONTADOR no rótulo, e não só o rótulo: fechada, a gaveta é a única pista
  // de que existe algo lá dentro. "Funis arquivados" sem número não distingue
  // "não tenho nenhum" de "tenho sete" — e é a segunda situação que manda abrir.
  await expect(abrir).toContainText(/Funis arquivados \(\s*[1-9]\d*\s*\)/);
  await captura(page, "01-gaveta-fechada");

  // ── 4. ABRIR MOSTRA O FUNIL ARQUIVADO ──────────────────────────────────────
  await abrir.click();
  await expect(abrir).toHaveAttribute("aria-expanded", "true");
  const linhaArquivada = page.getByTestId(`arquivado-${idDe(VOLTA)}`);
  await expect(linhaArquivada).toBeVisible();
  await aparecerDeVerdade(linhaArquivada, "linha do funil arquivado");
  await expect(linhaArquivada).toContainText(VOLTA);
  // A explicação é o que impede a gaveta de ser um depósito mudo: ela diz que o
  // arquivado não recebe negócio e quais são as duas saídas.
  await expect(page.getByTestId("arquivados-explicacao")).toBeVisible();
  await captura(page, "02-gaveta-aberta");

  // ── 5. TIRAR DO ARQUIVO DEVOLVE O FUNIL À LISTA ────────────────────────────
  await page.getByTestId(`desarquivar-${idDe(VOLTA)}`).click();
  // Some da gaveta na mesma resposta: se continuasse aqui, o clique seguinte
  // pediria ao servidor algo que já não é verdade.
  await expect(page.getByTestId(`arquivado-${idDe(VOLTA)}`)).toHaveCount(0);
  const devolvido = page.getByTestId(`funil-${idDe(VOLTA)}`);
  await expect(devolvido).toBeVisible();
  await aparecerDeVerdade(devolvido, "funil devolvido a lista viva");
  await captura(page, "03-devolvido");

  // ── 6. E SOBREVIVE AO RELOAD ───────────────────────────────────────────────
  // A promessa do recurso é sobre o banco, não sobre o DOM que o clique acabou
  // de escrever — e esta tela aplica o corpo da resposta ao estado local de
  // propósito, então só o reload prova que o servidor concordou.
  await page.reload();
  await expect(page.getByTestId(`funil-${idDe(VOLTA)}`)).toBeVisible();
  // E ele volta a ser destino válido: desarquivar que não devolve o funil aos
  // seletores devolveria pela metade.
  expect(
    await destinosOferecidos(page),
    "funil tirado do arquivo tem de voltar a ser destino de importação",
  ).toContain(VOLTA);
});

test("arquivar pela tela cai na gaveta na mesma hora, e de lá o funil se exclui de vez", async ({
  page,
}) => {
  await login(page, creds.users.manager!.email, creds.password);
  await irParaFunis(page);

  const alvo = idDe(DESCARTAVEL);
  await expect(linhaViva(page, DESCARTAVEL)).toBeVisible();

  // ── 1. ARQUIVAR ────────────────────────────────────────────────────────────
  await page.getByTestId(`arquivar-${alvo}`).click();
  await expect(page.getByTestId(`arquivar-painel-${alvo}`)).toBeVisible();
  await page.getByTestId(`arquivar-confirmar-${alvo}`).click();
  await expect(linhaViva(page, DESCARTAVEL)).toHaveCount(0);

  // ── 2. A GAVETA JÁ SABE, SEM RECARREGAR ────────────────────────────────────
  // As duas listas vêm da MESMA resposta e são aplicadas juntas. Aplicar só a
  // dos vivos deixaria a gaveta com o estado anterior — o funil recém-arquivado
  // não apareceria aqui até alguém recarregar, e quem arquivou por engano
  // concluiria que perdeu o funil de novo. Nenhum teste de unidade alcança este
  // ponto: o defeito mora entre a resposta e o render.
  const abrir = page.getByTestId("arquivados-abrir");
  // Arquivar NÃO escancara a gaveta na cara de quem acabou de arquivar.
  await expect(abrir).toHaveAttribute("aria-expanded", "false");
  await abrir.click();
  const linhaArquivada = page.getByTestId(`arquivado-${alvo}`);
  await expect(linhaArquivada).toBeVisible();
  await aparecerDeVerdade(linhaArquivada, "recem-arquivado na gaveta");
  await captura(page, "04-recem-arquivado-na-gaveta");

  // ── 3. EXCLUIR DE VEZ PERGUNTA ANTES ───────────────────────────────────────
  await page.getByTestId(`excluir-arquivado-${alvo}`).click();
  const painel = page.getByTestId(`excluir-painel-${alvo}`);
  await expect(painel).toBeVisible();
  // Ação sem volta que não avisa é armadilha: o painel tem de dizer o que
  // acontece, não só oferecer um botão vermelho.
  await expect(painel).toContainText(/não tem volta/i);
  await captura(page, "05-confirmar-exclusao");

  await page.getByTestId(`excluir-confirmar-${alvo}`).click();
  await expect(page.getByTestId(`arquivado-${alvo}`)).toHaveCount(0);
  // Nem volta para os vivos pelo caminho oposto — "sumiu da gaveta" sozinho
  // também seria verdade se a exclusão apenas o desarquivasse.
  await expect(linhaViva(page, DESCARTAVEL)).toHaveCount(0);

  // ── 4. A PROVA É NO BANCO ──────────────────────────────────────────────────
  // A tela não consegue provar AUSÊNCIA de linha: some da tela é o que já
  // acontecia com o arquivado invisível que esta issue veio consertar.
  const { data } = await admin.from("crm_pipelines").select("id").eq("id", alvo).maybeSingle();
  expect(data, "o funil continua no banco — a tela mentiu sobre a exclusão").toBeNull();
});

/**
 * O MESMO BANCO, OUTRO PAPEL — e é o contraste que prova o recorte.
 *
 * O funil `INVISIVEL` continua arquivado enquanto este caso roda: os dois casos
 * acima nunca o tocam. Então o que muda daqui para lá é SÓ quem está logado, e
 * um zero medido aqui não pode ser confundido com "não havia nada arquivado".
 */
test("quem não gerencia não vê a gaveta nem o nome do funil arquivado", async ({ page }) => {
  // Tirar do arquivo e excluir são `requireRole("manager")` nas rotas. Mostrar a
  // gaveta a quem receberia 403 seria prometer o que não se cumpre — e a lista
  // de arquivados nem sai do servidor para o `agent` (`page.tsx`), então o nome
  // do funil arquivado não pode aparecer em lugar nenhum da página.
  await login(page, creds.users.agent!.email, creds.password);
  await irParaFunis(page);

  // Controle positivo PRIMEIRO: a tela carregou e o `agent` vê os funis vivos.
  // Sem isto, os três zeros abaixo passariam numa página em branco.
  await expect(linhaViva(page, VIVO)).toBeVisible();

  await expect(page.getByTestId("arquivados")).toHaveCount(0);
  await expect(page.getByTestId("arquivados-abrir")).toHaveCount(0);
  await expect(page.getByTestId(`arquivado-${idDe(INVISIVEL)}`)).toHaveCount(0);
  // O nome, em qualquer canto da página: a gaveta pode sumir e o dado vazar por
  // outro caminho — foi assim que a lista de duas organizações apareceu
  // misturada nesta mesma tela antes do filtro por `organization_id`.
  await expect(page.getByText(INVISIVEL, { exact: true })).toHaveCount(0);
  await captura(page, "06-agent-sem-gaveta");
});
