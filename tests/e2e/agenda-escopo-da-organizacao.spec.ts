import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect } from "@playwright/test";

/**
 * A AGENDA MOSTRA A ORGANIZAÇÃO ATIVA — e só ela.
 *
 * ─── O defeito que esta spec prende ──────────────────────────────────────────
 * O dono do produto instalou a v1.7.0 na VPS dele, abriu a Agenda e viu SEIS
 * tipos de agendamento onde há três. Clicar em metade deles devolvia
 * "Tipo de agendamento não encontrado. ID: <uuid>".
 *
 * Não havia duplicata nenhuma no banco. Ele é admin de DUAS organizações na
 * mesma instalação, e `app/app/agenda/page.tsx` consultava `calendar_event_types`
 * e `calendar_appointments` sem filtrar `organization_id`, confiando só na RLS.
 * A `fn_user_org_ids()` que as policies usam devolve TODAS as organizações do
 * usuário: ela é PISO (impede vazamento entre inquilinos), não ESCOPO (não
 * escolhe a org ativa). O erro "não encontrado" era a consequência — a rota que
 * marca escapa a org corretamente e não achava o tipo que esta tela ofereceu.
 *
 * ─── Por que a asserção é sobre NOMES, não sobre contagem ────────────────────
 * A org B também recebe tipos semeados no provisionamento, com os MESMOS nomes
 * da org A. Contar chips passaria com o código quebrado; só o conjunto de nomes
 * distingue "a org certa" de "as duas somadas".
 *
 * Toda a suíte até aqui roda com usuário de UMA organização — um cenário de uma
 * org não consegue, por construção, enxergar este defeito. Por isso o seed novo.
 */
const RAIZ = path.resolve(__dirname, "../..");

// Login + duas travessias da Agenda + troca de organização.
test.describe.configure({ timeout: 150_000 });

interface DuasOrgs {
  org_a_id: string;
  org_b_id: string;
  org_b_nome: string;
  tipo_a: { slug: string; nome: string; id: string };
  tipo_b: { slug: string; nome: string; id: string };
}

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  duas_orgs?: DuasOrgs;
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.duas_orgs) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-duas-organizacoes.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.duas_orgs) throw new Error("o seed rodou e não gravou o bloco `duas_orgs`");
  return c;
}

async function entrar(page: import("@playwright/test").Page, creds: Creds) {
  // `manager` pelo mesmo motivo das specs irmãs: o `admin` do seed tem TOTP, e a
  // tela de 2FA não é o assunto aqui.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

/** Os nomes dos chips de tipo, como quem olha a tela os leria. */
async function tiposOferecidos(page: import("@playwright/test").Page): Promise<string[]> {
  await page.goto("/app/agenda");
  await page.getByRole("button", { name: /Novo agendamento/i }).click();
  const lista = page.getByTestId("tipos-de-agendamento");
  await expect(lista, "o painel de marcação não ofereceu tipo nenhum").toBeVisible({ timeout: 20_000 });
  const textos = await lista.getByRole("button").allInnerTexts();
  // FECHA O PAINEL antes de devolver. Ele é um `Sheet` com overlay
  // `fixed inset-0`, e deixá-lo aberto faz o próximo clique — o do seletor de
  // organização — bater no overlay em vez de no botão. Medido: a spec falhava
  // com "intercepts pointer events" por 150s, num ponto que não tinha nada a ver
  // com o que ela mede.
  await page.keyboard.press("Escape");
  await expect(lista).toBeHidden({ timeout: 10_000 });
  // O chip é "Nome" + a duração colada ("Consulta E2E 30min"). O nome é a
  // primeira linha; o `replace` tira o sufixo de duração quando não há quebra.
  return textos.map((t) => t.split("\n")[0]!.replace(/\d+\s*min$/i, "").trim());
}

async function trocarPara(page: import("@playwright/test").Page, orgId: string, nome: string) {
  await page.getByTestId("tenant-switcher").click();
  await page.getByTestId(`tenant-switcher-item-${orgId}`).click();
  if (nome) {
    const seletor = page.getByTestId("tenant-switcher");
    // ESPERAR A TRANSIÇÃO TERMINAR ANTES DE LER O TEXTO. A troca é uma server
    // action dentro de `useTransition`, e enquanto ela roda o botão fica
    // `disabled` mostrando o nome ANTIGO. Ler o texto nesse meio-tempo mede a
    // velocidade da máquina, não a troca — e reprova com a acusação errada,
    // "a troca não pegou", quando o certo seria "a troca ainda não terminou".
    //
    // Medido no CI: esta parte da suíte levou 16,9 min numa rodada contra 8,6
    // min em outra, no mesmo repositório. O teto de 20s era do tamanho dessa
    // variação, então o resultado dependia de quão carregado o runner estava.
    //
    // A propriedade medida NÃO afrouxa: depois que o botão volta a ficar
    // habilitado, o nome TEM de ser o da organização nova. Troca que não
    // acontece continua reprovando — só deixa de reprovar troca que demora.
    await expect(seletor, `a troca para "${nome}" não terminou`).toBeEnabled({ timeout: 60_000 });
    await expect(seletor, `a troca para "${nome}" não pegou`).toContainText(nome, { timeout: 20_000 });
  }
}

test("membro de duas organizações vê na Agenda só os tipos da organização ativa", async ({ page }) => {
  const creds = lerCreds();
  const d = creds.duas_orgs as DuasOrgs;
  await entrar(page, creds);

  // Começa pela org A EXPLICITAMENTE: sem isto a spec dependeria de qual org o
  // cookie ou a ordem da lista elegeu, e passaria a medir outra coisa no dia em
  // que essa ordem mudasse.
  await trocarPara(page, d.org_a_id, "");
  const naOrgA = await tiposOferecidos(page);
  expect(naOrgA, `a Agenda da org A não ofereceu "${d.tipo_a.nome}"`).toContain(d.tipo_a.nome);
  expect(
    naOrgA,
    `a Agenda da org A ofereceu "${d.tipo_b.nome}", que é da OUTRA organização — ` +
      "é exatamente o defeito da v1.7.0: a consulta confiava na RLS, que é piso e não escopo.",
  ).not.toContain(d.tipo_b.nome);

  await trocarPara(page, d.org_b_id, d.org_b_nome);
  const naOrgB = await tiposOferecidos(page);
  expect(naOrgB, `troquei para a org B e "${d.tipo_b.nome}" não apareceu`).toContain(d.tipo_b.nome);
  expect(
    naOrgB,
    `a Agenda da org B ofereceu "${d.tipo_a.nome}", que ficou para trás na troca`,
  ).not.toContain(d.tipo_a.nome);

  await page.screenshot({ path: "evidence/calendario/d4-agenda-escopo-org-b.png", fullPage: true });
});
