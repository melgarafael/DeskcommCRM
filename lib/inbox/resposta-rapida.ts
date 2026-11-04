/**
 * A RÉGUA DA RESPOSTA RÁPIDA (#3009) — o que ela é, e o que ela pode levar.
 *
 * A #2833 deu à resposta rápida TEXTO, IMAGEM e ÁUDIO, mas como MODOS da tela:
 * o áudio era um recurso à parte (um template com uma entrada de áudio e corpo
 * vazio) e o modo texto exigia mensagem escrita. Com isso, três dos sete
 * conteúdos que a #3009 pede não existiam no cadastro: só imagem (o texto era
 * obrigatório), e QUALQUER combinação com áudio — texto+áudio, imagem+áudio,
 * texto+imagem+áudio —, porque o áudio morava noutro modo.
 *
 * ─── Por que uma régua, e não um `if` em cada tela ─────────────────────────
 *
 * "O que é uma resposta rápida válida" é uma pergunta só, feita por três
 * lugares:
 *
 *   BARRA DO INBOX (`BarraDeRecursos`)   RENDERIZA o botão — ícone e
 *                                        `data-recurso-tipo` saem daqui, e um
 *                                        botão que não prepara nada é um botão
 *                                        que mente sobre o que tem.
 *   ENVIO (`Composer.applyTemplate`)     RECUSA a escolha inválida, com o
 *                                        motivo visível — em vez de escrever
 *                                        string vazia no campo e deixar o
 *                                        operador achando que escolheu algo.
 *   CADASTRO (`TemplateFormDialog`)      recusa salvar o que nasceria vazio.
 *
 * A resposta é um DISCRIMINANTE (`tipo`), não um booleano "tem áudio": com sete
 * combinações possíveis, um booleano obriga cada leitor a refazer a conta — e é
 * assim que a barra e o envio passam a discordar sobre o mesmo recurso.
 *
 * ─── O que a régua NÃO decide ──────────────────────────────────────────────
 *
 * Tamanho, mime e quantidade de arquivos são da rota de upload e do CHECK do
 * banco (`lib/templates/midias.ts`, `MAXIMO_DE_MIDIAS`): aqui só se lê o que já
 * está gravado. O tipo de cada mídia sai do CAMINHO (`ehMidiaDeAudio`), nunca do
 * `media_mime` da linha — a mesma leitura de quem desenha o 🎧 desde a #2833.
 */
import { ehMidiaDeAudio, type MidiaDeTemplate } from "@/lib/templates/midias";

/** Os três conteúdos que uma resposta rápida pode levar. */
export const CONTEUDOS_DE_RESPOSTA_RAPIDA = ["texto", "imagem", "audio"] as const;
export type ConteudoDeRespostaRapida = (typeof CONTEUDOS_DE_RESPOSTA_RAPIDA)[number];

/**
 * Os sete tipos — o conjunto que a #3009 enumera, na ORDEM canônica
 * (texto, imagem, áudio) e sempre nessa ordem no nome. A ordem é do nome, não
 * do cadastro: `tipo` é comparável entre duas respostas iguais, e é o que deixa
 * a tela e o teste falarem do mesmo valor.
 */
export const TIPOS_DE_RESPOSTA_RAPIDA = [
  "texto",
  "imagem",
  "audio",
  "texto+imagem",
  "texto+audio",
  "imagem+audio",
  "texto+imagem+audio",
] as const;
export type TipoDeRespostaRapida = (typeof TIPOS_DE_RESPOSTA_RAPIDA)[number];

/**
 * O que a régua precisa saber — CONTAGENS, não a linha crua.
 *
 * Um número de imagens e um de áudios (e não a lista), porque quem cadastra
 * ainda não tem linha nenhuma: os arquivos escolhidos na tela são `File`, e
 * converter `File` em `MidiaDeTemplate` para poder perguntar seria inventar um
 * caminho de storage que ainda não existe.
 */
export interface ConteudoDaRespostaRapida {
  texto?: string | null;
  imagens: number;
  audios: number;
}

/** A leitura: ou o TIPO, ou o motivo de não haver resposta rápida ali. */
export type LeituraDeRespostaRapida =
  | {
      ok: true;
      tipo: TipoDeRespostaRapida;
      conteudos: readonly ConteudoDeRespostaRapida[];
      /** O texto como está (vazio quando a resposta é só mídia). */
      texto: string;
      imagens: number;
      audios: number;
    }
  | { ok: false; motivo: string };

/**
 * Os dois motivos de recusa. Exportados como CONSTANTE para que a tela não
 * reescreva a frase: quem vê o motivo vê exatamente a razão pela qual a régua
 * recusou, e mudar a frase é mudar um literal só.
 */
export const MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO =
  "A resposta rápida não tem conteúdo: escreva um texto, escolha uma imagem ou um áudio.";
export const MOTIVO_RESPOSTA_RAPIDA_AUDIOS_DEMAIS =
  "Uma resposta rápida leva no máximo um áudio. O restante vai em texto ou em imagem.";

/**
 * O tipo a partir das contagens. `null` = nenhum conteúdo.
 *
 * A conta mora AQUI e não em cada leitor: é o único lugar onde "o que conta como
 * combinação" está escrito, e é o que impede a barra de chamar de áudio um
 * recurso que o envio vai tratar como texto.
 */
function tipoDosConteudos(
  temTexto: boolean,
  imagens: number,
  audios: number,
): TipoDeRespostaRapida | null {
  if (temTexto) {
    if (imagens > 0) return audios > 0 ? "texto+imagem+audio" : "texto+imagem";
    return audios > 0 ? "texto+audio" : "texto";
  }
  if (imagens > 0) return audios > 0 ? "imagem+audio" : "imagem";
  return audios > 0 ? "audio" : null;
}

/**
 * A RÉGUA. Duas recusas, e as duas são de CONTEÚDO — não de formato:
 *
 *   1. sem conteúdo nenhum (texto em branco, nenhuma imagem, nenhum áudio):
 *      um botão na barra que não prepara nada. É o estado em que ficava a
 *      resposta de áudio cujo upload falhou depois da criação (#2833).
 *   2. mais de um áudio. A #3009 pede áudio como UM conteúdo da resposta — a
 *      nota de voz gravada —, e o envio sai com a legenda no primeiro anexo que
 *      a aceita: dois áudios não têm um tipo, têm uma fila. Recusar é mais
 *      honesto do que escolher um deles em silêncio.
 *
 * Texto em branco não conta como conteúdo (é o que o operador vê: espaço em
 * branco), mas o texto devolvido é o ORIGINAL — quem envia usa o mesmo corpo que
 * o operador escreveu, não uma versão aparada pela régua.
 */
export function lerRespostaRapida(conteudo: ConteudoDaRespostaRapida): LeituraDeRespostaRapida {
  const texto = conteudo.texto ?? "";
  const imagens = Math.max(0, conteudo.imagens);
  const audios = Math.max(0, conteudo.audios);
  const temTexto = texto.trim() !== "";
  const tipo = tipoDosConteudos(temTexto, imagens, audios);

  if (tipo === null) return { ok: false, motivo: MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO };
  if (audios > 1) return { ok: false, motivo: MOTIVO_RESPOSTA_RAPIDA_AUDIOS_DEMAIS };

  const conteudos: ConteudoDeRespostaRapida[] = [];
  if (temTexto) conteudos.push("texto");
  if (imagens > 0) conteudos.push("imagem");
  if (audios > 0) conteudos.push("audio");

  return { ok: true, tipo, conteudos, texto, imagens, audios };
}

/**
 * A leitura de uma resposta rápida JÁ GRAVADA (linha de `message_templates`).
 *
 * `midias` ausente é "só texto" — a linha anterior à migration 0643 e a fixture
 * antiga chegam sem a chave, como em todo o resto do repo. E o tipo de cada
 * entrada sai do caminho, não da coluna.
 */
export function conteudoDaRespostaRapida(recurso: {
  body?: string | null;
  midias?: readonly MidiaDeTemplate[] | null;
}): ConteudoDaRespostaRapida {
  const midias = recurso.midias ?? [];
  const audios = midias.filter(ehMidiaDeAudio).length;
  return {
    texto: recurso.body ?? "",
    imagens: midias.length - audios,
    audios,
  };
}

/** O atalho que a barra e o envio usam: a régua aplicada a uma linha gravada. */
export function lerRespostaRapidaGravada(recurso: {
  body?: string | null;
  midias?: readonly MidiaDeTemplate[] | null;
}): LeituraDeRespostaRapida {
  return lerRespostaRapida(conteudoDaRespostaRapida(recurso));
}
