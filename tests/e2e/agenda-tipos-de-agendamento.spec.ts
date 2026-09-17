import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect } from "@playwright/test";

/**
 * TIPOS DE AGENDAMENTO PELA TELA — o que se pode marcar, e por quem.
 *
 * ─── O buraco que esta spec fecha ────────────────────────────────────────
 *
 * `calendar_event_types` tem DEZ categorias no CHECK, duração, buffers,
 * antecedência mínima, janela de agendamento e local — e não havia como criar ou
 * editar um tipo por lugar nenhum: nem rota, nem tela. Toda organização recebia
 * três tipos semeados e ficava com eles para sempre.
 *
 * ─── E o laço com o P0 ───────────────────────────────────────────────────
 *
 * Os três tipos semeados nasciam SEM `default_owner_user_id`, e sem responsável
 * `lib/agenda/consulta.ts` devolve `sem_responsavel` — a tela de marcar não
 * oferece horário nenhum, sem dizer por quê. O último caso desta spec fecha o
 * laço: um tipo criado COM responsável aparece na tela de marcar.
 */

/**
 * ⚠️ SEM `APP_URL`: as navegações são RELATIVAS, e o `baseURL` do
 * `playwright.config.ts` resolve.
 *
 * Isto era `process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"`, e o
 * fallback é o defeito: **o CI não define `PLAYWRIGHT_BASE_URL`**. Local eu
 * exportava a variável, então passava; no runner a spec batia em `:3000`, onde
 * não há nada, e as seis caíam em bloco com `ERR_CONNECTION_REFUSED` — que se
 * parece com "o servidor morreu" e é "eu bati na porta errada".
 *
 * O log mostra o formato exato: `··········FFFFFF` — dez testes passam, os seis
 * meus caem juntos, e os seguintes voltam a passar. Servidor vivo o tempo todo.
 *
 * As irmãs já faziam certo de dois jeitos: `agenda-tela-do-produto` usa caminho
 * relativo, e `agente-marca-consulta` usa `E2E_PORT ?? 3001`. Nenhuma inventa
 * 3000.
 */
const RAIZ = path.resolve(__dirname, "../..");

// Duas jornadas completas por caso (login + navegação + formulário).
test.describe.configure({ timeout: 120_000 });

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: { tipo_nome: string; tipo_slug: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  return c;
}

async function entrar(page: import("@playwright/test").Page, creds: Creds) {
  // `manager` porque criar e editar tipo exige `manager` na rota — e o `admin`
  // do seed tem MFA, que não é o assunto desta spec.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test("chego nos tipos CLICANDO no menu, e a lista mostra o que existe", async ({ page }) => {
  const creds = lerCreds();
  await entrar(page, creds);

  // Pela porta, não pela URL: ter tela e ser alcançável são coisas diferentes, e
  // o CI reprova tela em que só se chega digitando o endereço.
  //
  // ⚠️ A porta é o HUB, não a barra lateral. O grupo "organizacao" tem
  // `hub: { href: "/app/settings", label: "Configurações" }`, e as onze telas
  // dele se alcançam por ali — nenhuma aparece direto na lateral. Minha primeira
  // versão procurou na lateral e reprovou dizendo "não tem porta na navegação":
  // tinha, era outra. O caminho do teste é o caminho de quem usa.
  await page.goto("/app/settings");
  const item = page.getByRole("link", { name: /Tipos de agendamento/ }).first();
  await expect(item, "a tela não aparece no hub de Configurações").toBeVisible({ timeout: 20_000 });
  await item.click();

  await expect(page).toHaveURL(/\/app\/settings\/tenant\/agenda/, { timeout: 20_000 });
  await expect(page.getByTestId("tipos-de-agendamento-config")).toBeVisible();
  await expect(
    page.getByTestId("lista-de-tipos").getByRole("listitem").first(),
    "a lista veio vazia — a organização de teste tem tipos semeados",
  ).toBeVisible({ timeout: 15_000 });
});

test("crio um tipo COM responsável, e ele passa a ser marcável na Agenda", async ({ page }) => {
  const creds = lerCreds();
  await entrar(page, creds);
  await page.goto("/app/settings/tenant/agenda");
  await expect(page.getByTestId("tipos-de-agendamento-config")).toBeVisible({ timeout: 20_000 });

  // Nome único por execução: a rota recusa slug repetido com 409, e uma spec que
  // só passa na primeira execução é pior que spec nenhuma.
  const nome = `Retorno E2E ${Date.now().toString().slice(-6)}`;

  await page.getByTestId("abrir-novo-tipo").click();
  await expect(page.getByTestId("form-novo-tipo")).toBeVisible();
  await page.getByTestId("novo-tipo-nome").fill(nome);
  await page.getByTestId("novo-tipo-categoria").selectOption("retorno");
  await page.getByTestId("novo-tipo-duracao").fill("15");

  // ⚠️ O RESPONSÁVEL É O PONTO DESTA SPEC. Sem ele o tipo nasce igual aos três
  // semeados: existe na lista e não produz horário nenhum.
  const dono = page.getByTestId("novo-tipo-dono");
  const opcoes = await dono.locator("option").count();
  expect(opcoes, "o seletor de responsável não listou ninguém — não há o que escolher").toBeGreaterThan(1);
  await dono.selectOption({ index: 1 });

  await page.getByTestId("salvar-novo-tipo").click();

  const linha = page.getByTestId("lista-de-tipos").getByRole("listitem").filter({ hasText: nome });
  await expect(linha, "criei o tipo e ele não apareceu na lista").toBeVisible({ timeout: 20_000 });
  await expect(linha).toContainText("15 min");
  await expect(
    linha.getByText("sem responsável"),
    "criei COM responsável e a lista diz que está sem",
  ).toHaveCount(0);

  // ── O laço: o tipo novo chega na tela de marcar ───────────────────────
  await page.goto("/app/agenda");
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("tipos-de-agendamento")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: new RegExp(`^${nome}`) }),
    "o tipo foi criado em Configurações e não apareceu na tela de marcar — " +
      "configurar e usar ficaram em mundos separados",
  ).toBeVisible({ timeout: 15_000 });
});

test("o tipo NASCE com responsável — e quem escolhe 'Definir depois' recebe a saída", async ({
  page,
}) => {
  /**
   * AS DUAS METADES DO D6, num caso só, porque uma sem a outra não resolve.
   *
   * O que o usuário via: criou "Call Estratégica" e a lista respondeu
   * "sem responsável — não aparece para marcar". Ele não tinha deixado de
   * preencher nada — o rascunho da TELA nascia com `default_owner_user_id: ""`,
   * o POST omitia o campo, e a tela passava a acusar o estado que ela mesma
   * produziu. Sem responsável, `lib/agenda/consulta.ts` responde
   * `sem_responsavel` e a tela de marcar não oferece horário nenhum.
   *
   * A migration 0195 não alcança este caso por construção: o trigger dela roda
   * `after insert on user_organizations`, no PRIMEIRO membro ativo. Dispara
   * quando entra MEMBRO, nunca quando entra TIPO.
   *
   * O aviso continua existindo — deixar um tipo sem dono é escolha legítima de
   * quem opera — mas agora ele é a PORTA para resolver, em vez de um texto
   * inerte. Acusar sem oferecer caminho é o mesmo defeito do aviso da Agenda que
   * não levava aos horários, repetido em outra tela do mesmo produto.
   */
  const creds = lerCreds();
  await entrar(page, creds);
  await page.goto("/app/settings/tenant/agenda");
  await expect(page.getByTestId("tipos-de-agendamento-config")).toBeVisible({ timeout: 20_000 });

  // ── METADE A: sem tocar no seletor, o tipo nasce COM dono ──────────────────
  const comDono = `Nasce Com Dono E2E ${Date.now().toString().slice(-6)}`;
  await page.getByTestId("abrir-novo-tipo").click();
  await page.getByTestId("novo-tipo-nome").fill(comDono);
  await page.getByTestId("salvar-novo-tipo").click();

  const linhaComDono = page
    .getByTestId("lista-de-tipos")
    .getByRole("listitem")
    .filter({ hasText: comDono });
  await expect(linhaComDono).toBeVisible({ timeout: 20_000 });
  await expect(
    linhaComDono.getByText("sem responsável"),
    "criei um tipo sem mexer no seletor e ele nasceu órfão — é exatamente o defeito D6",
  ).toHaveCount(0);

  // ── O seletor NOMEIA GENTE ────────────────────────────────────────────────
  // Ele oferecia `0c4f9a1e · admin`: escolher responsável entre fragmentos de
  // UUID não é escolha, é adivinhação.
  await linhaComDono.getByRole("button", { name: "Editar" }).click();
  const seletor = page.getByTestId(/^editar-dono-/).first();
  await expect(seletor).toBeVisible({ timeout: 15_000 });
  const rotulos = await seletor.locator("option").allInnerTexts();
  const dePessoa = rotulos.filter((r) => r !== "Sem responsável");
  expect(dePessoa.length, "o seletor não oferece pessoa nenhuma").toBeGreaterThan(0);
  expect(
    dePessoa.every((r) => /^[0-9a-f]{8} · \w+$/.test(r.trim())),
    `o seletor ainda rotula por fragmento de UUID: ${JSON.stringify(dePessoa)}`,
  ).toBe(false);

  // ── METADE B: quem escolhe "Definir depois" é acusado E recebe a saída ────
  const semDono = `Definir Depois E2E ${Date.now().toString().slice(-6)}`;
  await page.goto("/app/settings/tenant/agenda");
  await page.getByTestId("abrir-novo-tipo").click();
  await page.getByTestId("novo-tipo-nome").fill(semDono);
  // Índice 0 é "Definir depois", e a ordem importa: o outro caso desta spec faz
  // `selectOption({ index: 1 })` contando que a ausência seja a primeira opção.
  await page.getByTestId("novo-tipo-dono").selectOption({ index: 0 });
  await page.getByTestId("salvar-novo-tipo").click();

  const linhaSemDono = page
    .getByTestId("lista-de-tipos")
    .getByRole("listitem")
    .filter({ hasText: semDono });
  await expect(linhaSemDono).toBeVisible({ timeout: 20_000 });

  const aviso = linhaSemDono.getByText("sem responsável");
  await expect(aviso, "escolhi 'Definir depois' e a tela não avisou").toBeVisible();

  // O AVISO ABRE O QUE RESOLVE. Antes era um `<span>`: acusava e a única saída
  // era descobrir sozinho que o botão "Editar" tem um seletor de responsável.
  await aviso.click();
  const seletorDoOrfao = linhaSemDono.getByTestId(/^editar-dono-/).first();
  await expect(
    seletorDoOrfao,
    "cliquei no aviso e ele não abriu nada — continua acusando sem oferecer caminho",
  ).toBeVisible({ timeout: 15_000 });

  await seletorDoOrfao.selectOption({ index: 1 });
  await linhaSemDono.getByTestId(/^salvar-/).first().click();
  await expect(
    linhaSemDono.getByText("sem responsável"),
    "defini o responsável pelo caminho que a tela ofereceu e o aviso continuou lá",
  ).toHaveCount(0, { timeout: 20_000 });

  await page.screenshot({ path: "evidence/calendario/d6-tipo-com-responsavel.png", fullPage: true });
});

test("desativar tira o tipo da tela de marcar, e reativar o traz de volta", async ({ page }) => {
  /**
   * ⚠️ ESTE CASO JÁ EXISTIA E CONFERIA O BOTÃO "Reativar" SÓ COM `toBeVisible`.
   *
   * Foi exatamente assim que ele sobreviveu morto. O botão mandava
   * `PATCH /api/v1/agenda/tipos` com `{ id, is_active: true }`; o
   * `alterarSchema` daquela rota é `criarSchema.partial()`, onde `is_active` não
   * existe, e Zod descarta chave desconhecida em silêncio — o corpo chegava
   * vazio e a resposta era 422 "Nenhum campo para alterar.". Nunca funcionou uma
   * vez, desde que a tela nasceu.
   *
   * Ver que o controle está DESENHADO não é ver que ele ABRE. O caso agora
   * clica, e cobra o efeito nos dois lugares: o rótulo "desativado" sai da lista
   * e o tipo volta a ser oferecido em /app/agenda.
   */
  const creds = lerCreds();
  await entrar(page, creds);
  await page.goto("/app/settings/tenant/agenda");
  await expect(page.getByTestId("tipos-de-agendamento-config")).toBeVisible({ timeout: 20_000 });

  const nome = `Temporario E2E ${Date.now().toString().slice(-6)}`;
  await page.getByTestId("abrir-novo-tipo").click();
  await page.getByTestId("novo-tipo-nome").fill(nome);
  await page.getByTestId("salvar-novo-tipo").click();

  const linha = page.getByTestId("lista-de-tipos").getByRole("listitem").filter({ hasText: nome });
  await expect(linha).toBeVisible({ timeout: 20_000 });

  await linha.getByRole("button", { name: "Desativar" }).click();

  // Continua NA LISTA, marcado como desativado — `calendar_appointments` aponta
  // para o tipo, e apagar levaria junto a história de que consulta foi feita.
  await expect(
    linha,
    "o tipo sumiu da lista ao desativar — desativar não é apagar",
  ).toBeVisible({ timeout: 20_000 });
  await expect(linha).toContainText("desativado");
  await expect(
    linha.getByRole("button", { name: "Reativar" }),
    "desativei e não há caminho de volta",
  ).toBeVisible();

  // E some de onde importa: da tela de marcar.
  await page.goto("/app/agenda");
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("tipos-de-agendamento")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: new RegExp(`^${nome}`) }),
    "tipo desativado continua oferecido para marcar",
  ).toHaveCount(0);

  // ─── A VOLTA ────────────────────────────────────────────────────────────
  //
  // Sem esta metade, desativar é uma porta que só abre para um lado: o nome
  // continua ocupado pelo tipo desligado (o slug é único), então quem errou o
  // clique não consegue nem recriar com o mesmo nome.
  await page.goto("/app/settings/tenant/agenda");
  await expect(page.getByTestId("tipos-de-agendamento-config")).toBeVisible({ timeout: 20_000 });
  await linha.getByRole("button", { name: "Reativar" }).click();

  await expect(
    linha.getByText("desativado"),
    "cliquei em Reativar e o tipo continua marcado como desativado",
  ).toHaveCount(0, { timeout: 20_000 });
  await expect(
    linha.getByRole("button", { name: "Desativar" }),
    "o tipo voltou mas a lista não oferece desligar de novo",
  ).toBeVisible();

  // E volta a aparecer onde importa — o mesmo lugar de onde saiu.
  await page.goto("/app/agenda");
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("tipos-de-agendamento")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: new RegExp(`^${nome}`) }),
    "reativei o tipo e ele não voltou para a tela de marcar",
  ).toHaveCount(1);
});

test("ligo o aviso do compromisso pela tela, e ele fica ligado", async ({ page }) => {
  /**
   * O OUTRO MEIO DO PAR — o caso que faltava para a entrega do lembrete existir.
   *
   * O cron `agenda-reminder` lê `reminder_enabled` e `reminder_minutes_before`
   * desde que nasceu, e nenhum dos dois estava em rota ou tela: a varredura
   * devolvia zero linhas em toda instalação e não havia como mudar isso.
   * Configuração sem superfície é capacidade morta (invariante 6 do Sistema
   * Vivo), e é por AQUI — a tela — que se prova que deixou de ser.
   *
   * O caso vive nesta spec, e não num arquivo novo, porque é a MESMA tela e o
   * mesmo login: um arquivo à parte custaria mais uma sessão num job que já
   * vive perto do teto de logins por IP, sem cobrir nada a mais.
   */
  const creds = lerCreds();
  await entrar(page, creds);
  await page.goto("/app/settings/tenant/agenda");
  await expect(page.getByTestId("tipos-de-agendamento-config")).toBeVisible({ timeout: 20_000 });

  const nome = `Lembrete E2E ${Date.now().toString().slice(-6)}`;
  await page.getByTestId("abrir-novo-tipo").click();
  await page.getByTestId("novo-tipo-nome").fill(nome);
  await page.getByTestId("salvar-novo-tipo").click();

  const linha = page.getByTestId("lista-de-tipos").getByRole("listitem").filter({ hasText: nome });
  await expect(linha).toBeVisible({ timeout: 20_000 });

  // ── NASCE DESLIGADO. A migration 0194 é explícita: mandar mensagem para o
  //    telefone de um cliente é irreversível, e ninguém é inscrito por default.
  await expect(
    linha.getByTestId(/^lembrete-ligado-/),
    "o tipo nasceu com o aviso LIGADO — ninguém escolheu isso",
  ).toHaveCount(0);

  await linha.getByRole("button", { name: "Editar" }).click();
  const caixa = linha.getByTestId(/^editar-lembrete-[0-9a-f]/).first();
  const minutos = linha.getByTestId(/^editar-lembrete-minutos-/).first();
  await expect(caixa).toBeVisible({ timeout: 15_000 });

  // ── O CAMPO DESLIGADO NÃO MENTE. Um campo de minutos editável ao lado de uma
  //    caixa desmarcada faz quem digita 60 concluir que agendou alguma coisa.
  await expect(
    minutos,
    "o campo de minutos está ativo com o aviso desligado — controle decorativo",
  ).toBeDisabled();

  await caixa.check();
  await expect(minutos, "marquei o aviso e o campo continuou travado").toBeEnabled();
  await minutos.fill("60");
  await linha.getByTestId(/^salvar-/).first().click();

  // ── O ESTADO APARECE SEM ABRIR NADA ────────────────────────────────────────
  await expect(
    linha.getByTestId(/^lembrete-ligado-/),
    "liguei o aviso e a lista não conta isso — quem olha a tela não sabe que mensagem vai sair",
  ).toBeVisible({ timeout: 20_000 });
  await expect(linha).toContainText("60 min");

  // ── E FICOU GRAVADO. Sem o recarregamento, isto mediria estado de React.
  await page.reload();
  const depois = page.getByTestId("lista-de-tipos").getByRole("listitem").filter({ hasText: nome });
  await expect(
    depois.getByTestId(/^lembrete-ligado-/),
    "o aviso voltou desligado depois de recarregar — não chegou ao banco",
  ).toBeVisible({ timeout: 20_000 });
  await expect(depois).toContainText("60 min");

  await page.screenshot({ path: "evidence/calendario/lembrete-ligado.png", fullPage: true });
});
