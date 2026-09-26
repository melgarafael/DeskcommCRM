/**
 * Ajustar o logo NO NAVEGADOR — recortar a margem transparente e, se ainda não
 * couber, reduzir a largura — antes de deixar o teto de 512 KB decidir.
 *
 * ── O furo que este módulo existe para fechar ────────────────────────────────
 *
 * A issue #1655 não pede para tirar o teto; pede para a pessoa não travar na
 * tela quando o designer entrega um PNG de 1536×1024 com o logo ocupando só o
 * meio (2 MB no caso real; 354 KB depois de recortar em volta dele). Quem não
 * sabe recortar imagem hoje recebe "O logo precisa ter até 512 KB" e desiste —
 * ou sobe um JPG com fundo branco, que vira uma caixa branca no tema escuro.
 *
 * O corte de borda 100% transparente não perde NENHUMA resolução: são pixels
 * cujo alfa é zero em todas as direções. E como é feito com `<canvas>` aqui do
 * lado de cá, o servidor continua sem decodificar imagem nenhuma — `components/
 * branding/CampoDeLogo.tsx` e `lib/branding/logo-arquivo.ts` já deixam claro
 * que decodificar bytes controlados por quem sobe é justamente o que não se
 * quer (bomba de descompressão, e o farejador de assinatura resolve o tipo).
 *
 * ── O que NÃO muda ───────────────────────────────────────────────────────────
 *
 * O teto. `TAMANHO_MAXIMO_DO_LOGO` continua 512 KB em `lib/branding/logo.ts`,
 * continua no `file_size_limit` do bucket (migration 0158) e a rota continua
 * recusando com a mesma frase. Este módulo só decide o que ENVIAR: o arquivo
 * ajustado quando ele cabe, e a recusa ANTES do envio quando nem o piso de
 * redução resolve — a mesma recusa que o servidor daria, sem subir 2 MB para
 * descobrir.
 *
 * ── Por que o motor é injetado ───────────────────────────────────────────────
 *
 * `MotorDeAjuste` é a fronteira com o DOM. Aqui dentro há só a escada de
 * tentativas — puro, sem `document`, sem `canvas` —, o que permite medir o
 * ajuste inteiro num teste com um PNG de verdade (`tests/unit/ajuste-de-logo
 * .test.ts`). O motor do navegador mora em `lib/branding/lona-do-navegador.ts`;
 * quando ele não existe (ambiente sem `createImageBitmap`), a falha não recusa
 * nada: manda o original e quem decide é o servidor, como antes desta issue.
 */

import { TAMANHO_MAXIMO_DO_LOGO } from "./logo";

/** Um retângulo em pixels, já dentro da imagem. */
export interface Caixa {
  readonly x: number;
  readonly y: number;
  readonly largura: number;
  readonly altura: number;
}

export interface ImagemDeLogo {
  readonly largura: number;
  readonly altura: number;
  /**
   * O menor retângulo com algum pixel de alfa > 0 — as bordas 100%
   * transparentes que sobraram em volta do logo.
   *
   * `null` = não há o que cortar: JPEG (alfa opaco em todo pixel) ou PNG
   * sangrado de ponta a ponta. Cortar um retângulo igual à imagem inteira só
   * re-encodaria o arquivo sem mudar nada, então não é tentativa.
   */
  readonly caixa: Caixa | null;
}

/** O que o motor deve produzir: recortar na `caixa` e escalar por `escala` (1 = tamanho nativo). */
export interface AlvoDeReencodagem {
  readonly caixa: Caixa | null;
  readonly escala: number;
}

/**
 * Quem DE FATO lê e regrava pixels — o `<canvas>` no navegador, o PNG do teste
 * na suíte. As duas funções podem falhar; quem chama trata a falha como
 * "não deu para ajustar", nunca como recusa.
 */
export interface MotorDeAjuste {
  inspecionar(arquivo: File): Promise<ImagemDeLogo>;
  /**
   * `Uint8Array<ArrayBuffer>` e não `Uint8Array`: os bytes vão direto para um
   * `File` (`BlobPart`), e desde o TS 5.7 o `Uint8Array` genérico é
   * `Uint8Array<ArrayBufferLike>` — que o `BlobPart` recusa. Apertar o tipo aqui
   * obriga cada motor a devolver bytes PRÓPRIOS, e não uma vista sobre um buffer
   * que pode ser `SharedArrayBuffer`.
   */
  reencodar(arquivo: File, alvo: AlvoDeReencodagem): Promise<Uint8Array<ArrayBuffer>>;
}

export interface AjusteDeLogo {
  /** O arquivo a subir no `FormData`. É o ORIGINAL quando `recusar` é verdadeiro. */
  readonly arquivo: File;
  /** Passou pelo canvas — é um arquivo reencodado, não o que a pessoa escolheu. */
  readonly ajustado: boolean;
  /**
   * Não coube no teto nem depois do ajuste: NÃO subir, e dizer a frase da recusa.
   * Falso com o arquivo acima do teto só num caso — o motor falhou —, e aí quem
   * recusa é o servidor, como sempre.
   */
  readonly recusar: boolean;
}

/**
 * A largura máxima que a reduce segue: a própria issue aponta ~800 px como o
 * suficiente para os dois lugares onde o logo aparece (barra lateral e cartão
 * de login). Acima disso só se gasta teto e primeira pintura da tela.
 */
export const LARGURA_MAXIMA_DO_LOGO = 800;

/**
 * O PISO: abaixo desta largura o logo do cartão de login (400 px CSS, com DPR 2)
 * já sairia borrado. Um arquivo que só caberia assim é RECUSADO, não entregue
 * capenga — e é o que torna o caminho de recusa alcançável de verdade.
 */
export const LARGURA_MINIMA_DO_LOGO = 512;

/**
 * A escada de larguras, em ordem: 800 → 640 → 512 (razão 0.8, terminando no
 * piso). Fixa, e não calculada a partir do tamanho medido, de propósito: com
 * passos conhecidos o teste afirma as dimensões EXATAS que vão sair, em vez de
 * adivinhar onde o feedback de um loop de estimativa pararia.
 */
const ESCADA_DE_LARGURAS = [LARGURA_MAXIMA_DO_LOGO, 640, LARGURA_MINIMA_DO_LOGO];

/**
 * O logo pronto para enviar — ou a recusa antes de subir.
 *
 * Ordem das tentativas, e por quê nesta ordem:
 *   1. já cabe no teto → devolve o arquivo intacto (byte a byte), sem decodificar;
 *   2. recorte da margem transparente, no tamanho nativo → é a única tentativa
 *      que não perde resolução, então vem sozinha e primeiro;
 *   3. escada de larguras (800 → 640 → 512), sempre a partir da caixa útil;
 *   4. nada coube → `recusar`.
 */
export async function ajustarLogo(
  arquivo: File,
  motor: MotorDeAjuste,
  limite: number = TAMANHO_MAXIMO_DO_LOGO,
): Promise<AjusteDeLogo> {
  // O caminho comum: logo dentro do teto não é tocado. "Não piorar o que já
  // está bom" é byte idêntico, não um reencode que troca nitidez por nada.
  if (arquivo.size <= limite) return { arquivo, ajustado: false, recusar: false };

  let imagem: ImagemDeLogo;
  try {
    imagem = await motor.inspecionar(arquivo);
  } catch {
    // Sem decodificador no ambiente (ou arquivo que o navegador não abre): o
    // original vai ao servidor e a recusa é a de sempre. Aqui dentro, falha
    // técnica NUNCA vira recusa na tela.
    return { arquivo, ajustado: false, recusar: false };
  }

  const larguraUtil = imagem.caixa?.largura ?? imagem.largura;
  const alvos: AlvoDeReencodagem[] = [{ caixa: imagem.caixa, escala: 1 }];
  for (const largura of ESCADA_DE_LARGURAS) {
    if (largura >= larguraUtil) continue; // reduzir para algo maior ou igual não é reduzir
    alvos.push({ caixa: imagem.caixa, escala: largura / larguraUtil });
  }

  let mediuAlgumBytes = false;
  for (const alvo of alvos) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await motor.reencodar(arquivo, alvo);
    } catch {
      continue; // esta tentativa não deu; a próxima pode dar
    }
    mediuAlgumBytes = true;
    if (bytes.length > limite) continue;
    return {
      arquivo: new File([bytes], arquivo.name, { type: arquivo.type || "image/png" }),
      ajustado: true,
      recusar: false,
    };
  }

  // Ou não houve tentativa nenhuma que produzisse bytes (motor quebrado → deixa
  // o servidor decidir), ou todas passaram do teto até o piso (cabeçalho capenga
  // não: recusa com a frase que a rota já usa).
  return { arquivo, ajustado: false, recusar: mediuAlgumBytes };
}
