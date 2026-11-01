/**
 * O CELULAR CABE NA TELA — medido por GEOMETRIA, não por presença.
 *
 * ═══ Por que esta spec existe ════════════════════════════════════════════════
 *
 * `docs/design-system/screen-flow/07-responsive-strategy.md` declara os
 * princípios do celular desde 28/04/2026 — `100dvh`, área segura, alvo de
 * 44px — e quase nenhum deles existia em código. A entrega que os implementou
 * precisa de uma cerca, porque regressão de layout é invisível em teste de
 * presença: `toBeVisible()` passa em elemento CORTADO, que está no DOM, tem
 * tamanho e é considerado visível pelo Playwright. A borda que o corta é do PAI.
 * Vinte casos na tela do painel de marcação não pegaram exatamente esse defeito
 * (`agenda-painel-cabe-na-tela.spec.ts`).
 *
 * ═══ A régua, e ela tem uma armadilha de uma linha ═══════════════════════════
 *
 * `document.body.scrollWidth - document.documentElement.clientWidth`.
 *
 * NUNCA `documentElement.scrollWidth`. `app/globals.css` põe `overflow-x: hidden`
 * seguido de `clip` em `html` E em `body`, e sob `hidden` (que é a reserva para
 * motor sem `clip`) o `scrollWidth` do documentElement é GRAMPEADO no
 * `clientWidth`: a conta dá ZERO com um filho de 3000px. Está registrado em
 * `app/globals.css`, no bloco da coluna de horários da agenda — ali o gate dava
 * zero enquanto o usuário perdia metade da tela.
 *
 * Consequência que vale repetir: neste produto um estouro horizontal não produz
 * barra de rolagem. O conteúdo simplesmente SOME pela direita, sem aviso e sem
 * jeito de alcançá-lo. É por isso que a medida tem de ser explícita.
 *
 * ═══ E o `<main>`, desde 2026-10-23 — a régua do `body` era cega ═════════════
 *
 * A régua acima, sozinha, NÃO VIA o estouro de tela nenhuma do app. O `<main>`
 * da casca (`app/app/_components/AppShell.tsx`) tem `overflow-auto`: o que passa
 * da largura rola DENTRO dele, e o `body` continua exatamente da largura da
 * janela. Uma tabela de 500px numa tela de 390px dava `body - janela = 0`.
 *
 * Por isso a conta é `Math.max(body - janela, main.scrollWidth - main.clientWidth)`.
 * O `body` fica, porque ainda pega o que escapa da casca (sobreposto `fixed`,
 * portal); o `<main>` pega o que estoura no conteúdo, que é onde as telas
 * estouram. `estabilizar()` passou a olhar as duas larguras pelo mesmo motivo.
 *
 * O que se espera que a régua nova acuse (previsto pela leitura do código; o
 * run do CI com só a régua trocada é a medida), e o que ela NÃO acusa:
 *  - em `/app/metrics`, com dados, a Previsão — uma `<table>` crua
 *    (`PrevisaoPanel.tsx`), cinco colunas sem invólucro, num Card sem
 *    `overflow-hidden` — passa da tela e leva o `<main>` junto;
 *  - o ranking por atendente NÃO entra nessa conta: ele usa a `Table` de
 *    `components/ui/table.tsx`, que já embrulha tudo num `overflow-auto`
 *    próprio. Tabela assim rola na própria caixa e nunca alarga o `<main>`, então
 *    "o `<main>` não transborda" não prova cartão nenhum. Cartão se prova com
 *    asserção própria (cabeçalho escondido e a caixa da tabela sem rolagem).
 *
 * Para a Previsão e o ranking EXISTIREM na hora de medir, o arquivo semeia pelo
 * service role um negócio aberto com valor e data prevista no mês seguinte (numa
 * etapa com chance de fechamento, criada para isso) e um ganho atribuído ao
 * admin, mais uma conversa atribuída ao admin num canal (para o "Por canal"
 * existir) — e apaga tudo no fim, conferindo o erro de cada delete.
 *
 * ═══ Três casos, e o motivo de não serem onze ════════════════════════════════
 *
 * A primeira versão tinha um `test` por combinação (4 superfícies × 2 larguras,
 * mais os outros): onze logins. `tests/unit/e2e-dois-logins-nao-cabem-no-teto-padrao.test.ts`
 * reprovou, e com razão — o helper de login guarda o último código TOTP e, se o
 * login seguinte cai na MESMA janela de 30s, ele espera a próxima para não
 * repetir o código. Onze logins são até dez esperas dessas, e o veredito que
 * chega ao log é `Test timeout`, que se lê como tela travada.
 *
 * A correção é estrutural e não cosmética: as combinações viraram UM caso que
 * percorre as duas larguras e todas as superfícies com um login só. O teto
 * declarado abaixo cobre o login (mais a janela TOTP, no pior caso) e as dez
 * navegações (cinco superfícies desde 2026-10-23, com Relatórios).
 *
 * ═══ Espera estabilizar, e isto passou a importar mais ═══════════════════════
 *
 * A entrega acrescentou animação a todos os sobrepostos do produto (gaveta,
 * modal, menu, seletor, dica — eram ~24 classes que não geravam CSS nenhum).
 * Medir no meio de uma transição dá "falso vermelho hoje, falso verde amanhã",
 * com o produto quebrado igual. Então as medições abaixo esperam a largura do
 * `body` E a do `<main>` PARAREM de mudar.
 *
 * ═══ O que esta spec NÃO prova ═══════════════════════════════════════════════
 *
 * Que está bonito. Ela prova que cabe, que o dedo alcança e que o rodapé
 * reserva — três perguntas de régua. A prova de aparência é a evidência visual
 * de `evidence/celular-quase-nativo-20261005/`, citada em
 * `evidence/celular-quase-nativo-20261005/LEIA.md`.
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { admin, creds as credsDaOrganizacao, insere } from "./qa-l12-comum";

const EVIDENCE = path.join(process.cwd(), "evidence", "celular-quase-nativo-20261005");
mkdirSync(EVIDENCE, { recursive: true });

/**
 * O teto por caso. O piso que o gate cobra é o padrão do Playwright mais uma
 * janela TOTP inteira (30s + 30s). Eram 120s para oito navegações; com
 * Relatórios o primeiro caso faz dez, e cada uma espera `networkidle` e três
 * leituras quietas — 180s, para o veredito de um CI lento não ser `Test timeout`.
 */
test.describe.configure({ timeout: 180_000 });

/** O piso de alvo de toque da Apple HIG, adotado pelo princípio 4 da estratégia. */
const PISO_DE_TOQUE = 44;

/**
 * As larguras. 360 é o piso da faixa `mobile` declarada na estratégia
 * (360–767) e é onde a casa já mediu defeito real; 390 é o iPhone 12/13/14, a
 * largura mais comum e a que as outras ~20 specs do repo usam.
 */
const LARGURAS = [360, 390] as const;

/**
 * As superfícies que alguém abre no celular. `/admin/**` fica fora por
 * doutrina própria (princípio 6: super-admin não otimiza para celular).
 * Relatórios entrou em 2026-10-23 (ADR-0006, F4): é a outra tela de números do
 * gestor, ao lado do painel.
 */
const SUPERFICIES = [
  { rota: "/app/inbox", nome: "inbox" },
  { rota: "/app/kanban", nome: "funis" },
  { rota: "/app/agenda", nome: "agenda" },
  { rota: "/app/metrics", nome: "painel" },
  { rota: "/app/activities", nome: "relatorios" },
] as const;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Só letras e dígitos: entra no `slug` da etapa, que aceita `[a-z0-9_-]`. */
const MARCA = `${Date.now()}`.slice(-7);
const negociosSemeados: string[] = [];
const etapasSemeadas: string[] = [];
const conversasSemeadas: string[] = [];
const contatosSemeados: string[] = [];
const canaisSemeados: string[] = [];

/** O dia 15 do mês que vem, em `YYYY-MM-DD` — cai na Previsão como um mês. */
function diaDoMesQueVem(): string {
  const hoje = new Date();
  return new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 15))
    .toISOString()
    .slice(0, 10);
}

test.beforeAll(async () => {
  const c = credsDaOrganizacao();
  const donoId = c.users.admin!.id;

  // O funil que a Previsão lê: o mesmo critério de `/api/v1/pipelines/default`.
  const { data: funil, error: erroDoFunil } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", c.org_id)
    .eq("is_archived", false)
    .order("is_default", { ascending: false })
    .order("position", { ascending: true })
    .limit(1)
    .single();
  if (erroDoFunil || !funil) throw new Error(`funil padrão: ${erroDoFunil?.message ?? "nenhum"}`);
  const funilId = (funil as { id: string }).id;

  // Etapa com chance de fechamento: sem ela o negócio cai no balde "sem
  // probabilidade" (um parágrafo), e a tabela de meses — o que estoura — não
  // aparece. Nenhuma etapa nasce calibrada (`win_probability` é nulo por padrão).
  const etapaComChance = await insere("crm_stages", {
    organization_id: c.org_id,
    pipeline_id: funilId,
    name: `Previsao ${MARCA}`,
    slug: `previsao-${MARCA}`,
    position: 999_999,
    win_probability: 50,
  });
  etapasSemeadas.push(etapaComChance);

  // O ganho: um funil só tem UMA etapa de ganho ativa (`uniq_crm_stages_pipeline_won`);
  // usa a que existe e só cria quando não há.
  const { data: ganha } = await admin
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", funilId)
    .eq("is_won", true)
    .eq("is_archived", false)
    .maybeSingle();
  let etapaGanha = (ganha as { id: string } | null)?.id;
  if (!etapaGanha) {
    etapaGanha = await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: funilId,
      name: `Ganho ${MARCA}`,
      slug: `ganho-${MARCA}`,
      position: 1_000_000,
      is_won: true,
    });
    etapasSemeadas.push(etapaGanha);
  }

  negociosSemeados.push(
    await insere("crm_leads", {
      organization_id: c.org_id,
      pipeline_id: funilId,
      stage_id: etapaComChance,
      title: `Previsao no celular ${MARCA}`,
      value_cents: 123_456_789,
      currency: "BRL",
      expected_close_date: diaDoMesQueVem(),
      owner_user_id: donoId,
    }),
  );
  // `trg_crm_lead_close_on_stage` fecha como ganho (status e `closed_at`) ao
  // nascer na etapa de ganho: é o que `fn_attendant_metrics` conta.
  negociosSemeados.push(
    await insere("crm_leads", {
      organization_id: c.org_id,
      pipeline_id: funilId,
      stage_id: etapaGanha,
      title: `Ganho no celular ${MARCA}`,
      value_cents: 50_000,
      currency: "BRL",
      owner_user_id: donoId,
    }),
  );

  // "Por canal" só desenha a tabela quando `fn_channel_metrics` acha conversa
  // atribuída com canal na janela (30 dias, por `assigned_at`). O banco do CI não
  // garante uma, e sem ela a asserção do cartão de "Por canal" não teria o que
  // medir: a semente a garante, e a asserção cobra a presença.
  const canal = await insere("channel_sessions", {
    organization_id: c.org_id,
    waha_session_name: `celular-cabe-${MARCA}`,
    display_name: `Canal celular ${MARCA}`,
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  canaisSemeados.push(canal);
  const contato = await insere("contacts", {
    organization_id: c.org_id,
    name: `Contato celular ${MARCA}`,
    phone_number: `+55119${MARCA}0`,
  });
  contatosSemeados.push(contato);
  conversasSemeadas.push(
    await insere("conversations", {
      organization_id: c.org_id,
      contact_id: contato,
      channel_session_id: canal,
      status: "open",
      assigned_to_user_id: donoId,
      assigned_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
    }),
  );
});

/**
 * Filhos antes de pais: `crm_leads.stage_id` é ON DELETE RESTRICT, e a conversa
 * aponta para o contato e para o canal. Cada delete tem o `error` conferido: uma
 * sobra aqui é a etapa "Previsao <marca>" virando coluna no funil padrão que as
 * outras specs da parte 6 usam — ela tem de aparecer no run, não sumir calada.
 */
test.afterAll(async () => {
  const falhas: string[] = [];
  const apagar = async (tabela: string, ids: string[]) => {
    if (!ids.length) return;
    const { error } = await admin.from(tabela).delete().in("id", ids);
    if (error) falhas.push(`${tabela} (${ids.join(", ")}): ${error.message}`);
  };
  await apagar("crm_leads", negociosSemeados);
  await apagar("crm_stages", etapasSemeadas);
  await apagar("conversations", conversasSemeadas);
  await apagar("contacts", contatosSemeados);
  await apagar("channel_sessions", canaisSemeados);
  if (falhas.length) throw new Error(`a limpeza da semente deixou sobra:\n${falhas.join("\n")}`);
});

/** Quanto o conteúdo passa da janela: o `body` OU o `<main>` (ver o cabeçalho). */
async function medirEstouro(page: Page): Promise<{ body: number; main: number; janela: number }> {
  return page.evaluate(() => {
    const principal = document.querySelector<HTMLElement>("main");
    return {
      // ⚠️ `body.scrollWidth`, NUNCA `documentElement.scrollWidth` — ver o
      // cabeçalho deste arquivo. A escolha errada aqui faz o gate medir zero.
      body: document.body.scrollWidth - document.documentElement.clientWidth,
      main: principal ? principal.scrollWidth - principal.clientWidth : 0,
      janela: document.documentElement.clientWidth,
    };
  });
}

/** Espera a largura do `body` e a do `<main>` pararem de mudar — fim das transições. */
async function estabilizar(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const janela = window as unknown as { __larguraAnterior?: string; __quietos?: number };
      const agora = `${document.body.scrollWidth}:${document.querySelector("main")?.scrollWidth ?? 0}`;
      if (janela.__larguraAnterior === agora) {
        janela.__quietos = (janela.__quietos ?? 0) + 1;
      } else {
        janela.__quietos = 0;
        janela.__larguraAnterior = agora;
      }
      return (janela.__quietos ?? 0) >= 3;
    },
    undefined,
    { timeout: 15_000, polling: 120 },
  );
}

async function abrir(page: Page, rota: string): Promise<void> {
  await page.goto(rota);
  await page.waitForLoadState("networkidle").catch(() => {});
  await estabilizar(page);
}

/**
 * A reserva publicada no `<html>` e o que o `<main>` desconta de verdade.
 *
 * As três leituras juntas, e não só a variável: `--rodape-ocupado` é o número que
 * o contrato publica, `data-rodape-ocupado` é o mesmo número pelo atributo (o
 * jsdom não computa `var()`, é por ali que o resto da suíte mede), e
 * `padding-bottom` calculado é o que a PESSOA vê — `max(24px, env(...), var(...))`.
 * Uma variável certa com o `padding-bottom` preso continuaria sendo o defeito.
 */
async function medirODescontoDoRodape(page: Page) {
  return page.evaluate(() => {
    const principal = document.querySelector<HTMLElement>("main");
    const barra = document.querySelector<HTMLElement>("nav[data-barra-inferior]");
    return {
      variavel: document.documentElement.style.getPropertyValue("--rodape-ocupado").trim(),
      atributo: principal?.dataset.rodapeOcupado ?? null,
      descontado: principal ? Math.round(parseFloat(getComputedStyle(principal).paddingBottom)) : -1,
      alturaDaBarra: barra ? Math.round(barra.getBoundingClientRect().height) : -1,
    };
  });
}

/**
 * Espera o rodapé ACOMODAR — e o valor esperado NÃO entra aqui de propósito.
 *
 * Esperar pelo valor que se quer medir seria fé: o `waitForFunction` retornaria
 * no instante em que o valor aparecesse, e o `expect` seguinte provaria a espera,
 * não o produto. O que esta espera exige é outra coisa: três leituras iguais e ao
 * menos 600 ms desde a última mudança. O `ResizeObserver` avisa o hook no quadro
 * seguinte ao `setViewportSize`, então medir antes disso mediria o estado
 * ANTERIOR à transição — falso vermelho numa direção e falso verde na outra.
 */
async function esperarORodapeAcomodar(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const janela = window as unknown as { __rodape?: string; __quieto?: number; __desde?: number };
      const agora = document.documentElement.style.getPropertyValue("--rodape-ocupado").trim();
      if (janela.__rodape !== agora) {
        janela.__rodape = agora;
        janela.__quieto = 0;
        janela.__desde = Date.now();
      } else {
        janela.__quieto = (janela.__quieto ?? 0) + 1;
      }
      return (janela.__quieto ?? 0) >= 3 && Date.now() - (janela.__desde ?? Date.now()) >= 600;
    },
    undefined,
    { timeout: 15_000, polling: 120 },
  );
}

const creds = lerCreds();

/**
 * As tabelas de `components/ui/table.tsx` cuja caixa rola para o lado. Essa caixa
 * tem `overflow-auto` própria, então a tabela larga NÃO alarga o `<main>` e a
 * régua de estouro não a vê (ver o cabeçalho): é aqui que o cartão se prova.
 * Devolve o cabeçalho de cada uma, para o log dizer QUAL rola.
 */
async function tabelasQueRolamNaPropriaCaixa(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLTableElement>("main table"))
      .map((tabela) => ({ tabela, caixa: tabela.parentElement }))
      .filter(({ caixa }) => caixa?.classList.contains("overflow-auto"))
      .filter(({ caixa }) => caixa!.scrollWidth - caixa!.clientWidth > 1)
      .map(({ tabela }) => (tabela.querySelector("thead")?.textContent ?? "").trim().slice(0, 60)),
  );
}

/**
 * O ranking por atendente e o "Por canal" (os dois semeados, então SEMPRE
 * presentes) viram cartão a 390px: o cabeçalho some. O texto procurado vale em
 * português e em espanhol.
 */
async function conferirOsCartoesDoPainel(page: Page): Promise<void> {
  const ranking = page.locator("main table", { has: page.locator("th", { hasText: /mediana/ }) });
  await expect(ranking, "o ranking semeado não apareceu no painel").toHaveCount(1);
  expect(
    await ranking.locator("thead").evaluate((el) => getComputedStyle(el).display),
    "o cabeçalho do ranking continua à vista a 390px: a linha não virou cartão",
  ).toBe("none");

  const canais = page.locator("main table", {
    has: page.locator("th", { hasText: /Sem resposta|Sin respuesta/ }),
  });
  await expect(canais, "o Por canal semeado não apareceu no painel").toHaveCount(1);
  expect(
    await canais.locator("thead").evaluate((el) => getComputedStyle(el).display),
    "o cabeçalho de Por canal continua à vista a 390px",
  ).toBe("none");
}

test("as superfícies não estouram a tela em 360 nem em 390px", async ({ page }) => {
  await loginComoAdmin(page, creds);

  const estouros: string[] = [];
  for (const largura of LARGURAS) {
    await page.setViewportSize({ width: largura, height: 844 });
    for (const { rota, nome } of SUPERFICIES) {
      await abrir(page, rota);
      const { body, main, janela } = await medirEstouro(page);
      await page.screenshot({ path: path.join(EVIDENCE, `${largura}-${nome}.png`) });
      // Tolerância de 1px para arredondamento de subpixel, e não mais: o defeito
      // que isto pega mede dezenas ou centenas de pixels (476px na tela do
      // agente, 214px no painel da agenda).
      const estouro = Math.max(body, main);
      if (estouro > 1) {
        estouros.push(`${rota} em ${largura}px: passa ${estouro}px de ${janela} (body ${body}, main ${main})`);
      }
      if (nome === "painel" || nome === "relatorios") {
        for (const tabela of await tabelasQueRolamNaPropriaCaixa(page)) {
          estouros.push(`${rota} em ${largura}px: a tabela "${tabela}" rola para o lado dentro da própria caixa`);
        }
      }
      if (nome === "painel" && largura === 390) await conferirOsCartoesDoPainel(page);
    }
  }

  expect(
    estouros,
    "o excedente NÃO ganha barra de rolagem neste produto (overflow-x: clip): ele some pela direita",
  ).toEqual([]);
});

test("nenhum controle do painel fica abaixo de 44px de altura em 360px", async ({ page }) => {
  // O PAINEL, e não as quatro superfícies, e o motivo é honestidade de régua.
  //
  // Na medição desta entrega o painel fechou em ZERO controles curtos, e é a
  // única das quatro em que isso é verdade — então é a única em que uma
  // asserção de "nenhum" não nasce com exceção. Nas outras três sobram casos
  // LEGÍTIMOS que esta régua acusaria: links de texto dentro de lista no funil
  // (um link de 21px de altura não é alvo de 44px, é texto), e as células de
  // meia hora da agenda, cuja densidade é decisão registrada em
  // `components/agenda/GradeDaAgenda.tsx` ("sete colunas em 360px dão ~44px
  // cada, e a célula de meia hora vira um alvo de ~44x24").
  //
  // Um gate que nasce com três exceções ensina a ignorar o gate. Este nasce com
  // uma superfície limpa e uma catraca: se o painel regredir, reprova.
  await loginComoAdmin(page, creds);
  await page.setViewportSize({ width: 360, height: 844 });
  await abrir(page, "/app/metrics");

  // O "Salvar" da régua de abandono só aparece com o campo alterado, e era ele
  // o controle de 28px (`h-7` derrubava o `h-11` do botão). Sem alterar o
  // campo, este caso media o painel SEM o botão. Não salva: só faz aparecer.
  const regua = page.locator('main input[inputmode="numeric"]');
  await expect(regua, "o campo da régua de abandono não está no painel").toHaveCount(1);
  const botoes = page.locator("main button");
  const antes = await botoes.count();
  const horas = Number(await regua.inputValue());
  await regua.fill(String(horas >= 2160 ? horas - 1 : horas + 1));
  await expect.poll(() => botoes.count(), { message: "o Salvar da régua não apareceu" }).toBe(antes + 1);

  const curtos = await page.evaluate((piso) => {
    const fora: Array<{ marca: string; texto: string; w: number; h: number }> = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      'a[href], button, [role="button"], input, select, textarea',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const estilo = getComputedStyle(el);
      if (estilo.visibility === "hidden" || estilo.display === "none") continue;
      // Link de TEXTO dentro de parágrafo ou lista não é alvo de 44px: ele é
      // texto, e a régua da HIG é para controle. Reconhecido por não ter fundo
      // próprio.
      if (el.tagName === "A" && estilo.backgroundColor === "rgba(0, 0, 0, 0)") continue;
      if (r.height >= piso) continue;
      fora.push({
        marca: el.tagName.toLowerCase(),
        texto: (el.textContent ?? "").trim().slice(0, 30),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    return fora;
  }, PISO_DE_TOQUE);

  expect(
    curtos,
    `controles com menos de ${PISO_DE_TOQUE}px de ALTURA em 360px — ` +
      `princípio 4 de docs/design-system/screen-flow/07-responsive-strategy.md`,
  ).toEqual([]);
});

test("a barra de abas ocupa rodapé no celular e NADA no desktop", async ({ page }) => {
  await loginComoAdmin(page, creds);

  // ── no celular: existe, encosta no fundo, e o conteúdo desconta ────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await abrir(page, "/app/kanban");

  await expect(page.locator("nav[data-barra-inferior]")).toBeVisible();
  const noCelular = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>("nav[data-barra-inferior]");
    const principal = document.querySelector<HTMLElement>("main");
    if (!nav || !principal) return null;
    const r = nav.getBoundingClientRect();
    return {
      altura: Math.round(r.height),
      folgaAteOFundo: Math.round(window.innerHeight - r.bottom),
      descontado: Math.round(parseFloat(getComputedStyle(principal).paddingBottom)),
    };
  });

  expect(noCelular).not.toBeNull();
  // Encosta no fundo: é barra de abas, não painel flutuante.
  expect(noCelular!.folgaAteOFundo).toBe(0);
  expect(noCelular!.altura).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
  // E o `<main>` desconta pelo menos o que ela mede. É o contrato de
  // `lib/ui/rodape-ocupado.tsx` fechando o laço: sem ele, o fim de toda lista
  // ficava POR BAIXO das abas — o defeito da #1305 numa peça nova.
  expect(noCelular!.descontado).toBeGreaterThanOrEqual(noCelular!.altura);

  // ── no desktop: some, e o rodapé NÃO perde faixa por ela ───────────────────
  //
  // O CONTROLE NEGATIVO, e ele pega um defeito que existiu antes de a medição
  // acontecer: a barra é escondida por CSS (`md:hidden`), então no laptop ela
  // continua no DOM. Enquanto declarava `altura: 56` como piso, o contrato
  // reservava 56px de rodapé numa tela em que a barra não aparece — e o Inbox e
  // o quadro do funil, que leem a mesma variável para calcular a própria
  // altura, encolhiam junto. Hoje a `altura` declarada é 0 e quem decide é a
  // medição, que devolve zero para elemento escondido.
  await page.setViewportSize({ width: 1440, height: 900 });
  await abrir(page, "/app/kanban");

  await expect(page.locator("nav[data-barra-inferior]")).toBeHidden();
  const reserva = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--rodape-ocupado").trim(),
  );
  expect(reserva === "" || reserva === "0px").toBe(true);
});

/**
 * A TRANSIÇÃO NA MESMA PÁGINA — o caso que o teste de cima NÃO mede.
 *
 * ═══ O buraco do caso anterior, medido ═══════════════════════════════════════
 *
 * O caso de `:203` alarga para 1440 e chama `abrir(page, "/app/kanban")`, que é
 * um `page.goto` (`:119`): recarrega. Mede a PRIMEIRA carga no desktop, que
 * sempre funcionou — a barra nasce escondida, mede zero e a reserva fica em zero.
 * A transição estreito → largo na mesma página nunca foi medida, e é justamente
 * onde o defeito mora: com uma medida positiva já guardada (54 px, a barra à
 * vista), o `ResizeObserver` entrega o zero do `display: none` e o hook o
 * descarta. `--rodape-ocupado` fica preso em 54 px e o `<main>` desconta 54 px de
 * rodapé para uma barra que não está na tela — 30 px vazios, e o Inbox e o funil,
 * que leem a mesma variável, encolhem junto.
 *
 * ═══ Por que a régua é o `padding-bottom` calculado ══════════════════════════
 *
 * A variável é o número que o contrato publica; o `padding-bottom` é o que a
 * pessoa perde. Medir só a variável deixaria passar uma casca que publica `0px` e
 * continua descontando `54px` por outra via — `max(24px, env(...), var(...))` é a
 * expressão de verdade, e é ela que este caso calcula no navegador.
 *
 * ═══ Sem `goto` e sem `reload` entre as duas medidas ═════════════════════════
 *
 * É a condição que faz este caso medir a transição: qualquer recarga zeraria o
 * `alturaMedida` do hook, que é exatamente o que o defeito precisa que exista.
 */
test("ao alargar a janela SEM recarregar, a barra que sai de vista devolve o rodapé ao piso", async ({
  page,
}) => {
  await loginComoAdmin(page, creds);

  // ── ESTREITO: a barra está à vista e a reserva é o que ela mede ────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await abrir(page, "/app/kanban");
  await expect(page.locator("nav[data-barra-inferior]")).toBeVisible();
  await esperarORodapeAcomodar(page);

  const estreito = await medirODescontoDoRodape(page);
  expect(estreito.alturaDaBarra, "a barra de abas não está à vista em 390px").toBeGreaterThanOrEqual(
    PISO_DE_TOQUE,
  );
  // CONTROLE (o mesmo do caso de cima): estreito, a reserva continua valendo o
  // que a barra mede, e o `<main>` desconta pelo menos isso.
  expect(estreito.variavel).toBe(`${estreito.alturaDaBarra}px`);
  expect(estreito.descontado).toBeGreaterThanOrEqual(estreito.alturaDaBarra);

  // ── ALARGA A MESMA PÁGINA — sem `abrir`, sem `goto`, sem `reload` ──────────
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("nav[data-barra-inferior]")).toBeHidden();
  await esperarORodapeAcomodar(page);

  const largo = await medirODescontoDoRodape(page);
  // A barra saiu de vista: a medida dela é zero e o hook tem de gravar esse zero.
  expect(largo.alturaDaBarra).toBe(0);
  expect(
    largo.variavel === "" || largo.variavel === "0px",
    `--rodape-ocupado ficou preso em ${largo.variavel || "(vazio)"} depois de a barra sair de vista`,
  ).toBe(true);
  expect(largo.atributo, "o <main> continua descontando a barra que sumiu").toBe("0");
  // E o que a pessoa vê: o piso do `p-6` da casca, não os 54px da barra.
  expect(largo.descontado).toBe(24);

  // As quatro medidas das duas larguras no log do run: é o número que o artefato
  // da issue cita (variável, atributo, `padding-bottom` calculado e a altura da
  // barra), e sem ele o verde não diria QUANTO foi medido.
  // eslint-disable-next-line no-console
  console.log(`[rodape-3061] estreito=${JSON.stringify(estreito)} largo=${JSON.stringify(largo)}`);
});
