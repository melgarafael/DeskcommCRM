/**
 * O PAINEL DE SKILLS MOSTRA A VERSÃO NOVA DO CATÁLOGO — com dado real no banco,
 * em português e em espanhol, e o aviso SOME quando a pessoa adota (#1977).
 *
 * ─── O que este arquivo cobre e o que já estava coberto ─────────────────────
 * O estado "versão nova do catálogo" nasceu no #1927 e ganhou o comparativo no
 * #1962. Desde então existem duas provas, e as DUAS mockam o estado:
 *
 *   - `tests/unit/spec-versao-nova-catalogo.test.tsx` renderiza `SkillsClient`
 *     com `initialState` escrito à mão (#2224);
 *   - `app/api/v1/ai/skills/route.test.ts` prova o CÁLCULO de
 *     `versao_nova_catalogo` na rota GET.
 *
 * Faltava a terceira, e ela é a única que alcança o caminho inteiro: três
 * `skill_versions` de verdade no banco (duas de plataforma, uma cópia da org com
 * `forked_from_version_id`), o ponteiro de plataforma MOVIDO depois da cópia
 * instalada, o SSR de `app/app/ai/skills/page.tsx` montando o `initialState`, e
 * o "Adotar versão nova" refazendo o fork pela API. Nada disso se prova com
 * `initialState` mockado: um mock que esquecesse o `comparativo` ou o vínculo de
 * fork continuaria passando no teste de render.
 *
 * ─── As três provas da issue, nesta ordem ───────────────────────────────────
 * 1. O SEED (`scripts/seed-e2e-skill-versao-nova.ts`) semeia a skill do catálogo
 *    JÁ instalada na organização e move o ponteiro de plataforma para uma versão
 *    nova com descrição, palavras-chave e corpo diferentes.
 * 2. Quem olha a tela de longe confere o AVISO, o TÍTULO do comparativo, as
 *    palavras-chave que ENTRAM (+) e que SAEM (−) e o placar de LINHAS do
 *    procedimento — em pt-BR e depois em es, trocando o idioma pela própria tela
 *    (mesmo mecanismo de `agenda-presenca-recuperacao.spec.ts`).
 * 3. ADOTAR faz o aviso sumir — e some no BANCO, não só no cache do cliente:
 *    o `page.reload()` depois do clique é o que separa "o react-query invalidou"
 *    de "o ponteiro da organização andou".
 *
 * ─── Por que os textos do comparativo são números, não advinhados ───────────
 * O seed fixa o delta: corpo antigo de 4 linhas, novo de 5, com 3 idênticas
 * (LCS 3) → `+2 −1`; palavras-chave `agendar, remarcar, legado` →
 * `agendar, remarcar, reatendimento, lista de espera` → `+reatendimento, lista
 * de espera` e `−legado`. A spec cobra esses literais: se o comparativo passar a
 * contar errado (ou a tela passar a mostrar o diff de outro par de versões), o
 * vermelho aponta o número que mentiu.
 *
 * ─── RED ────────────────────────────────────────────────────────────────────
 * `E2E_SKILL_SEM_VERSAO_NOVA=1` faz o seed montar a cópia da organização
 * FORKADA DA VERSÃO ATUAL de plataforma — o catálogo não publicou nada depois
 * da instalação, então não há o que avisar. É a ausência exata do que se quer
 * provar, e a spec tem de reprovar no primeiro `expect` do aviso.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect } from "./helpers/test";

const RAIZ = path.resolve(__dirname, "../..");

// Login + travessia do painel + troca de idioma + um install pela API.
test.describe.configure({ timeout: 150_000 });

/** Literal de `app/app/ai/skills/_client.tsx` — copiado do código, não de memória. */
const AVISO_PT =
  "Há uma versão nova desta skill no catálogo. Se você editou esta cópia, suas alterações ficam só no Histórico de versões: ao adotar, a versão nova do catálogo passa a ser a ativa. Confira antes de adotar.";
const AVISO_ES =
  "Hay una versión nueva de esta skill en el catálogo. Si editaste esta copia, tus cambios quedan solo en el Historial de versiones: al adoptarla, la versión nueva del catálogo pasa a ser la activa. Revisa antes de adoptar.";
const TITULO_PT = "Se você adotar a versão do catálogo, muda:";
const TITULO_ES = "Si adoptas la versión del catálogo, cambia:";

/** O par de versões que o seed garante — o comparativo da tela é disto. */
const DESCRICAO_ANTIGA = "Atende o cliente pelo WhatsApp e fecha o agendamento.";
const DESCRICAO_NOVA =
  "Atende o cliente pelo WhatsApp, fecha o agendamento e cuida da lista de espera.";

interface SkillVersaoNova {
  nome: string;
  versao_copia: string;
  versao_plataforma: string;
  descricao_copia: string;
  descricao_plataforma: string;
  com_versao_nova: boolean;
}

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  skill_versao_nova?: SkillVersaoNova;
}

/**
 * Semeia SEMPRE, não só na primeira vez — o "Adotar versão nova" do fim do teste
 * move o ponteiro da organização, e a rodada seguinte herdaria um painel sem
 * aviso. O seed é idempotente e devolve o cenário ao começo.
 */
function semear(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  // O binário LOCAL do tsx, e não `npx` como as specs irmãs: medido nesta VPS,
  // `/usr/local/bin/npx` é um link para um npm que não está mais instalado, e o
  // `spawnSync npx ENOENT` derruba a spec no primeiro passo — longe de qualquer
  // coisa que ela queira provar. `node_modules/.bin/tsx` existe em qualquer
  // checkout com dependências instaladas, e o `#!/usr/bin/env node` resolve no
  // PATH do runner.
  execFileSync(path.join(RAIZ, "node_modules", ".bin", "tsx"), ["scripts/seed-e2e-skill-versao-nova.ts"], {
    stdio: "inherit",
    cwd: RAIZ,
    env: process.env,
  });
  const c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.skill_versao_nova) throw new Error("o seed rodou e não gravou o bloco `skill_versao_nova`");
  return c;
}

async function entrar(page: import("@playwright/test").Page, creds: Creds) {
  // `manager`: é o menor papel que gerencia skills (`ai.skills.manage`) e não
  // tem TOTP — a tela de 2FA não é o assunto aqui.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

/** O cartão da skill instalada — o `li` da lista "Skills instaladas". */
function cartao(page: import("@playwright/test").Page, nome: string) {
  return page.locator("li").filter({ hasText: nome });
}

/** Mecanismo de troca de idioma das specs irmãs: pela TELA, esperando o reload. */
async function trocarParaEspanhol(page: import("@playwright/test").Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.getByTestId("seletor-de-idioma").click();
  const reload = page.waitForEvent("load");
  await page.getByTestId("idioma-es").click();
  await reload;
  await expect(page.getByTestId("seletor-de-idioma")).toHaveText("ES");
}

test("o painel de Skills avisa da versão nova do catálogo em pt-BR e em es, e o aviso some ao adotar", async ({
  page,
}) => {
  const creds = semear();
  const skill = creds.skill_versao_nova as SkillVersaoNova;
  // Contrato do seed: no cenário real a cópia instalada é a ANTIGA e o catálogo
  // aponta para a NOVA. Os literais de palavras-chave e de placar lá embaixo só
  // valem se este par for este — sem isto, um seed trocado de conteúdo passaria
  // em asserção nenhuma e reprovaria em todas, com a acusação errada.
  if (skill.com_versao_nova) {
    expect(skill.descricao_copia, "o seed não instalou a cópia antiga").toBe(DESCRICAO_ANTIGA);
    expect(skill.descricao_plataforma, "o seed não publicou a versão nova").toBe(DESCRICAO_NOVA);
  }
  await entrar(page, creds);

  // ═══ pt-BR — o que um operador lê ao abrir /app/ai/skills ═══
  await page.goto("/app/ai/skills");
  const cartaoDaSkill = cartao(page, skill.nome);
  await expect(cartaoDaSkill, `a skill semeada não aparece instalada em /app/ai/skills`).toBeVisible({
    timeout: 20_000,
  });
  // A cópia INSTALADA é a que o seed gravou — sem este oráculo, o aviso poderia
  // estar sendo exibido por uma cópia que já nasceu atual.
  await expect(cartaoDaSkill.getByText(skill.descricao_copia, { exact: true })).toBeVisible();

  await expect(cartaoDaSkill.getByText(AVISO_PT, { exact: true })).toBeVisible();
  await expect(cartaoDaSkill.getByText(TITULO_PT, { exact: true })).toBeVisible();
  // Palavras-chave: o que ENTRA ao adotar (+) e o que SAEM (−).
  await expect(cartaoDaSkill.getByText("Palavras-chave de ativação")).toBeVisible();
  await expect(cartaoDaSkill.getByText("+reatendimento, lista de espera")).toBeVisible();
  await expect(cartaoDaSkill.getByText("−legado")).toBeVisible();
  // Procedimento (corpo): o placar de linhas do diff — 4 linhas contra 5, LCS 3.
  await expect(cartaoDaSkill.getByText(/Procedimento \(corpo\):\s*\+2\s*−\s*1/)).toBeVisible();
  await expect(cartaoDaSkill.getByText("• Descrição")).toBeVisible();

  // ═══ es — o MESMO alvo, com os textos em espanhol ═══
  await trocarParaEspanhol(page);

  await expect(cartaoDaSkill.getByText(AVISO_ES, { exact: true })).toBeVisible();
  await expect(cartaoDaSkill.getByText(TITULO_ES, { exact: true })).toBeVisible();
  await expect(cartaoDaSkill.getByText("Palabras clave de activación")).toBeVisible();
  // Os +/- e o placar são DADO (palavras-chave e contagem), não texto de
  // interface: os mesmos literais nos dois idiomas.
  await expect(cartaoDaSkill.getByText("+reatendimento, lista de espera")).toBeVisible();
  await expect(cartaoDaSkill.getByText("−legado")).toBeVisible();
  await expect(cartaoDaSkill.getByText(/Procedimiento \(cuerpo\):\s*\+2\s*−\s*1/)).toBeVisible();
  await expect(cartaoDaSkill.getByText("• Descripción")).toBeVisible();

  // ═══ adotar — e o aviso SOME no banco, não só no cache do cliente ═══
  await cartaoDaSkill.getByRole("button", { name: "Adoptar versión nueva" }).click();
  await expect(cartaoDaSkill.getByText(AVISO_ES, { exact: true })).toHaveCount(0, { timeout: 20_000 });

  // Recarrega do servidor: o ponteiro da organização foi para a cópia forkada da
  // versão ATUAL de plataforma, então o aviso não volta nem no primeiro paint.
  await page.reload();
  await expect(page.getByTestId("seletor-de-idioma")).toHaveText("ES");
  const depoisDeAdotar = cartao(page, skill.nome);
  await expect(depoisDeAdotar, "adotar desinstalou a skill").toBeVisible({ timeout: 20_000 });
  await expect(depoisDeAdotar.getByText(AVISO_ES, { exact: true })).toHaveCount(0);
  await expect(depoisDeAdotar.getByText(TITULO_ES, { exact: true })).toHaveCount(0);
  // E o que ficou ativo é a versão nova do catálogo — descrição inclusive.
  await expect(depoisDeAdotar.getByText(skill.descricao_plataforma, { exact: true })).toBeVisible();
});
