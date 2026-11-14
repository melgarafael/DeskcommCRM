/**
 * A JANELA DE MANUTENÇÃO DA ATUALIZAÇÃO, LIDA DO LADO DO APP (#4334).
 *
 * ─── Onde a fonte da verdade mora ───────────────────────────────────────────
 * A janela é uma linha do `.env` (`SYSTEM_UPDATE_WINDOW`, no formato cron: cinco
 * campos, o primeiro com passo de 5 em 5 minutos) e quem
 * a obedece é o `agent.sh` do host: ele segue batendo e vigiando de 5 em 5
 * minutos, e só NÃO executa o pedido fora da janela (seção 4.0, `janela_aberta`
 * em `hostgator-setup-kit/_common.sh`). Este arquivo é o espelho em TypeScript
 * daquelas duas funções — `janela_normalizada` e `janela_contem` —, e existe por
 * um motivo específico: o run nasce `dispatched` no CLIQUE, e a rota do app é
 * quem decide, 15 minutos depois, que ele foi abandonado.
 *
 * ─── O defeito que isto fecha ───────────────────────────────────────────────
 * Com a janela configurada, o clique das 10h fica esperando a madrugada — e às
 * 10h15 um SEGUNDO clique fechava aquele run como "Run abandonado: o agente do
 * host não reportou o desfecho a tempo (agente parado ou travado)". Não estava:
 * ele ainda nem tinha tido a chance de rodar. O efeito era o pior possível para
 * uma feature de agendamento — o pedido agendado era CANCELADO em silêncio por
 * quem só queria ver o estado.
 *
 * A regra que fecha isso é a da própria issue: o prazo do `RUN_STALE_AFTER_MS`
 * só começa a contar quando a janela abre. É o que `primeiraOportunidade`
 * calcula — e é por isso que a leitura da janela precisa existir aqui, e não só
 * no shell.
 *
 * ─── Por que reimplementar, em vez de "só perguntar ao host" ────────────────
 * O app não fala com o host por outro caminho: a única evidência de que o
 * agente rodou é o próprio run mudar de estado. Sem ler a janela, a rota não
 * tem como distinguir "o agente morreu" de "o agente está esperando a hora" —
 * que é exatamente a diferença entre fechar o run e não fechar.
 *
 * A semântica é a do cron, de propósito: cinco campos (minuto hora dia mês
 * dia-da-semana), com os três últimos em `*`. Valor recusado = janela ABERTA
 * (o comportamento de sempre), igual ao `agent.sh`: um erro de digitação não
 * pode deixar a instalação sem atualizar — nem, aqui, fazer o app tratar todo
 * run como agendado para sempre.
 */

const UM_MINUTO_MS = 60_000;
/** Um dia de varredura cobre qualquer janela válida: ela não tem dia, mês nem semana. */
const MINUTOS_POR_DIA = 24 * 60;

interface ItemDoCron {
  inicio: number;
  fim: number;
  passo: number;
}

/**
 * Um item de campo cron (`*`, `7`, `2-5`, cada um com `/passo` opcional).
 * `null` = não serve. Espelho de `_item_cron` do `_common.sh`, incluindo as
 * três recusas que impediriam a janela de abrir: passo zero, faixa invertida e
 * valor fora do campo.
 */
function itemDoCron(item: string, min: number, max: number): ItemDoCron | null {
  let corpo = item;
  let passo = "1";
  const barra = corpo.indexOf("/");
  if (barra >= 0) {
    passo = corpo.slice(barra + 1);
    corpo = corpo.slice(0, barra);
  }

  let inicio: string;
  let fim: string;
  if (corpo === "*") {
    inicio = String(min);
    fim = String(max);
  } else if (corpo.includes("-")) {
    const partes = corpo.split("-");
    const de = partes[0];
    const ate = partes[1];
    // `1-2-3` não é faixa: sem esta cerca, o `split` devolveria dois pedaços e o
    // terceiro seria engolido em silêncio.
    if (partes.length !== 2 || de === undefined || ate === undefined) return null;
    inicio = de;
    fim = ate;
  } else {
    inicio = corpo;
    fim = corpo;
  }

  for (const n of [inicio, fim, passo]) {
    if (!/^\d+$/.test(n)) return null;
  }
  const de = Number(inicio);
  const ate = Number(fim);
  const dePasso = Number(passo);
  if (dePasso < 1) return null;
  if (de < min || ate > max || de > ate) return null;
  return { inicio: de, fim: ate, passo: dePasso };
}

/** O campo inteiro (lista por vírgula) é válido? Régua de CONFIGURAÇÃO. */
function campoValido(campo: string, min: number, max: number): boolean {
  if (!campo) return false;
  const itens = campo.split(",");
  if (itens.some((i) => i.length === 0)) return false;
  return itens.every((i) => itemDoCron(i, min, max) !== null);
}

/** O valor está coberto pelo campo? Régua de CASAMENTO. */
function campoCasa(campo: string, valor: number, min: number, max: number): boolean {
  if (!campo) return false;
  return campo.split(",").some((item) => {
    const alvo = itemDoCron(item, min, max);
    if (!alvo) return false;
    for (let i = alvo.inicio; i <= alvo.fim; i += alvo.passo) {
      if (i === valor) return true;
    }
    return false;
  });
}

/**
 * A janela normalizada — cinco campos com UM espaço entre eles — ou `null`
 * quando o valor não serve. Silêncio é o contrato: quem recebe `null` usa o
 * comportamento de sempre (janela aberta), nunca o valor recusado.
 */
export function normalizarJanela(bruto: string | null | undefined): string | null {
  if (typeof bruto !== "string") return null;
  // Quebra de linha e CR (o que sobra de um `.env` editado no Windows) fora
  // antes de tudo: só produziriam uma recusa ilegível.
  if (bruto.includes("\n") || bruto.includes("\r")) return null;
  const campos = bruto.trim().split(/\s+/);
  if (campos.length !== 5) return null;
  // Alfabeto do cron e só ele — este valor vem de um arquivo que qualquer um
  // edita, e não é lugar de expressão de shell.
  if (campos.some((c) => !/^[0-9*,/-]+$/.test(c))) return null;
  const [minuto, hora, dia, mes, semana] = campos;
  if (!minuto || !hora || !dia || !mes || !semana) return null;
  if (!campoValido(minuto, 0, 59)) return null;
  if (!campoValido(hora, 0, 23)) return null;
  // Dia, mês e dia-da-semana: só `*`. A janela é de HORÁRIO, e o cron casa
  // dia-do-mês E dia-da-semana com OU — reproduzir essa regra aqui seria uma
  // segunda semântica com o mesmo nome.
  if (dia !== "*" || mes !== "*" || semana !== "*") return null;
  return [minuto, hora, dia, mes, semana].join(" ");
}

/**
 * A janela (já normalizada) cobre a hora e o minuto dados?
 *
 * A ordem dos parâmetros é hora, minuto — a mesma de `janela_contem` só que
 * explícita no nome, porque aqui não existe `date +%H:%M` para desambiguar.
 */
export function janelaContem(janela: string, hora: number, minuto: number): boolean {
  if (!Number.isInteger(hora) || !Number.isInteger(minuto)) return false;
  if (hora < 0 || hora > 23 || minuto < 0 || minuto > 59) return false;
  const campos = janela.split(" ");
  if (campos.length !== 5) return false;
  const [campoMinuto, campoHora] = campos;
  if (!campoMinuto || !campoHora) return false;
  return campoCasa(campoMinuto, minuto, 0, 59) && campoCasa(campoHora, hora, 0, 23);
}

/**
 * O primeiro minuto em que a janela abre DEPOIS de `desde` — `null` se ela não
 * abrir nas próximas 24 h (valor que passou pela normalização mas não casa com
 * nenhum minuto, ex. `0-0 0-0 * * *` não é o caso; mas a varredura não depende
 * de supor isso).
 *
 * ESTE é o relógio do abandono: um run despachado às 10h, com a janela
 * de 5 em 5 minutos das 2h às 5h59, só começa a envelhecer às 02h00 do dia
 * seguinte.
 */
export function primeiraOportunidade(janela: string, desde: Date): Date | null {
  const base = desde.getTime();
  if (Number.isNaN(base)) return null;
  // O minuto da própria despacho não conta: o agente só pega o run no ciclo
  // SEGUINTE, e um run criado às 02:00:59 não teve a chance das 02:00.
  let t = Math.floor(base / UM_MINUTO_MS) * UM_MINUTO_MS + UM_MINUTO_MS;
  for (let i = 0; i < MINUTOS_POR_DIA; i++) {
    const quando = new Date(t);
    if (janelaContem(janela, quando.getHours(), quando.getMinutes())) return quando;
    t += UM_MINUTO_MS;
  }
  return null;
}
