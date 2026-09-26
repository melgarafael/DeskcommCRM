import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect } from "./helpers/test";

import { escolherDiaDesenhado, irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";

/**
 * A PROVA EM TELA DA FRENTE 1 (API + motor) — agora ESCRITA, e o caminho até aqui
 * é o registro que interessa.
 *
 * ─── Este arquivo foi um DESLIGADOR por engano ────────────────────────────
 *
 * Ele nasceu como `test.skip` com a condição de saída escrita no cabeçalho:
 * *"o que falta para deixar de ser skip: a tela de marcar consumindo
 * `GET /api/v1/agenda/horarios-livres` e o POST de criação"*. Declarar a
 * condição foi a coisa certa a fazer — e **ninguém volta para conferir se ela
 * venceu**. As duas metades já estavam cumpridas quando isto foi medido:
 *
 *   grep -n "^export async function" app/api/v1/agenda/agendamentos/route.ts
 *   # GET:95  POST:145  PATCH:149  DELETE:153
 *   grep -rn "horarios-livres|useHorariosLivres" app/app/agenda components/agenda hooks/agenda | wc -l
 *   # 6
 *
 * E havia um segundo desligador junto, do mesmo tipo: `hooks/agenda/useAgendamentos.ts`
 * existia inteiro, bem escrito, e tinha **1 ocorrência no repo — a própria
 * definição**. Controle da mesma sonda: os hooks irmãos, 3. A grade não se
 * atualizava sozinha porque ninguém montou o hook, e três comentários no código
 * afirmavam que o `GET` "não foi escrito (medido)" — prosa verdadeira no dia em
 * que foi escrita, vencida depois.
 *
 * ─── O que esta spec prova, e o que ela AINDA não prova ───────────────────
 *
 * O cabeçalho antigo prometia quatro asserções. Estão escritas duas, e as outras
 * duas ficam nomeadas aqui em vez de sumirem em silêncio — promessa que encolhe
 * sem aviso é como a condição de saída acima virou desligador.
 *
 *   [✓] 1. Marcar pela tela faz o compromisso aparecer na grade SEM F5.
 *          É a asserção que o hook órfão bloqueava. Não há `reload()` nesta
 *          spec de propósito: recarregar provaria o servidor, não a tela.
 *   [✓] 2. A grade desenha o horário no fuso de APRESENTAÇÃO. Provado pelo par:
 *          o rótulo escolhido no painel tem de reaparecer na grade. Se a grade
 *          renderizasse em UTC (o fuso do contêiner em produção — `node:22-alpine`
 *          sem `tzdata`), os dois números divergiriam em três horas.
 *   [ ] 3. Bloqueio de dia inteiro deixa o dia sem horário E a tela diz POR QUÊ.
 *          Falta o fixture de bloqueio; `sem-jornada-publicada` já existe na tela.
 *   [ ] 4. Schedule mal configurado devolve 422 com motivo e a tela o mostra.
 *          Falta a rota devolver o motivo por um caminho que a tela leia.
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
    // ⚠️ A SPEC SEMEIA O QUE PRECISA, e isto não é conveniência.
    //
    // O workflow do CI não roda `seed-e2e-agenda.ts` nos passos — quem o roda é
    // `agente-marca-consulta`, no `beforeAll` dela. Depender disso seria depender
    // da ORDEM de execução: a spec passaria por outra spec ter rodado antes, que
    // é exatamente o defeito que `agenda-tela-do-produto` já pagou nesta entrega
    // (ela só passava com o banco sujo de outra spec).
    //
    // O seed é idempotente, então chamá-lo aqui não atrapalha quem já o chamou.
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

/** Compromissos desenhados na grade — o `aria-label` traz "HH:mm às HH:mm". */
function cartoesDaGrade(page: import("@playwright/test").Page) {
  return page.getByTestId("grade-da-agenda").getByRole("button", { name: /\d{2}:\d{2} às \d{2}:\d{2}/ });
}

test("marcar um horário pela tela e vê-lo aparecer na grade — sem recarregar", async ({ page }) => {
  const creds = lerCreds();
  if (!creds.agenda) throw new Error(".e2e-creds.json sem o bloco `agenda` — rode `scripts/seed-e2e-agenda.ts`");

  // `manager`, e NÃO o primeiro da lista: o `admin` do seed tem MFA com challenge,
  // e esta spec não é sobre login. Mesmo motivo do molde `agente-marca-consulta`.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");

  // DIAGNÓSTICO PERMANENTE. Quando esta spec falha em "nenhum dia com vaga", a
  // pergunta seguinte é sempre a mesma — o que a ROTA respondeu? — e responder
  // custou uma caçada inteira da primeira vez. Fica gravado.
  const respostas: string[] = [];
  page.on("response", (r) => {
    const eAgenda =
      r.url().includes("/api/v1/agenda/horarios-livres") ||
      r.url().includes("/api/v1/agenda/agendamentos");
    if (!eAgenda) return;
    void r
      .text()
      .then((t) => respostas.push(`${r.status()} ${r.request().method()} ${r.url().split("/api/v1/agenda/")[1]?.split("?")[0]} ${t.slice(0, 300)}`))
      .catch(() => respostas.push(`${r.status()} <corpo ilegível>`));
  });

  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });

  await page.goto("/app/agenda");
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 20_000 });

  // ⚠️ A SEMANA SEGUINTE, e ela é a condição de o caso poder passar.
  //
  // A asserção final desta spec é `faixa-<id>` DESENHADO NA GRADE — e a grade
  // desenha uma semana só. Enquanto o painel escolhia "o primeiro dia com vaga"
  // e a grade ficava na semana de hoje, os dois falavam de períodos diferentes
  // assim que hoje esgotava: depois das 17h o painel oferecia a segunda-feira, o
  // compromisso nascia na semana seguinte, e a grade — parada na semana de sexta
  // — nunca o desenhava. A falha lia "a grade não repinta sem F5", acusando o
  // produto de um defeito que era do período escolhido pelo teste.
  //
  // Navegando primeiro, alvo e grade passam a sair da MESMA fonte: os dias que
  // a tela desenhou. Tabela medida em `helpers/agenda-semana-integra`.
  const diasDaSemana = await irParaASemanaSeguinte(page);

  const antes = await cartoesDaGrade(page).count();

  // ── marcar, pela tela, como um humano faria ────────────────────────────
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 10_000 });

  // ESCOLHER O TIPO — e este bloco existe porque a spec o achou faltando.
  //
  // `_client.tsx` tinha `const tipo = tiposIniciais[0] ?? null`: uma CONSTANTE,
  // sem seletor em lugar nenhum. E `page.tsx` ordena os tipos por NOME, então a
  // tela marcava sempre o primeiro em ordem alfabética. Medido nesta org, que
  // tem quatro tipos ativos: "Atendimento", "Consulta", "Consulta E2E", "Reunião"
  // — só "Atendimento" era alcançável pela tela, e nenhum teste percebia porque
  // nenhum teste marcava pela tela.
  //
  // Escolher o tipo do seed (e NÃO o primeiro) é o que dá valor a esta asserção:
  // se o seletor sumir, o painel volta a "Atendimento" e o horário marcado deixa
  // de casar com a jornada do tipo do seed.
  await expect(page.getByTestId("tipos-de-agendamento")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: new RegExp(`^${creds.agenda.tipo_nome}`) }).click();

  try {
    await escolherDiaDesenhado(page, diasDaSemana);
  } catch (erro) {
    // A mensagem do `expect` é avaliada ANTES de a asserção rodar, então ela não
    // pode carregar o que a rota respondeu. Enriquecer no catch é o que permite
    // à falha trazer a causa junto, em vez de mandar a próxima pessoa caçar.
    throw new Error(
      `nenhum dia com vaga no painel. O que a rota de horários respondeu:\n` +
        (respostas.length ? respostas.join("\n") : "  (a rota NÃO foi chamada)") +
        `\n\n${(erro as Error).message}`,
    );
  }

  const horario = page.locator('[data-testid^="horario-"]').first();
  await expect(horario, "o dia foi escolhido e não veio horário nenhum").toBeVisible({ timeout: 15_000 });
  const rotulo = (await horario.getAttribute("data-testid"))!.replace("horario-", "");
  await horario.click();

  // `confirmacao` é o bloco que aparece ao ESCOLHER o horário — ele contém o
  // próprio botão de confirmar. Depois do clique o painel troca para a vista de
  // sucesso, e é `ver-na-agenda` que prova que a marcação foi aceita.
  await expect(page.getByTestId("confirmacao")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("confirmar-marcacao").click();
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible({ timeout: 15_000 });

  // ⚠️ `ver-na-agenda` aparece por estado LOCAL do React — `onClick` faz
  // `setMarcado(horario)` ANTES de a mutação responder. Então a tela dizer
  // "marcado" não é prova de nada, e esta asserção existe para separar as duas
  // coisas: o POST tem de ter respondido 2xx.
  try {
    await expect
      // ⚠️ `includes("agendamentos")` sozinho casava também o GET que o
      // `useAgendamentos` dispara — a asserção passava pelo verbo errado e eu
      // quase concluí que o POST tinha funcionado. O método entra no filtro.
      .poll(() => respostas.filter((r) => /^2\d\d POST agendamentos/.test(r)).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
  } catch (erro) {
    throw new Error(
      "a tela disse que marcou e o POST não respondeu 2xx. Respostas da agenda:\n" +
        (respostas.length ? respostas.join("\n") : "  (nenhuma)") +
        `\n\n${(erro as Error).message}`,
    );
  }

  // ── e agora o ponto inteiro: SEM `page.reload()` ───────────────────────
  //
  // Recarregar provaria que o POST gravou — que é o servidor, e o
  // `agente-marca-consulta` já prova. O que só esta spec pode provar é que a
  // TELA repinta: `useMarcarAgendamento` invalida `["agenda"]` e o
  // `useAgendamentos` refaz a busca. Enquanto o hook esteve órfão, este bloco
  // ficava em `antes` para sempre.
  // ⚠️ CONTAR CARTÕES ERA UM PROXY, E O PROXY MENTIA. A janela desta grade tem
  // 17 linhas (2 confirmadas, 15 canceladas de execuções anteriores) e a grade
  // empilha sobreposições — a contagem ficava em 16 antes e depois, com o POST
  // devolvendo 201 e o GET seguinte trazendo a linha nova. Eu quase concluí que
  // a repintura não acontecia, quando o que não servia era a régua.
  //
  // A identidade está disponível e é exata: o POST devolve o `id`, e a grade
  // marca cada cartão com `faixa-<id>`. Perguntar pelo ID responde "este
  // compromisso está desenhado?", que é a pergunta; contar responde "quantos
  // há?", que nunca foi.
  const criado = respostas.find((r) => r.startsWith("201 POST agendamentos"));
  const idCriado = criado?.match(/"id":"([0-9a-f-]{36})"/)?.[1];
  expect(idCriado, `o POST não devolveu id. Respostas:\n${respostas.join("\n")}`).toBeTruthy();

  await expect(
    page.getByTestId(`faixa-${idCriado}`),
    "o compromisso nasceu no banco e a grade não o desenhou sem F5 — " +
      "`useMarcarAgendamento` invalida `[\"agenda\"]` e `useAgendamentos` deveria refazer a busca",
  ).toBeAttached({ timeout: 20_000 });

  // CONTROLE DA SONDA, e ele mudou junto com a régua: contar deixou de servir,
  // então o controle não pode ser sobre contagem. O que precisa ser provado é
  // que `getByTestId("faixa-<id>")` DISTINGUE — um id que não existe tem de dar
  // zero. Sem isto, um seletor quebrado casaria qualquer coisa (ou nada) e a
  // asserção acima passaria por vacuidade.
  await expect(
    page.getByTestId("faixa-00000000-0000-4000-8000-000000000000"),
    "a sonda de identidade casa um id inexistente — ela não distingue nada",
  ).toHaveCount(0);

  // ── asserção 2: o fuso é o de APRESENTAÇÃO, não o do servidor ──────────
  //
  // Pelo CARTÃO DO ID CRIADO, não por contagem num horário: há cancelados de
  // execuções anteriores no mesmo minuto, e `toHaveCount(1)` falhava por isso —
  // a terceira vez nesta spec em que a régua, e não o produto, estava errada.
  //
  // O rótulo escolhido no painel tem de aparecer no nome acessível do cartão. Em
  // produção o contêiner roda em UTC (`node:22-alpine` sem `tzdata`, serviço
  // `app` sem `TZ`), então uma grade que desenhasse no fuso do SERVIDOR
  // divergiria em três horas para `America/Sao_Paulo` — e este par não bateria.
  const cartaoCriado = page.locator(`button:has([data-testid="faixa-${idCriado}"])`);
  await expect(
    cartaoCriado,
    `o horário ${rotulo} foi marcado e o cartão dele não anuncia esse horário`,
  ).toHaveAttribute("aria-label", new RegExp(`${rotulo} às`), { timeout: 10_000 });

  // LIMPEZA. Sem isto, cada corrida deixa um compromisso e o horário escolhido
  // avança 30min — foi assim que eu PROVEI que a spec faz trabalho de verdade
  // (13:00, 13:30, 14:00 em três corridas), e é exatamente por isso que ela não
  // pode continuar assim: uma cerca que consome a agenda vai ficar sem vaga.
  //
  // `page.request` reusa os cookies da sessão logada, então o DELETE passa pelo
  // mesmo caminho de autorização que um humano — não por service role.
  const apagou = await page.request.delete("/api/v1/agenda/agendamentos", {
    data: { id: idCriado, reason: "limpeza da spec de marcar pela tela" },
  });
  expect(
    apagou.ok(),
    `a spec não conseguiu cancelar o que criou (${apagou.status()}): a agenda vai encher a cada corrida`,
  ).toBe(true);
});
