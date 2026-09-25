/**
 * SPEC DE AGENDA NÃO ESCOLHE O PERÍODO SOZINHA — a guarda da CLASSE, não das
 * quatro instâncias.
 *
 * ═══ A classe ════════════════════════════════════════════════════════════════
 *
 * "Teste que lê uma grandeza que ninguém declarou como ENTRADA." Em 2026-08-28
 * ela apareceu QUATRO vezes em um único dia, todas na agenda:
 *
 *   - `agenda-painel-cabe-na-tela` (PR #402) abria no primeiro dia clicável, que
 *     é hoje: a `main` reprovou com 9 horários às 15:27 UTC e 7 às 16:37 — mesmo
 *     commit, mesmo seed, contagens diferentes;
 *   - `agenda-grade-interativa`, `agenda-marcar-pela-tela` e
 *     `agenda-remarcar-e-cancelar` trabalhavam na semana desenhada, que é a de
 *     hoje, e reprovaram a `main` em quatro runs seguidos a partir das ~15h50.
 *
 * Medido com o motor real (`lib/agenda/horarios-livres.ts`), numa sexta-feira,
 * contando horários livres na semana que a grade desenha:
 *
 *     dia          09h  12h  15h  16h  17h  20h  23h
 *     sex (hoje)    16   10    4    2    0    0    0
 *     sáb            0    0    0    0    0    0    0
 *     semana +1     90   90   90   90   90   90   90
 *
 * Consertar as quatro instâncias não fecha nada: a quinta spec de agenda vai
 * nascer com `.first()` no primeiro dia que a tela oferecer, porque é o gesto
 * óbvio — e vai passar, verde, até a próxima sexta às 16h.
 *
 * ═══ A régua ═════════════════════════════════════════════════════════════════
 *
 * Existe UM módulo que decide o período (`tests/e2e/helpers/agenda-semana-integra.ts`),
 * e toda spec que escolhe dia ou bloco na agenda tem de passar por ele. A guarda
 * cobra três coisas:
 *
 *   1. a spec que casa "agenda + seletor de dia/bloco" IMPORTA o módulo;
 *   2. e o CHAMA — importar para calar a guarda não conta;
 *   3. o módulo não lê o relógio do PROCESSO (`new Date()` / `Date.now()` no
 *      Node): o período sai do que a tela desenhou, ou de um `page.evaluate`,
 *      que roda no mesmo relógio e no mesmo fuso que formataram o `data-testid`.
 *
 * ═══ O QUE ESTA GUARDA NÃO PEGA — e está escrito porque a omissão anestesia ══
 *
 * Ela não lê o corpo da spec procurando outras leituras de tempo: uma spec pode
 * importar o módulo, chamá-lo, e ainda assim asserir sobre "o compromisso das
 * 14h" logo abaixo. O que ela garante é que quem escrever a próxima spec de
 * agenda ESBARRE na regra e leia a tabela acima — não que o autor a obedeça em
 * cada linha. Guarda de fonte não substitui revisão; ela impede a reincidência
 * silenciosa, que é como as quatro instâncias chegaram aqui.
 *
 * Também não vale para specs fora da agenda. A classe é maior que este módulo
 * (a janela anti-ban derrubando o `test:db` de madrugada é a mesma doença), mas
 * uma guarda que tentasse cobrir tudo teria de adivinhar o que é leitura de
 * tempo legítima — e uma guarda que tolera não distingue.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const DIR_E2E = path.join(RAIZ, "tests/e2e");
const MODULO = path.join(DIR_E2E, "helpers/agenda-semana-integra.ts");

/** As funções que o módulo publica — chamar qualquer uma satisfaz a régua 2. */
const CHAMADAS = [
  "irParaASemanaSeguinte",
  "irParaASemanaDoCompromisso",
  "escolherDiaDesenhado",
  "escolherPrimeiroDiaCheio",
  "escolherUltimoDiaCheio",
];

/**
 * Specs dispensadas, com o motivo escrito. Esta lista SÓ ENCOLHE — cada entrada
 * é dívida declarada, e entrar nela exige a razão pela qual a spec não escolhe
 * período nenhum.
 */
const DISPENSADAS: Record<string, string> = {
  "agenda-primeira-pintura-no-fuso.spec.ts":
    "não escolhe dia nem bloco — mede QUAL SEMANA o servidor pinta antes da hidratação, e " +
    "por isso não pode navegar: `irParaASemanaSeguinte` precisa da página viva, que esta " +
    "spec desliga de propósito (bloqueia os pacotes da aplicação). O que ela lê das colunas " +
    "é a CHAVE do dia — comparada com a semana daquele fuso no mesmo instante —, nunca " +
    "disponibilidade: nenhuma asserção depende de haver vaga, de que dia é hoje ou da hora. " +
    "⚠️ A dispensa VENCE se ela passar a afirmar algo sobre horário livre ou bloco clicável.",
  "agenda-portao-de-hidratacao.spec.ts":
    "não escolhe dia nem bloco — ela mede o PORTÃO de hidratação do próprio módulo do " +
    "período (`aguardarGradeHidratada`), e por isso não pode passar por " +
    "`irParaASemanaSeguinte`: navegar exige justamente o que ela sabota. O que ela lê da " +
    "grade é a PRESENÇA das colunas que o servidor desenhou (`toBeAttached`), para provar " +
    "que a sabotagem deixou a página desenhada e morta em vez de vazia — nenhuma asserção " +
    "dela depende de haver vaga, de que dia é hoje ou de que horas são. " +
    "⚠️ A dispensa VENCE no instante em que ela afirmar qualquer coisa sobre horário livre, " +
    "bloco clicável ou dia escolhido: aí ela volta a medir o calendário, e precisa do módulo.",
  "agenda-kit-visual.spec.ts":
    "roda contra /vitrine-agenda, que PASSA o instante como fixture — é o padrão certo, " +
    "não a exceção: por isso ela clica num `dia-2026-08-24` fixo e segue verde com essa " +
    "data no passado.",
  "agenda-papel-de-leitura.spec.ts":
    "não escolhe dia nem bloco — conta a EXISTÊNCIA da camada de marcação, que é o gesto " +
    "de escrita que o `viewer` não pode ter: `toHaveCount(0)` para quem só lê e `> 0` para " +
    "o atendente, na mesma tela e no mesmo banco. `CamadaDeMarcacao` desenha um `bloco-` " +
    "por célula de `CELULAS` em TODA coluna de dia sempre que `interacao` existe " +
    "(`components/agenda/GradeDaAgenda.tsx`), e `CELULAS` é constante " +
    "(`(ULTIMA_HORA - PRIMEIRA_HORA + 1) * 60 / PASSO_DA_CELULA_MIN`): a disponibilidade " +
    "mora em `data-livre`/`disabled`, não na presença do botão. As duas contagens, " +
    "portanto, não leem a semana desenhada nem a hora — o que o período muda é quantos " +
    "blocos são LIVRES, e esta spec não lê isso. " +
    "⚠️ A dispensa VENCE se a camada passar a desenhar só os horários livres: aí `> 0` " +
    "volta a medir o calendário, e a spec precisa de `irParaASemanaSeguinte`.",
};

/**
 * A fonte sem os callbacks de `page.evaluate` — o que roda no BROWSER.
 *
 * Conta parênteses em vez de casar com regex: a primeira versão usava
 * `/page\.evaluate\(\(\)\s*=>/`, que só reconhecia callback SEM argumento, e
 * deixou passar `page.evaluate((iso) => …, instanteISO)`. A guarda acusou o
 * módulo de ler o relógio do processo quando ele lia o do browser — falso
 * positivo, que é como uma guarda perde a confiança de quem a lê.
 *
 * Se a contagem se perder, o recorte devolve texto demais e a guarda fica
 * VERMELHA. É a direção certa de falhar para uma guarda: fechada.
 */
function foraDoBrowser(fonte: string): string {
  let fora = "";
  let i = 0;
  for (;;) {
    const inicio = fonte.indexOf("page.evaluate(", i);
    if (inicio === -1) return fora + fonte.slice(i);
    fora += fonte.slice(i, inicio);
    let k = inicio + "page.evaluate".length;
    let nivel = 0;
    for (; k < fonte.length; k++) {
      if (fonte[k] === "(") nivel++;
      else if (fonte[k] === ")" && --nivel === 0) {
        k++;
        break;
      }
    }
    fora += "<browser>";
    i = k;
  }
}

function specsDeAgenda(): string[] {
  return readdirSync(DIR_E2E)
    .filter((f) => f.endsWith(".spec.ts"))
    .filter((f) => {
      const fonte = readFileSync(path.join(DIR_E2E, f), "utf8");
      const naAgenda = /\/app\/agenda|tela-agenda|painel-de-marcacao/.test(fonte);
      // ⚠️ O DETECTOR PRECISOU CRESCER, e quem o corrigiu foi o CI.
      //
      // A primeira versão procurava só os seletores de dia e bloco, e deixou
      // passar `agente-marca-consulta`: ela não seleciona dia nenhum — marca por
      // API, no primeiro horário livre que a rota oferecer, e depois procura o
      // cartão na Agenda. Mesmíssima dependência ("em que semana isto cai?"),
      // nenhum dos sinais que eu tinha escolhido. Reprovou no CI às 21h01 UTC
      // com `element(s) not found`, uma spec depois das cinco que eu havia
      // consertado.
      //
      // Os sinais agora são todos os jeitos de a spec depender de QUANDO o
      // horário cai: escolher dia/bloco, procurar um cartão por `faixa-`,
      // escolher um `horario-`, confirmar uma marcação, ou mandar a IA marcar.
      // A spec já migrada entra pelo import — sem isso, migrar uma spec a
      // tiraria do conjunto e o controle de vacuidade mediria um conjunto que só
      // encolhe.
      const escolhePeriodo =
        /\[data-testid\^="(dia|bloco|horario)-"\]|getByTestId\(`(dia|bloco|faixa)-/.test(fonte) ||
        /faixa-\$\{|confirmar-marcacao|crm_book_appointment/.test(fonte) ||
        /from "\.\/helpers\/agenda-semana-integra"/.test(fonte);
      return naAgenda && escolhePeriodo;
    });
}

describe("spec de agenda não escolhe o período sozinha", () => {
  it("a varredura ENCONTRA specs — uma lista vazia passaria por vacuidade", () => {
    // Sem este caso, quebrar o regex acima (ou renomear os `data-testid`) faria
    // os dois casos abaixo ficarem verdes sobre um conjunto vazio.
    // Sete em 2026-08-28 — seis foram instâncias da classe no mesmo dia, e a
    // sétima é a dispensada da vitrine. O piso é o que havia quando a guarda nasceu: spec
    // de agenda não some, só aparece.
    expect(specsDeAgenda().length).toBeGreaterThanOrEqual(7);
  });

  it("toda spec que escolhe dia ou bloco na agenda passa pelo módulo do período", () => {
    const faltando: string[] = [];
    for (const spec of specsDeAgenda()) {
      if (spec in DISPENSADAS) continue;
      const fonte = readFileSync(path.join(DIR_E2E, spec), "utf8");
      const importa = /from "\.\/helpers\/agenda-semana-integra"/.test(fonte);
      const chama = CHAMADAS.some((f) => new RegExp(`\\b${f}\\(`).test(fonte));
      if (!importa || !chama) faltando.push(`${spec} (importa=${importa}, chama=${chama})`);
    }
    expect(
      faltando,
      "estas specs escolhem dia ou bloco na agenda sem passar por " +
        "`tests/e2e/helpers/agenda-semana-integra`. O período que elas pegarem será o de " +
        "HOJE, e hoje encolhe: 16 vagas às 9h, 2 às 16h, ZERO das 17h em diante e zero o " +
        "sábado inteiro. Use `irParaASemanaSeguinte` + `escolherDiaDesenhado` (quando a " +
        "asserção envolve a grade) ou `escolherPrimeiroDiaCheio` (quando é só o painel) — " +
        "ou declare a dispensa em DISPENSADAS, com o motivo.",
    ).toEqual([]);
  });

  it("o módulo do período não lê o relógio do processo", () => {
    const fonte = readFileSync(MODULO, "utf8");
    // `page.evaluate(() => { ... new Date() ... })` roda no BROWSER, e é
    // legítimo: é o mesmo relógio e o mesmo fuso que formataram o `data-testid`.
    // O que não pode é o Node decidir a data e o browser desenhar outra.
    // Comentário NÃO é código, e este arquivo cita `ancora={new Date()}` ao
    // explicar por que o mini-calendário abre no mês de hoje. Uma guarda que
    // lesse a prosa como código proibiria a explicação do próprio defeito.
    const semProsa = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const noNode = foraDoBrowser(semProsa).match(/new Date\(|Date\.now\(/g) ?? [];
    expect(
      noNode,
      "o módulo passou a ler o relógio do processo. O período tem de sair do que a TELA " +
        "desenhou (`coluna-dia-…`) ou de um `page.evaluate`, que roda no relógio do browser — " +
        "senão o Node escolhe uma data e a tela desenha outra, e a divergência aparece uma " +
        "vez por dia, à meia-noite.",
    ).toEqual([]);
  });
});
