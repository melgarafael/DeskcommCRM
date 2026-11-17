import { camposDeDataDoNegocio } from "@/lib/leads/campos-do-funil";
import { chaveDoDia, diaDe, LIMITE_DO_INTERVALO } from "@/lib/kanban/calendario-do-funil";

/**
 * As datas do funil viram itens de calendário, na Agenda (#3221).
 *
 * ─── O que esta camada É ────────────────────────────────────────────────────
 *
 * Um espelho de LEITURA das datas que já moram em `crm_leads.custom_fields`: o
 * negócio aparece no dia do campo escolhido — e, quando há um segundo campo
 * coerente, também no dia dele. A pergunta que ela responde é a de quem trabalha
 * com data: o que acontece neste dia, com o nome que o próprio funil dá à data.
 *
 * ─── O que ela NÃO faz, e por que é módulo puro ─────────────────────────────
 *
 * Nada aqui cria, move ou altera negócio: a camada é leitura, e quem muda a data
 * muda o campo do negócio (na ficha). O que ela decide — QUEM ENTRA EM QUE DIA —
 * é decisão de produto, não de apresentação, e por isso mora fora do componente
 * e é provada por teste próprio, em vez de depender de um render de jsdom.
 *
 * ─── De quem é a régua de data ──────────────────────────────────────────────
 *
 * `diaDe` é o MESMO tradutor do Calendário do funil (`lib/kanban/calendario-do-funil`),
 * e não uma segunda cópia: `YYYY-MM-DD` é lido por pedaços, sem passar por
 * `new Date()`, porque `new Date("2026-03-10")` é meia-noite em UTC e quem está
 * em `America/Sao_Paulo` veria 09/03. Duas réguas de data no mesmo produto
 * divergem no dia em que uma delas for corrigida.
 *
 * ─── O que esta primeira fatia decidiu ──────────────────────────────────────
 *
 * Decisão de produto de 29/10. A configuração pelo administrador segue na
 * #3221; os dias do MEIO do intervalo entraram na fatia seguinte (regra 5). O
 * ponto em que cada escolha morde está marcado com "PADRÃO CONSERVADOR":
 *
 *  (a) quais campos entram por padrão — nenhum: a camada nasce desligada, e não
 *      escolhe campo por heurística de nome;
 *  (b) início e fim no MESMO dia — uma ocorrência com os dois rótulos, e não
 *      dois chips idênticos no mesmo dia;
 *  (c) campo renomeado/apagado — a escolha deixa de valer, a camada volta ao
 *      estado "escolha o campo" e não inventa o dado.
 */

/** O que a camada precisa saber de um negócio. Sem contato, sem valor. */
export interface NegocioComDatas {
  id: string;
  titulo: string;
  funilId: string;
  funilNome: string;
  etapaNome: string | null;
  /** `crm_leads.custom_fields` — pode vir vazio, e é o caso normal. */
  campos: Record<string, unknown>;
}

/** Um negócio NUM dia, com o rótulo do campo que o pôs ali. */
export interface ItemDeDataDoNegocio {
  negocio: Omit<NegocioComDatas, "campos">;
  /** `YYYY-MM-DD` — o dia de calendário, nunca um instante. */
  dia: string;
  /**
   * Os rótulos dos campos que caem NESTE dia, na ordem início → fim.
   *
   * É o que impede o produto de dizer "data do negócio": quem embarca lê
   * "Embarque", quem volta lê "Retorno" — a palavra vem do campo que o
   * administrador declarou no funil, não de uma const no código.
   */
  rotulos: string[];
}

/**
 * A escolha de quem ligou a camada: um campo e, opcionalmente, um segundo.
 *
 * Os RÓTULOS viajam junto de propósito. Eles são `label` do campo no funil (dado
 * do administrador), e o módulo puro não tem como buscá-los: recebê-los aqui
 * mantém a função sem I/O e garante que a tela e o servidor digam a MESMA
 * palavra — o servidor é quem responde o item, e ele não pode assinar um rótulo
 * que o funil não declara.
 */
export interface EscolhaDeDatas {
  /** A chave do campo de data que marca o dia. */
  campo: string;
  /** O `label` desse campo no funil. */
  rotulo: string;
  /** A chave do segundo campo (retorno). Ausente = a camada é de PONTO. */
  campoFim?: string | null;
  /** O `label` do segundo campo. */
  rotuloFim?: string | null;
  /**
   * O rótulo dos dias do MEIO do intervalo (#3221). Ausente = `ROTULO_DO_MEIO`.
   *
   * Existe para a rota poder assinar a palavra no idioma de quem lê: como o
   * `label` do início e do fim, ela é TEXTO, e o módulo puro não traduz nada.
   */
  rotuloMeio?: string | null;
}

/** O recorte visível na grade, em dias de calendário do fuso da organização. */
export interface JanelaDeDias {
  de: string;
  ate: string;
}

/**
 * O rótulo dos dias do MEIO do intervalo (#3221).
 *
 * Não existe campo no funil para isso — e inventar um seria pedir ao
 * administrador que declarasse uma data que ele não tem. Então o meio fala por
 * uma palavra só, genérica o bastante para servir a qualquer funil: "Em
 * andamento". É decisão DESTA fatia; trocá-la é mudar esta linha (e a chave do
 * dicionário), sem tocar na régua de dias.
 *
 * O valor daqui é o padrão de quem chama o módulo puro. A rota passa
 * `t("Em andamento")`, então o item chega à tela no idioma de quem lê.
 */
export const ROTULO_DO_MEIO = "Em andamento";

/**
 * Teto de dias do MEIO por negócio.
 *
 * Um intervalo patológico (1990 a 2030) não pode virar milhares de itens do
 * mesmo negócio e esconder o resto da grade. 366 é o MESMO teto do intervalo
 * do Calendário do funil (`LIMITE_DO_INTERVALO`): cobre com folga qualquer
 * período que uma grade de mês ou semana mostre, e o que passa disso é dado que
 * ninguém vai ler dia a dia. Ao estourar, a emissão PARA — as pontas continuam
 * no lugar, e nenhum laço varre quarenta anos para descobrir o corte.
 */
export const TETO_DE_DIAS_DO_MEIO_POR_NEGOCIO = LIMITE_DO_INTERVALO;

/** Um funil com os campos de data que ele declara. `campos` vazio = não entra na escolha. */
export interface FunilComDatas {
  id: string;
  nome: string;
  campos: Array<{ key: string; label: string }>;
}

/**
 * Os funis que têm campo de data, para o seletor da camada.
 *
 * A descoberta é a MESMA do Calendário do funil (`camposDeDataDoNegocio`:
 * `type === "date"` no escopo `negocio` do `settings.fields`) — `campos-pesquisaveis`
 * é outra coisa (os campos que a busca do Kanban indexa) e não serve aqui.
 * Funil sem campo de data é omitido: oferecê-lo no seletor seria um item que,
 * escolhido, deixa a grade vazia sem dizer por quê.
 */
export function funisComCamposDeData(
  funis: ReadonlyArray<{
    id: string;
    nome: string;
    settings: Record<string, unknown> | null | undefined;
  }>,
): FunilComDatas[] {
  const out: FunilComDatas[] = [];
  for (const funil of funis) {
    const campos = camposDeDataDoNegocio(funil.settings).map((campo) => ({
      key: campo.key,
      label: campo.label,
    }));
    if (campos.length > 0) out.push({ id: funil.id, nome: funil.nome, campos });
  }
  return out;
}

/**
 * O `YYYY-MM-DD` de um valor do campo — ou `null` quando ele não é data.
 *
 * Delega a `diaDe` em vez de reimplementar: é a mesma régua do Calendário do
 * funil, inclusive para data cheia (com hora), que vale pelo dia LOCAL do
 * carimbo. `null` cobre os dois estados que a tela trata igual — "ainda não
 * preencheu" e "veio lixo" — porque nenhum dos dois tem dia.
 */
export { diaDe as diaDoCampo };

/**
 * O dia seguinte a um `YYYY-MM-DD`, no calendário puro.
 *
 * `setDate` sobre uma data LOCAL (ano, mês, dia) é aritmética de calendário: não
 * passa por UTC e não desliza na virada do mês. A chave de volta é a MESMA do
 * Calendário do funil (`chaveDoDia`), não uma segunda formatação.
 */
function proximoDia(dia: string): string {
  const [ano, mes, d] = dia.split("-").map(Number);
  const data = new Date(ano!, mes! - 1, d!);
  data.setDate(data.getDate() + 1);
  return chaveDoDia(data);
}

/**
 * Os itens da camada: um por negócio por dia, dentro da janela pedida.
 *
 * Regras, na ordem em que mordem:
 *
 *  1. **Sem data no campo escolhido, não há item.** O negócio não é jogado em
 *     "hoje" nem no fim do período: a ausência é a informação, e é ela que diz
 *     ao operador que falta preencher o campo.
 *  2. **Fora da janela, não há item.** A janela vem em dias de calendário do
 *     fuso da organização — comparar `YYYY-MM-DD` como texto É comparação de
 *     data, e é por isso que nada aqui converte para instante.
 *  3. **O segundo campo só vale se for coerente** (`fim > inicio`), a mesma
 *     regra do intervalo do Calendário do funil: fim antes do início é dado
 *     errado, e andar para trás marcaria um "retorno" que ainda não aconteceu.
 *  4. **PADRÃO CONSERVADOR (b):** início e fim no MESMO dia viram UM item, com
 *     os dois rótulos ("Embarque · Retorno"). Dois chips idênticos no mesmo dia
 *     para o mesmo negócio leem como duplicata.
 *  5. **Os dias do MEIO do intervalo entram, um item por dia** (#3221). Entre
 *     as duas pontas — exclusivas — cada dia visível na janela vira um item com
 *     o rótulo do meio, para a grade responder "quem está em viagem no dia 12"
 *     e não só "quem embarca e quem volta". O meio é recortado pela janela e
 *     limitado por `TETO_DE_DIAS_DO_MEIO_POR_NEGOCIO`: ao estourar, para de
 *     emitir (as pontas continuam), em vez de encher a grade com um intervalo
 *     patológico.
 */
export function itensDaCamada(
  negocios: readonly NegocioComDatas[],
  escolha: EscolhaDeDatas,
  janela: JanelaDeDias,
): ItemDeDataDoNegocio[] {
  const itens: ItemDeDataDoNegocio[] = [];
  const campoFim =
    escolha.campoFim && escolha.campoFim !== escolha.campo ? escolha.campoFim : null;
  const rotuloFim = escolha.rotuloFim ?? campoFim ?? "";
  // O rótulo do meio tem padrão no módulo e pode ser assinado no idioma de quem
  // lê (a rota traduz). `trim` porque rótulo em branco não é rótulo: o chip
  // ficaria vazio no dia, e o dia pareceria um item sem nome.
  const rotuloMeio = escolha.rotuloMeio?.trim() || ROTULO_DO_MEIO;

  for (const negocio of negocios) {
    const inicio = diaDe(negocio.campos?.[escolha.campo]);
    if (!inicio) continue;

    const fim = campoFim ? diaDe(negocio.campos[campoFim]) : null;
    const mesmoDia = fim !== null && fim === inicio;
    const fimVale = fim !== null && fim > inicio;

    const { campos: _campos, ...semCampos } = negocio;
    void _campos;

    if (inicio >= janela.de && inicio <= janela.ate) {
      itens.push({
        negocio: semCampos,
        dia: inicio,
        // PADRÃO CONSERVADOR (b): o dia que é início E fim leva os dois rótulos,
        // início primeiro — é a ordem em que as datas acontecem.
        rotulos: mesmoDia ? [escolha.rotulo, rotuloFim] : [escolha.rotulo],
      });
    }

    if (fimVale && fim >= janela.de && fim <= janela.ate) {
      itens.push({ negocio: semCampos, dia: fim, rotulos: [rotuloFim] });
    }

    // ─── Dias do MEIO (#3221) ──────────────────────────────────────────────
    //
    // Estritamente entre as pontas (`dia < fim`, começando em `inicio + 1`) e
    // dentro da janela visível. `fimVale` é a MESMA guarda do fim: intervalo
    // incoerente não ganha meio, porque não ganha fim.
    //
    // O laço começa já recortado — e não em `inicio` para depois filtrar — para
    // que um intervalo de 1990 a 2030 não custe quarenta anos de `setDate` por
    // negócio. O teto conta os itens EMITIDOS e PARA: as pontas já estão na
    // lista, e o que sobra do intervalo é dado que ninguém lê dia a dia.
    if (fimVale) {
      let dia = inicio < janela.de ? janela.de : proximoDia(inicio);
      let emitidos = 0;
      while (dia < fim && dia <= janela.ate && emitidos < TETO_DE_DIAS_DO_MEIO_POR_NEGOCIO) {
        itens.push({ negocio: semCampos, dia, rotulos: [rotuloMeio] });
        emitidos += 1;
        dia = proximoDia(dia);
      }
    }
  }

  // Ordem estável e legível: dia, título, id. Sem o id no fim, dois negócios
  // homônimos trocariam de lugar entre renders.
  return itens.sort((a, b) => {
    if (a.dia !== b.dia) return a.dia < b.dia ? -1 : 1;
    const porTitulo = a.negocio.titulo.localeCompare(b.negocio.titulo, "pt-BR");
    if (porTitulo !== 0) return porTitulo;
    return a.negocio.id < b.negocio.id ? -1 : a.negocio.id > b.negocio.id ? 1 : 0;
  });
}
