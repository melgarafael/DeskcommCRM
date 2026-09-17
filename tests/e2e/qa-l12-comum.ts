/** Helpers da sessão de QA do lote 12 — não faz parte da suíte do CI. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

export const EVIDENCIA = path.join(process.cwd(), "evidence/triagem-16set-l12");
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

export interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
export const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * INSERT de fixture com reenvio — contra a INFRA, nunca contra o produto.
 *
 * Medido nesta máquina: o PostgREST deste stack perde a conexão com o Postgres
 * sob carga e responde 503 `PGRST002` ("Could not query the database for the
 * schema cache. Retrying.") por ~5 s enquanto recarrega o cache. Um `insert` de
 * FIXTURE que morre aí derruba o `beforeAll` e a sessão passa a medir o vizinho.
 * Nenhuma ASSERÇÃO do lote passa por aqui — só o preparo.
 */
export async function insere(
  tabela: string,
  valores: Record<string, unknown>,
): Promise<string> {
  let ultimo = "";
  for (let i = 1; i <= 6; i++) {
    const { data, error } = await admin.from(tabela).insert(valores).select("id").single();
    if (!error) return (data as { id: string }).id;
    ultimo = error.message;
    const transitorio =
      /schema cache|upstream server|connection|timeout|503|Retrying/i.test(error.message);
    if (!transitorio) throw new Error(`${tabela}: ${error.message}`);
    registra(`[ambiente] insert em ${tabela}: tentativa ${i} caiu (${error.message})`);
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`${tabela}: 6 tentativas e a infra não respondeu — ${ultimo}`);
}

export function creds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

export async function login(page: Page, email: string, senha: string): Promise<void> {
  // Já logado como esta pessoa? Não gaste outro login — o teto por IP existe.
  await page.goto("/app/inbox").catch(() => {});
  if (/\/app(\/|$|\?)/.test(page.url())) return;

  /**
   * O login é repetido até 4 vezes DE PROPÓSITO, e isso não relaxa asserção
   * nenhuma — nenhuma medição do lote passa por aqui.
   *
   * Nesta máquina (load 80-120, 33 contêineres de outras sessões) o GoTrue
   * perde a resolução de nome do Postgres por alguns segundos e devolve
   * `auth.login_failed`; medido no log do servidor às 19:12:47 junto com
   * "Could not query the database for the schema cache. Retrying.". Um login
   * que falha por isso e derruba o teste faz a sessão medir o VIZINHO em vez
   * do lote — que é o modo de falha que esta rodada precisa evitar.
   */
  let ultimo = "";
  for (let i = 1; i <= 4; i++) {
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(senha);
    await page.getByRole("button", { name: /entrar/i }).click();
    try {
      await page.waitForURL(/\/app/, { timeout: 45_000 });
      if (i > 1) registra(`[ambiente] login de ${email} só entrou na tentativa ${i}`);
      return;
    } catch (err) {
      ultimo = err instanceof Error ? err.message : String(err);
      registra(`[ambiente] login de ${email}: tentativa ${i} falhou (${page.url()})`);
      // Parar no segundo fator não é lentidão: insistir aqui só gasta minutos.
      if (page.url().includes("/login/mfa")) {
        throw new Error(`${email} pede segundo fator — use outro papel nesta medição`);
      }
      await page.waitForTimeout(5_000);
    }
  }
  throw new Error(`login de ${email} falhou em 4 tentativas: ${ultimo}`);
}

export async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/**
 * Abre uma conversa como quem clica nela.
 *
 * `/app/inbox/<id>` REDIRECIONA para `/app/inbox?id=<id>`; `?c=<id>` não abre
 * nada — a tela fica em "Selecione uma conversa" e toda medição do painel mede
 * o vazio. Esperar a URL final é determinístico e não relaxa asserção nenhuma.
 */
export async function abreConversa(page: Page, conversaId: string): Promise<void> {
  await page.goto(`/app/inbox/${conversaId}`);
  await page.waitForURL(new RegExp(`/app/inbox\\?id=${conversaId}`), { timeout: 90_000 });
}

/**
 * Abre o quadro de um funil e insiste enquanto a MÁQUINA (não o produto) falhar.
 *
 * O cliente do quadro tem um teto de 10s na requisição e desenha
 * "Não consegui carregar este funil: A requisição não respondeu em 10000ms."
 * Numa máquina com load 80 isso acontece sem que nada esteja quebrado — e é a
 * diferença entre medir o lote e medir o vizinho. Recarregar é o que um humano
 * faria; se depois de 6 tentativas continuar, aí sim é achado.
 */
export async function abreQuadro(page: Page, pipelineId: string, titulo: string): Promise<void> {
  for (let i = 1; i <= 6; i++) {
    await page.goto(`/app/pipelines/${pipelineId}`);
    const card = page.getByRole("group", { name: `Lead: ${titulo}` });
    const erro = page.getByText(/Não consegui carregar este funil/);
    const vencedor = await Promise.race([
      card.waitFor({ state: "visible", timeout: 45_000 }).then(() => "card" as const),
      erro.waitFor({ state: "visible", timeout: 45_000 }).then(() => "erro" as const),
    ]).catch(() => "nada" as const);
    if (vencedor === "card") return;
    registra(`[ambiente] tentativa ${i} de abrir o quadro ${pipelineId}: ${vencedor}`);
    await page.waitForTimeout(3_000);
  }
  throw new Error(`o quadro ${pipelineId} não abriu em 6 tentativas`);
}

/** Régua de encaixe: largura do conteúdo contra a da caixa. Ferramenta, não olho. */
export async function medeTransbordo(
  page: Page,
  seletor: string,
): Promise<{ scrollWidth: number; clientWidth: number; transborda: boolean }> {
  return page.locator(seletor).first().evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    transborda: el.scrollWidth > el.clientWidth + 1,
  }));
}

/** O documento inteiro: nada pode rolar na horizontal em 400 px. */
export async function transbordoDaPagina(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    transborda: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
}

export async function temaEscuro(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" });
}

export function registra(linha: string): void {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  fs.appendFileSync(path.join(EVIDENCIA, "medicoes.txt"), `${linha}\n`);
}

export { expect };
