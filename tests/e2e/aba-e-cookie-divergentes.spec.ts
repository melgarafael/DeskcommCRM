import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { test, expect } from "./helpers/test";
import type { Page } from "./helpers/test";

/**
 * DUAS ABAS, UM COOKIE — a aba que ficou para trás AVISA, e a escrita dela é
 * RECUSADA.
 *
 * ─── O defeito da #2335 ─────────────────────────────────────────────────────
 * O cookie `active_org` é UM por sessão do NAVEGADOR: vale para todas as abas.
 * A organização que cada aba acha que tem, porém, vem das props do layout e
 * fica fixa durante a vida do documento. Trocar pelo seletor faz
 * `window.location.assign` e recarrega SÓ aquela aba.
 *
 * Duas abas em A, alguém troca para B na primeira: o servidor já responde pela
 * B, a segunda segue desenhada com a A. Antes da #2335 isso tinha duas
 * consequências, e esta spec mede as duas:
 *
 *   (a) LEITURA — nada avisava a aba parada. Ela continuava operando numa
 *       organização que a sessão já não é mais;
 *   (b) ESCRITA — a mutação daquela aba caía na organização do COOKIE, que é
 *       a que ninguém na tela pediu. Escrever na empresa errada é o tipo de
 *       defeito que não se conserta depois.
 *
 * ─── Por que a asserção é sobre o COMPORTAMENTO e não sobre o dado ──────────
 * A issue avisa: "não basta 'o card mostrou B', porque um dublê que responde B
 * mostra B com qualquer chave de cache". Então aqui se mede o que é NOVO — o
 * AVISO depois do foco e a RECUSA da escrita (409 `org_divergente`) sem nada
 * gravado —, não a organização que os dados vieram. Um dublê que só respondesse
 * pela org certa continuaria passando nas outras specs e reprovaria aqui.
 *
 * ─── Por que a aba parada nasce na tela de configuração da agenda ───────────
 * Depois da troca, QUALQUER carga nova daquela aba viria renderizada pela org
 * do cookie (a B) e a aba deixaria de estar "para trás". O formulário é aberto
 * ANTES da troca e só o clique no "Criar tipo" vem depois: a escrita tentada é
 * a mesma que a pessoa estaria tentando na tela em que está.
 *
 * O mesmo cenário na API/`requireRole` tem 13 casos em
 * `tests/unit/aba-e-cookie-escrita-recusada.test.ts`, e o aviso em
 * `hooks/auth/InterfaceRefresh.test.tsx` — esta spec é a travessia real, com
 * cookie de verdade e duas abas de verdade.
 */

const RAIZ = path.resolve(__dirname, "../..");

// Login + duas abas + troca de organização + as duas metades.
test.describe.configure({ timeout: 180_000 });

interface DuasOrgs {
  org_a_id: string;
  org_b_id: string;
  org_b_nome: string;
  tipo_a: { slug: string; nome: string; id: string };
  tipo_b: { slug: string; nome: string; id: string };
}

interface Creds {
  org_name?: string;
  password: string;
  users: Record<string, { email: string } | undefined>;
  duas_orgs?: DuasOrgs;
}

/** O mesmo da spec irmã `agenda-escopo-da-organizacao.spec.ts`: mesmo seed, mesmo usuário. */
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

async function entrar(page: Page, creds: Creds) {
  // `manager` pelo mesmo motivo das specs irmãs: o `admin` do seed tem TOTP, e
  // a tela de 2FA não é o assunto aqui.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

async function trocarPara(page: Page, orgId: string, nome: string) {
  await page.getByTestId("tenant-switcher").click();
  await page.getByTestId(`tenant-switcher-item-${orgId}`).click();
  if (!nome) return;
  // ESPERAR A TRANSIÇÃO TERMINAR ANTES DE SEGUIR (o mesmo aviso da spec irmã):
  // a troca é uma server action e o botão fica `disabled` mostrando o nome
  // ANTIGO enquanto ela roda. Aqui a espera é ainda mais necessária — é ela
  // que separa "a troca aconteceu" de "a troca foi atirada".
  const seletor = page.getByTestId("tenant-switcher");
  await expect(seletor, `a troca para "${nome}" não terminou`).toBeEnabled({ timeout: 60_000 });
  await expect(seletor, `a troca para "${nome}" não pegou`).toContainText(nome, { timeout: 20_000 });
}

/**
 * O aviso da #2335 — a MESMA janela para a leitura e para a escrita.
 *
 * ⚠️ RECONHECIDO PELO DADO, NÃO PELA FRASE. A suíte E2E inteira compartilha o
 * MESMO banco sem reset entre specs, e o idioma guardado no usuário muda
 * conforme quem roda antes (medido nesta própria spec: numa rodada a tela
 * veio em espanhol e o filtro por "organização diferente da sessão" não achou
 * nada — o aviso saiu como "Esta pestaña está en una organización diferente…").
 * Os NOMES das organizações e a seta "A → B" são DADO depois da frase
 * traduzida (`aviso-org-divergente.ts` interpola os nomes por fora do `t()`),
 * então são eles que reconhecem o aviso — em qualquer idioma.
 */
function avisoDivergente(page: Page, orgDaSessao: string) {
  return page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "→" })
    .filter({ hasText: orgDaSessao });
}

/**
 * A marca de vida da aba: um `window` SÓ existe enquanto o documento existe.
 * `location.assign`, `location.reload` e qualquer troca de documento apagam a
 * marca — é o que separa "avisa" de "recarrega sozinho", que é o que a metade 1
 * existe para não fazer (trocar o documento sem pedido apaga formulário em
 * edição e a URL aberta, #2313).
 */
async function marcarAVida(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __abaQueFicouParaTras?: { marca: string; url: string } }).__abaQueFicouParaTras =
      { marca: "viva", url: window.location.href };
  });
}

async function vidaDaAba(page: Page): Promise<{ marca: string | undefined; url: string | undefined }> {
  return page.evaluate(() => {
    const w = window as unknown as { __abaQueFicouParaTras?: { marca: string; url: string } };
    return { marca: w.__abaQueFicouParaTras?.marca, url: w.__abaQueFicouParaTras?.url };
  });
}

test("duas abas no mesmo cookie: a que ficou em A recebe o aviso no foco e a escrita dela é recusada", async ({
  page,
  context,
}) => {
  const creds = lerCreds();
  const d = creds.duas_orgs as DuasOrgs;

  // ── ABA 1 — a que vai ficar PARA TRÁS ─────────────────────────────────────
  await entrar(page, creds);
  // Começa pela org A EXPLICITAMENTE, como na spec irmã: sem isto a spec
  // dependeria de qual org o cookie elegeu, e passaria a medir outra coisa no
  // dia em que essa ordem mudasse.
  await trocarPara(page, d.org_a_id, creds.org_name ?? "");
  await page.goto("/app/settings/tenant/agenda");
  await expect(page.getByTestId("tipos-de-agendamento-config")).toBeVisible({ timeout: 20_000 });

  // Nome único por execução: uma spec que só passa na primeira é pior que nenhuma.
  const nome = `Recusado E2E ${Date.now().toString().slice(-6)}`;
  await page.getByTestId("abrir-novo-tipo").click();
  await expect(page.getByTestId("form-novo-tipo")).toBeVisible();
  await page.getByTestId("novo-tipo-nome").fill(nome);
  await page.getByTestId("novo-tipo-categoria").selectOption("retorno");
  await page.getByTestId("novo-tipo-duracao").fill("15");
  // O formulário fica PREENCHIDO E ABERTO, sem salvar: é ele que a metade 2
  // recusa daqui a pouco. Preenchido de propósito — o cenário real é alguém
  // trabalhando numa tela quando a outra aba muda de organização.

  await marcarAVida(page);
  const urlAntes = page.url();

  // ── ABA 2 — MESMO context (mesmo cookie), e é ELA que troca ───────────────
  const abaQueTroca = await context.newPage();
  await abaQueTroca.goto("/app");
  await trocarPara(abaQueTroca, d.org_b_id, d.org_b_nome);
  // A troca é `window.location.assign` na aba 2: recarrega SÓ ela. A aba 1
  // segue com as props de A enquanto o cookie da SESSÃO já é B.

  // ── (a) LEITURA — o aviso vem DEPOIS DO FOCO ──────────────────────────────
  // O `InterfaceRefresh` só age no foco, no `visibilitychange` ou no polling de
  // 30 s — e SAI CEDO com a aba oculta (`isDocumentHidden()`), então esperar o
  // polling nunca chegaria a lugar nenhum. Trazer a aba para o frente é o gesto
  // de quem está usando, e é ele que o teste faz.
  //
  // ⚠️ E O FOCO ENTREGUE, NÃO O ESPERADO. Medido nesta própria suíte: no
  // Chromium headless as duas abas do MESMO contexto respondem
  // `document.visibilityState === "visible"` o tempo todo (ler antes e depois
  // do `bringToFront` devolve `visible` nas duas), então a virada de aba NÃO
  // emite `focus` nem `visibilitychange` — e a spec reprovava esperando um
  // evento que o navegador de teste não manda. A primeira versão passou 20 s em
  // `toBeVisible` sem achar o aviso; despachando o MESMO evento que o
  // navegador entregaria ao usuário, o aviso aparece em menos de 2 s. O gesto
  // real continua sendo feito (`bringToFront`); o evento é o que falta nele.
  await page.bringToFront();
  await expect(
    avisoDivergente(page, d.org_b_nome),
    "o aviso apareceu SEM o foco — a metade 1 é sobre o aviso no foco, não sobre um aviso que chega sozinho",
  ).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  const aviso = avisoDivergente(page, d.org_b_nome);
  await expect(
    aviso,
    "a aba que ficou em A não recebeu o aviso de organização divergente depois do foco",
  ).toBeVisible({ timeout: 20_000 });
  // O aviso NOMEIA as duas organizações ("A → B"): é o servidor que diz pela
  // qual a sessão resolve agora, e ela é a B da outra aba.
  await expect(aviso, "o aviso não nomeou a organização da sessão").toContainText(d.org_b_nome);
  await expect(
    aviso,
    `o aviso não nomeou a organização DA ABA — ele é "${creds.org_name} → ${d.org_b_nome}"`,
  ).toContainText(creds.org_name ?? "");
  // A decisão fica com quem está na tela: o aviso tem o botão de recarregar e
  // nenhum prazo — enquanto a divergência durar, ele continua lá. O rótulo é
  // traduzido (`t("Recarregar")`), então se mede que o botão EXISTE, não o que
  // diz — o mesmo motivo do filtro acima. `[data-action]` é o botão de AÇÃO do
  // sonner; o `getByRole("button")` bruto apanha também o `×` de fechar, que é
  // fechamento, não decisão (medido: 2 botões).
  const botaoDoAviso = aviso.locator("[data-action]");
  await expect(botaoDoAviso, "o aviso não ofereceu a decisão de recarregar").toHaveCount(1);
  expect(
    (await botaoDoAviso.innerText()).trim(),
    "o botão do aviso veio sem rótulo — quem lê a tela não tem como saber o que ele faz",
  ).not.toBe("");

  // E NADA de recarga sozinha. Três provas independentes:
  const vida = await vidaDaAba(page);
  expect(
    vida.marca,
    "a aba foi trocada de documento sem ninguém pedir — a marca de vida sumiu",
  ).toBe("viva");
  expect(page.url(), "a URL da aba mudou sozinha").toBe(urlAntes);
  await expect(
    page.getByTestId("tenant-switcher"),
    "a aba recarregou e já mostra a organização da sessão — o aviso teria sido trocado por uma recarga",
  ).not.toContainText(d.org_b_nome);

  // ── (b) ESCRITA — a MESMA aba, ainda com as props de A, sem recarregar ────
  // O `apiClient` carimba o header `X-Org-Da-Aba` (= A) nesta mutação; o cookie
  // diz B; o `requireRole` — o gate que toda rota /api/v1 atravessa — recusa
  // com `org_divergente`. Sem sabotagem nenhuma: é o produto como está na main.
  const recusa = page.waitForResponse(
    (r) => r.url().includes("/api/v1/agenda/tipos") && r.request().method() === "POST",
  );
  await page.getByTestId("salvar-novo-tipo").click();
  const resposta = await recusa;
  expect(resposta.status(), "a escrita da aba divergente não foi recusada com 409").toBe(409);
  const corpo = (await resposta.json()) as { error?: { code?: string } };
  expect(
    corpo.error?.code,
    "a recusa não veio com o código próprio `org_divergente` — a tela não tem como traduzi-la no mesmo aviso",
  ).toBe("org_divergente");

  // A tela se comporta como quem NÃO salvou: o formulário continua aberto.
  // (`comErro`, em `settings/tenant/agenda/_client.tsx`, só fecha o formulário
  // e chama `router.refresh()` quando a escrita deu certo.)
  await expect(
    page.getByTestId("form-novo-tipo"),
    "a tela se comportou como quem salvou — o formulário fechou",
  ).toBeVisible();

  // NADA GRAVADO NA ORGANIZAÇÃO B — e a conferência é no BANCO, não na tela
  // (o card mostrando B passaria com qualquer dublê, issue). Nenhuma
  // organização pode ter este tipo: nem a do cookie, nem a da aba.
  const credenciais = credenciaisSupabaseDeTeste();
  const admin = createClient(credenciais.url, credenciais.serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: gravados, error } = await admin
    .from("calendar_event_types")
    .select("id, organization_id")
    .eq("name", nome);
  if (error) throw new Error(`conferir o banco falhou: ${error.message}`);
  expect(
    gravados,
    `a escrita que o servidor recusou gravou assim mesmo: ${JSON.stringify(gravados)}`,
  ).toEqual([]);

  // ── O CONTRAFACTUAL, NA MESMA SESSÃO E NA MESMA TELA ──────────────────────
  // Sem o header `X-Org-Da-Aba` — que é justamente o que a #2335 acrescenta —
  // a MESMA escrita, com o MESMO cookie, é ACEITA e cai na organização da
  // SESSÃO (a B), que é a que ninguém na tela pediu. É a prova, contra o
  // servidor de verdade, de que o 409 de cima vem da divergência declarada e
  // não de a escrita estar falhando por qualquer outro motivo (papel, slug
  // repetido, validação). Um fetch comum, sem o header, é o mundo de ANTES do
  // fix — e é o que a sabotagem deste teste removeria.
  const nomeControle = `Controle E2E ${Date.now().toString().slice(-6)}`;
  const controle = await page.evaluate(async (corpo) => {
    const r = await fetch("/api/v1/agenda/tipos", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      credentials: "same-origin",
    });
    return { status: r.status };
  }, { name: nomeControle, category: "retorno", duration_minutes: 15, location_kind: "in_person" });
  expect(
    controle.status,
    "sem o header da aba a MESMA escrita foi recusada — então o que esta spec mede não é a divergência",
  ).toBe(201);

  const { data: noControle, error: erroControle } = await admin
    .from("calendar_event_types")
    .select("id, organization_id")
    .eq("name", nomeControle);
  if (erroControle) throw new Error(`conferir o banco falhou: ${erroControle.message}`);
  expect(
    noControle?.map((l) => l.organization_id),
    "a escrita sem o header não caiu na organização do cookie (a B)",
  ).toEqual([d.org_b_id]);

  // A limpeza é parte do contrato: a spec deixa o banco como estava. (A rota de
  // DELETE só DESATIVA o tipo — `calendar_appointments.event_type_id` aponta
  // para cá —, então quem apaga a linha é o service role, como os seeds.)
  const { error: erroLimpeza } = await admin
    .from("calendar_event_types")
    .delete()
    .eq("id", noControle![0]!.id);
  if (erroLimpeza) throw new Error(`limpar o controle falhou: ${erroLimpeza.message}`);

  await page.screenshot({ path: "evidence/auth/2335-aba-e-cookie-divergentes.png", fullPage: true });
});
