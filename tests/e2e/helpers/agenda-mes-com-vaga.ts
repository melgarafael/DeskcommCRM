import { expect, type Page } from "@playwright/test";

/**
 * O RECORTE DE MÊS — o mini-calendário do painel escolhido pelo CONTEÚDO da
 * tela, nunca pelo relógio nem pela boa vontade do painel em avançar sozinho.
 *
 * ═══ O defeito que este módulo existe para fechar ═══════════════════════════
 *
 * Em 2026-10-30 o `e2e-parte (2)` de TODOS os PRs reprovou com nove casos de
 * agenda (`agenda-marcar-pela-tela`, `agenda-painel-cabe-na-tela`,
 * `agenda-remarcar-e-cancelar`, `agenda-ver-na-agenda`), todos na MESMA linha
 * dos helpers da semana:
 *
 *     expect(locator).toBeVisible() failed
 *     Locator: locator('[data-testid^="dia-"][data-disponivel="true"]')
 *     Timeout: 20000ms / Error: element(s) not found
 *
 * O trace do job 124255171221 mostra o estado da tela no instante da falha:
 * `text: outubro de 2026`, os 31 dias do mês apagados, e — o detalhe que
 * denuncia a causa — os dias 30 e 31 ainda CLICÁVEIS, pelo encaixe
 * (`soEncaixe`, "nenhum horário publicado neste dia"). Ou seja: o painel não
 * estava carregando, estava **parado num mês que acabou**.
 *
 * Medido com o motor real (`lib/agenda/horarios-livres.ts`), com o seed do
 * `scripts/seed-e2e-agenda.ts` (seg–sex 09:00–18:00, America/Sao_Paulo, 30 min,
 * aviso mínimo de 60 min, janela de 60 dias), contando os dias DO MÊS em tela
 * que têm ao menos um horário livre às 20:00 BRT de 30/10/2026:
 *
 *     agora                     mês em tela    dias com vaga > 0   horários
 *     2026-10-30 20:00 BRT      outubro        0 de 31              0
 *     2026-10-30 20:00 BRT      novembro      21 de 30            396
 *
 * (O número de novembro é 21 e não 22 porque a janela do mês vai até
 * `endOfMonth + 1 dia` e acende 01/12: contar a PONTA como vaga do mês é o mesmo
 * erro que o painel já corrigiu com `mesCarregado`.)
 *
 * Outubro não tem NENHUM dia com vaga: 30/10 é o resto de um dia útil já gasto,
 * 31/10 é sábado (a jornada é seg–sex). A semana, o helper irmão
 * (`agenda-semana-integra`) já tinha aprendido a resolver isso navegando para a
 * semana seguinte; o MÊS ficou dependente de uma única tentativa do produto.
 *
 * ═══ A abertura no mês com vaga é AFIRMADA, não contornada ═══════════════════
 *
 * O produto TEM a regra (`components/agenda/PainelDeMarcacao.tsx`: "A ABERTURA
 * NÃO CAI NUM MÊS QUE ACABOU" — mês de abertura sem nenhum horário publicado,
 * com jornada publicada, passa ao mês seguinte). Em 30/10 ela FALHAVA: a decisão
 * era tomada uma vez por montagem, a tela abre no primeiro tipo (que pode não ter
 * jornada) e a resposta dele gastava a decisão; o tipo escolhido depois chegava
 * com outubro esgotado e ficava nele. Defeito de produto, consertado no #3771.
 *
 * Um helper que só NAVEGASSE até o mês com vaga teria deixado a suíte verde por
 * cima desse defeito. Por isso `exigirMesDeAberturaComVaga` é o primeiro passo de
 * quem escolhe dia: se a regra regredir, o caso reprova dizendo qual regra.
 *
 * ═══ A regra que estas funções encarnam ═════════════════════════════════════
 *
 * 1. O mês em tela é LIDO DA TELA (`data-testid="dia-<yyyy-MM-dd>"`), não
 *    inferido do relógio do Node nem do rótulo do cabeçalho — que é
 *    `MMMM 'de' yyyy` e depende do idioma da organização.
 * 2. Quem precisa de um dia SABE de que mês ele é: a semana desenhada pela grade
 *    diz o mês, e o painel é NAVEGADO até lá. Não se espera que ele adivinhe.
 * 3. Quem só precisa de "um dia com vaga daqui para frente" aceita qualquer
 *    mês, mas avança quando o mês em tela acabou — em vez de reprovar.
 *
 * Nada aqui alarga o seed, pula caso ou aumenta teto de teste: o recorte é que
 * passa a ser garantido.
 */

/** O teto que o repo usa para uma resposta da consulta de horários. */
const ESPERA_DA_CONSULTA = 20_000;

/** Quantos meses o helper percorre antes de declarar que não há vaga. */
const MESES_PERCORRIDOS = 2;

const dois = (n: number) => String(n).padStart(2, "0");

/** `"2026-10-30"` → `"2026-10"`. */
export function mesDaChave(chave: string): string {
  return chave.slice(0, 7);
}

/**
 * O mês que a grade do mini-calendário está desenhando — derivado dos PRÓPRIOS
 * dias, sem ler rótulo.
 *
 * `semanas` começa no domingo anterior (ou igual) ao dia 1º
 * (`startOfWeek(startOfMonth(mes))`), então o dia 1º do mês visível está sempre
 * entre a primeira célula e a sétima: é só caminhar até achar o dia 1. Vale para
 * grade de 35 e de 42 células — outubro de 2026 tem 35.
 */
export function mesDoGrid(primeiroDiaDoGrid: string): string {
  const d = new Date(`${primeiroDiaDoGrid}T00:00:00Z`);
  for (let passo = 0; passo < 7 && d.getUTCDate() !== 1; passo++) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return `${d.getUTCFullYear()}-${dois(d.getUTCMonth() + 1)}`;
}

/** Meses inteiros de `de` até `para`: positivo avança, negativo volta. */
export function distanciaEmMeses(de: string, para: string): number {
  const [anoDe, mesDe] = de.split("-").map(Number) as [number, number];
  const [anoPara, mesPara] = para.split("-").map(Number) as [number, number];
  return anoPara * 12 + mesPara - (anoDe * 12 + mesDe);
}

/** O mês seguinte a `"2026-12"` é `"2027-01"` — aritmética, não Date. */
export function mesSeguinte(mes: string): string {
  const [ano, numero] = mes.split("-").map(Number) as [number, number];
  return numero === 12 ? `${ano + 1}-01` : `${ano}-${dois(numero + 1)}`;
}

/** Todas as chaves de dia que o calendário desenha, em ordem. */
async function chavesDoCalendario(page: Page): Promise<string[]> {
  const chaves = await page
    .locator('[data-testid^="dia-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.slice("dia-".length)));
  return chaves.sort();
}

/** O mês que o painel está mostrando AGORA, lido da grade dele. */
export async function mesVisivelNoPainel(page: Page): Promise<string> {
  const chaves = await chavesDoCalendario(page);
  expect(
    chaves.length,
    "o mini-calendário não desenhou dia nenhum — o painel de marcação não chegou a montar",
  ).toBeGreaterThanOrEqual(28);
  return mesDoGrid(chaves[0]!);
}

/**
 * Os dias do MÊS EM TELA que têm horário publicado (`data-disponivel="true"`).
 *
 * O filtro pelo mês não é zelo: o calendário desenha as pontas dos meses
 * vizinhos, e um dia de novembro pode aparecer na grade de outubro. Contar as
 * pontas como "outubro tem vaga" é o mesmo erro que fez o painel acender o dia
 * 1º com a sobra da janela do mês anterior.
 */
export async function diasComVagaNoMes(page: Page): Promise<string[]> {
  const mes = await mesVisivelNoPainel(page);
  const acesos = await page
    .locator('[data-testid^="dia-"][data-disponivel="true"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.slice("dia-".length)));
  return acesos.filter((chave) => mesDaChave(chave) === mes).sort();
}

/**
 * AFIRMA a regra de abertura do painel: o mês em que ele abriu tem ao menos um
 * dia com vaga. Chame logo depois de abrir o painel (ou de trocar de tipo), antes
 * de navegar — navegar primeiro esconderia exatamente o defeito do #3771.
 */
export async function exigirMesDeAberturaComVaga(page: Page): Promise<void> {
  await expect
    .poll(() => diasComVagaNoMes(page), {
      timeout: ESPERA_DA_CONSULTA,
      message:
        "o painel abriu num mês sem nenhum dia com vaga. A regra de `PainelDeMarcacao.tsx` " +
        '("A ABERTURA NÃO CAI NUM MÊS QUE ACABOU") manda passar ao mês seguinte quando o mês ' +
        "de abertura não tem horário publicado e a jornada existe — inclusive depois de trocar " +
        "de tipo (#3771). Se o seed publica jornada, isto é defeito de PRODUTO, não do teste.",
    })
    .not.toEqual([]);
}

/**
 * Leva o calendário até o mês `alvo`, conferindo na TELA cada passo.
 *
 * O `expect.poll` compara o mês lido DO DOM antes e depois do clique: é o mesmo
 * cuidado do `irParaASemanaSeguinte`, e pelo mesmo motivo — clicar e supor que a
 * tela obedeceu é o que transforma um defeito de produto numa falha de timeout.
 */
export async function irParaOMesDoPainel(page: Page, alvo: string): Promise<void> {
  for (let passo = 0; passo < 12; passo++) {
    const visivel = await mesVisivelNoPainel(page);
    const distancia = distanciaEmMeses(visivel, alvo);
    if (distancia === 0) return;
    const botao = distancia > 0 ? "mes-seguinte" : "mes-anterior";
    await page.getByTestId(botao).click();
    await expect
      .poll(() => mesVisivelNoPainel(page), {
        timeout: ESPERA_DA_CONSULTA,
        message:
          `o calendário não saiu de ${visivel} depois do clique em \`${botao}\` ` +
          `(alvo: ${alvo}) — o botão de mês não moveu a tela`,
      })
      .not.toBe(visivel);
  }
  expect(
    await mesVisivelNoPainel(page),
    `o calendário não chegou a ${alvo} em doze passos — o alvo está fora da janela que a tela desenha`,
  ).toBe(alvo);
}

/**
 * Os dias do mês EM TELA que servem, esperando a consulta responder — ou `[]`.
 *
 * `[]` significa "este mês acabou (ou não tem o que eu procuro)", nunca "a tela
 * não respondeu": o teto já foi gasto antes de desistir.
 */
async function servemNoMesEmTela(
  page: Page,
  aceita: (dia: string) => boolean,
  teto: number,
): Promise<string[]> {
  try {
    // ⚠️ A ESPERA É PELO CRITÉRIO, e não por "algum dia aceso".
    //
    // Esperar "algum dia" parece equivalente e não é: logo depois de trocar de
    // mês há um quadro com o mês NOVO na tela e os horários do mês VELHO por
    // baixo, e a janela do mês velho vai até `endOfMonth + 1 dia`
    // (`janelaDoMesVisivel`) — então o dia 1º do mês novo acende sozinho, com
    // dado do outro mês. Sair da espera nesse quadro e varrer em seguida lê "o
    // mês já respondeu" onde ainda não respondeu. Medido no run 36292363538
    // (27/09 ~04h UTC): `toBeVisible` verde em 2 ms, varredura vazia 17 ms
    // depois. Só o critério de quem chamou — um dia DA SEMANA DESENHADA, um dia
    // depois de hoje — não pode ser satisfeito por engano.
    await expect
      .poll(async () => (await diasComVagaNoMes(page)).filter(aceita), {
        timeout: teto,
        intervals: [50, 100, 250, 500, 1_000],
      })
      .not.toEqual([]);
  } catch {
    // Mês em tela sem nenhum dia que sirva: é o caso que justifica PERCORRER o
    // mês seguinte, não motivo para reprovar aqui. Quem reprova é o fim da
    // função, com o motivo escrito.
    return [];
  }
  return (await diasComVagaNoMes(page)).filter(aceita).sort();
}

/**
 * Os dias do mês com vaga que satisfazem `aceita` — percorrendo os meses
 * seguintes quando o mês em tela ACABOU.
 *
 * O primeiro passo ESPERA a consulta do mês em tela responder em vez de concluir
 * "não há vaga" no primeiro quadro: até a resposta chegar, todo dia nasce
 * apagado, e ler ali é ler o vazio do carregamento como se fosse o vazio do
 * calendário.
 *
 * Quando o mês está morto de verdade (`outubro` na medição do cabeçalho), o
 * custo é UM teto de espera antes de avançar — pago só nos dias em que o painel
 * abre num mês que acabou, e preferível a reprovar a `main` todos os dias.
 */
export async function garantirDiaComVagaNoMes(
  page: Page,
  aceita: (dia: string) => boolean,
  porque: string,
  opcoes: { teto?: number; meses?: number } = {},
): Promise<string[]> {
  const teto = opcoes.teto ?? ESPERA_DA_CONSULTA;
  const meses = opcoes.meses ?? MESES_PERCORRIDOS;

  for (let salto = 0; salto <= meses; salto++) {
    const servem = await servemNoMesEmTela(page, aceita, teto);
    if (servem.length > 0) return servem;
    if (salto === meses) break;
    await irParaOMesDoPainel(page, mesSeguinte(await mesVisivelNoPainel(page)));
  }

  throw new Error(
    `${porque}\n\n` +
      `O calendário foi percorrido por ${meses + 1} mês(es) e nenhum dia serviu. ` +
      `Se o mês em tela está apagado, o problema é a jornada publicada pelo seed ` +
      `(\`scripts/seed-e2e-agenda.ts\`), não a data: a medição do motor está no ` +
      `cabeçalho de \`agenda-mes-com-vaga.ts\`.`,
  );
}
