/**
 * A RÉGUA DE "TELAS PRINCIPAIS" — o que um idioma precisa ter para APARECER
 * sem carregar a obrigação de traduzir toda frase do produto.
 *
 * ─── O buraco que este arquivo tapa ────────────────────────────────────────
 *
 * `lib/i18n/registro.ts` tem três níveis. O `completo` cobra toda frase de tela
 * (é o espanhol), e o `telas_principais` prometia menos: aparece quando as telas
 * principais estiverem traduzidas. Só que "telas principais" nunca foi medido —
 * o nível existia no tipo, aparecia no seletor e nenhum idioma podia declará-lo,
 * porque não havia critério nenhum para conferir. O único caminho para um idioma
 * novo aparecer era o `completo`, que passa a cobrar aquele idioma em TODO PR
 * que acrescentar uma frase em português. É o contrário da decisão do dono
 * (doc de decisão 18, Decisão 2 b): do terceiro idioma em diante, frase sem
 * tradução cai no português e não reprova ninguém.
 *
 * ─── A lista NÃO é escrita à mão ───────────────────────────────────────────
 *
 * As telas principais são os destinos do menu lateral — `sidebar: true` em
 * `lib/navigation/registry.ts`, que é a única lista de destinos do app do
 * tenant. O registro já chama esses de "uso diário", e essa é a definição: a
 * tela que a equipe abre todo dia, não a que se ajusta uma vez por mês. Tela
 * nova no menu lateral entra na régua no commit em que nasce, sem ninguém
 * lembrar de atualizar lista paralela — e lista paralela é justamente o defeito
 * que o registro de navegação veio matar (`NAV_ITEMS`/`LINKS`/`TABS`).
 *
 * ─── O limiar, e por que DOIS TERÇOS ───────────────────────────────────────
 *
 * Medido nesta árvore (16 rotas, 4.573 frases distintas na união das telas
 * principais): inglês 71,6%, turco 79,7%, chinês 50,0%. Dois terços separam os
 * dois catálogos completos do que está pela metade, e deixam ~5 pontos de folga
 * para o inglês absorver frase nova sem virar vermelho a cada PR — que é o
 * ponto do nível. Com 4.573 frases no denominador, um PR que acrescenta trinta
 * frases em português move a cobertura 0,65 ponto: o idioma pode crescer com o
 * produto em vez de congelar o produto.
 *
 * O que NÃO entra na conta: o `lib/i18n/catalogos.ts` (a carga do catálogo na
 * tela) e a tradução em si. Esta fatia entrega a RÉGUA; promover o inglês é a
 * fatia seguinte, e ela é que decide entre carga assíncrona e JSON fora do
 * programa do TypeScript.
 *
 * ─── Por que este módulo não é importado por nada da tela ──────────────────
 *
 * Ele importa o registro de navegação, que arrasta os ícones do menu. Quem lê
 * a régua é o gate (`tests/unit/i18n-telas-principais-tem-regua.test.ts`); o
 * caminho de render não precisa dela, e não deve pagar por ela.
 */
import { NAV_DESTINATIONS } from "@/lib/navigation/registry";

import type { NivelDeIdioma } from "./registro";

export interface TelaPrincipal {
  /** A rota, como está no registro de navegação (`/app/inbox`). */
  readonly href: string;
  /** O rótulo do menu — é por ele que quem usa reconhece a tela. */
  readonly label: string;
}

/**
 * As telas principais: o menu lateral, na ordem do registro.
 *
 * Derivada, nunca digitada. `sidebar: true` é a marca de "uso diário" que o
 * próprio registro de navegação define; grupo sem hub sobe ao menu por
 * personalização da empresa, e isso é decisão de quem usa, não da régua.
 */
export const TELAS_PRINCIPAIS: readonly TelaPrincipal[] = NAV_DESTINATIONS.filter(
  (destino) => destino.sidebar === true,
).map((destino) => ({ href: destino.href, label: destino.label }));

/**
 * A cobertura mínima das frases das telas principais — 2/3.
 *
 * A justificativa com números está no cabeçalho. Ela é uma constante e não um
 * literal espalhado no teste porque a mensagem de falha precisa dizer QUANTO
 * falta, e duas cópias do mesmo número divergem sem avisar.
 */
export const COBERTURA_MINIMA_DAS_TELAS_PRINCIPAIS = 2 / 3;

/** Quantas frases a medição tem de achar para a régua valer alguma coisa. */
export const FRASES_MINIMAS_ESPERADAS = 1000;

export interface CoberturaDeTelasPrincipais {
  readonly traduzidas: number;
  readonly total: number;
}

export interface VereditoDeTelasPrincipais {
  /** A fração medida — 0 a 1. */
  readonly cobertura: number;
  readonly atende: boolean;
  /** Quantas frases ainda faltam para chegar ao limiar, arredondado para cima. */
  readonly faltam: number;
}

/**
 * O idioma atende a régua? — a conta, num lugar só.
 *
 * Medição vazia REPROVA em vez de passar: `total === 0` é o sintoma de uma
 * varredura quebrada (ou de uma lista de telas esvaziada), e zero de zero é
 * indistinguível de "tudo traduzido" — a armadilha que `helpers/varrer-codigo.ts`
 * documenta. Uma régua que aprova o que não mediu não é régua.
 */
export function avaliarCoberturaDasTelasPrincipais(
  cobertura: CoberturaDeTelasPrincipais,
): VereditoDeTelasPrincipais {
  const { traduzidas, total } = cobertura;
  if (!Number.isInteger(traduzidas) || !Number.isInteger(total) || traduzidas < 0) {
    throw new Error(`medição inválida: ${traduzidas}/${total} frases não é uma contagem`);
  }
  if (total === 0) {
    throw new Error(
      "medição vazia: nenhuma frase de tela principal foi encontrada — a varredura ou a lista de telas quebrou",
    );
  }
  if (traduzidas > total) {
    throw new Error(`medição impossível: ${traduzidas} traduzidas de ${total} frases`);
  }
  const cobertura_ = traduzidas / total;
  const piso = Math.ceil(total * COBERTURA_MINIMA_DAS_TELAS_PRINCIPAIS);
  return {
    cobertura: cobertura_,
    atende: traduzidas >= piso,
    faltam: Math.max(0, piso - traduzidas),
  };
}

/**
 * QUEM DECLARA `telas_principais` E NÃO ATENDE A RÉGUA — o gate, numa função.
 *
 * A mesma conta serve para o registro de verdade e para os idiomas FICTÍCIOS
 * das duas caras do teste: se a régua fosse reimplementada no teste, uma versão
 * frouxa aprovaria o que a outra recusa, e as duas ficariam verdes.
 *
 * Devolve os códigos RECUSADOS. Lista vazia quer dizer "tudo em ordem" — e é
 * indistinguível de "não há nada para conferir", por isso o teste que a chama
 * prova antes que a medição achou frases e que existe ao menos um idioma
 * fictício de cada lado.
 */
export function idiomasQueNaoAtendem(
  idiomas: readonly { readonly codigo: string; readonly nivel: NivelDeIdioma }[],
  coberturaDe: (codigo: string) => CoberturaDeTelasPrincipais,
): { readonly codigo: string; readonly veredito: VereditoDeTelasPrincipais }[] {
  return idiomas
    .filter((idioma) => idioma.nivel === "telas_principais")
    .map((idioma) => ({
      codigo: idioma.codigo,
      veredito: avaliarCoberturaDasTelasPrincipais(coberturaDe(idioma.codigo)),
    }))
    .filter((linha) => !linha.veredito.atende);
}
