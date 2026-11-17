/**
 * O que ENTRA no bucket de logos — decidido pelos BYTES, nunca pelo que o
 * cliente disse que mandou.
 *
 * ── O furo que este módulo existe para não repetir ───────────────────────────
 *
 * `app/api/v1/channels/partner/templates/media/route.ts:62-63` decide o tipo por
 * `file.type`, que é o `Content-Type` da parte multipart — uma string que QUEM
 * SOBE escolhe. `allowed_mime_types` do bucket tem o mesmo problema: o Storage
 * compara com o header da requisição, não com o conteúdo. Ou seja, as duas
 * defesas "de tipo" que o repositório já tinha leem o mesmo campo controlado
 * pelo atacante. Aqui o tipo sai da assinatura do arquivo, e `file.type` só
 * entra no `details` do erro — para o log mostrar a mentira, nunca para decidir.
 *
 * ── Por que SVG é BANIDO, e não "aceito com cuidado" ─────────────────────────
 *
 * SVG é XML com `<script>` executável. Servido do bucket público e NAVEGADO
 * diretamente (não dentro de um `<img>`, onde o script não roda), ele executa no
 * origin do Storage do projeto — e a CSP do painel (`next.config.ts`) não
 * restringe `script-src` e, de todo modo, não alcança o origin do Storage. Sem
 * CSP que valha ali, a única defesa que sobra é não aceitar o formato.
 *
 * A recusa tem código PRÓPRIO (`logo_svg_recusado`) em vez de cair no genérico
 * de tipo não suportado porque a pessoa que sobe um SVG fez a coisa mais natural
 * do mundo — é o formato em que um designer entrega logo. Ela precisa ler "SVG
 * não, mande PNG ou JPG", não "tipo de mídia não suportado".
 *
 * ── O que este módulo NÃO faz, e por quê ─────────────────────────────────────
 *
 * Não decodifica a imagem, não mede luminância e não avisa que o logo escuro
 * some no tema escuro. A prévia de `components/branding/CampoDeLogo.tsx`
 * renderiza a imagem REAL sobre as duas superfícies, no navegador, com precisão
 * total e zero linha de parser — um analisador de bytes ao lado dela seria ~200
 * linhas de leitura de dados controlados pelo atacante (mais guarda de bomba de
 * descompressão) para escrever em português o que a pessoa já está vendo.
 */

import { caminhoBateComPrefixo } from "./logo";

/** Os dois tipos que o produto aceita como logo. */
export type TipoDeLogo = "image/png" | "image/jpeg";

/**
 * Quantos bytes bastam para decidir.
 *
 * As duas assinaturas cabem em 8; a varredura de SVG precisa de mais, porque um
 * SVG legítimo pode abrir com BOM, declaração XML, DOCTYPE e comentários antes
 * da tag `<svg`. 1 KB cobre isso com folga e mantém a leitura barata.
 */
const BYTES_PARA_FAREJAR = 1024;

/** `89 50 4E 47 0D 0A 1A 0A` — a assinatura do PNG (RFC 2083 §3.1). */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * `FF D8 FF` — SOI + o primeiro marcador de um JFIF/EXIF.
 *
 * Três bytes e não dois: `FF D8` sozinho é o SOI, e um arquivo que começa com
 * ele e nada mais não é uma imagem. O quarto byte varia (`E0` JFIF, `E1` EXIF,
 * `DB` quantização) — fixá-lo recusaria JPEG legítimo de câmera.
 */
const JPEG = [0xff, 0xd8, 0xff] as const;

function comecaCom(bytes: Uint8Array, assinatura: readonly number[]): boolean {
  if (bytes.length < assinatura.length) return false;
  return assinatura.every((b, i) => bytes[i] === b);
}

/**
 * O tipo REAL do arquivo, pela assinatura. `null` = não é PNG nem JPEG.
 *
 * Não tenta adivinhar o que é quando não reconhece: a lista de aceitos é
 * fechada, então "não reconheci" e "reconheci algo que não aceito" levam ao
 * mesmo lugar e distingui-los só daria ao atacante um oráculo de formato.
 */
export function farejarTipo(bytes: Uint8Array): TipoDeLogo | null {
  if (comecaCom(bytes, PNG)) return "image/png";
  if (comecaCom(bytes, JPEG)) return "image/jpeg";
  return null;
}

/**
 * O arquivo PARECE SVG (ou qualquer XML/HTML que um navegador executaria).
 *
 * Deliberadamente FROUXO, ao contrário de `farejarTipo`: aqui o erro caro é o
 * falso NEGATIVO. `farejarTipo` já recusa tudo que não seja PNG/JPEG, então esta
 * função não decide se o arquivo entra — decide se a pessoa recebe a frase que
 * explica o problema dela. Um "quase-SVG" que escape daqui ainda é barrado pelo
 * farejador; um PNG que caia aqui por engano é impossível, porque a assinatura
 * PNG começa com `0x89`, que não é `<` nem espaço.
 *
 * Varre a janela inteira em vez de olhar só o começo porque BOM, `<?xml …?>`,
 * `<!DOCTYPE …>` e comentários podem preceder a tag raiz.
 */
export function pareceSvg(bytes: Uint8Array): boolean {
  const janela = bytes.subarray(0, BYTES_PARA_FAREJAR);
  // `latin1` e não `utf-8`: aqui não se quer interpretar texto, só procurar uma
  // sequência ASCII. UTF-16 com BOM viraria mojibake em utf-8 e a busca falharia.
  let texto = "";
  for (const b of janela) texto += String.fromCharCode(b);
  return /<\s*svg[\s>]/i.test(texto) || /<\?xml/i.test(texto) || /<!doctype\s+svg/i.test(texto);
}

/** A extensão que cada tipo farejado grava no caminho. */
export function extensaoDe(tipo: TipoDeLogo): "png" | "jpg" {
  return tipo === "image/png" ? "png" : "jpg";
}

/**
 * Pode-se APAGAR este objeto? — a asserção sem a qual um admin de tenant apaga o
 * logo da instalação inteira.
 *
 * O ataque, medido no desenho: a rota grava o caminho novo e apaga o ANTERIOR,
 * lido do banco. O logo da plataforma é público e a URL dele está no HTML da tela
 * de login, de onde qualquer pessoa a lê. Um admin de tenant que gravasse
 * `platform/<uuid>.png` como o logo da organização dele e depois subisse outro
 * arquivo faria a rota — rodando como `service_role`, que ignora RLS — apagar o
 * logo da instalação. Não é escalada de privilégio de leitura: é destruição de
 * dado da plataforma por um cliente, com a operação parecendo legítima.
 *
 * Por isso o prefixo é ASSEVERADO na hora de apagar, e não só na hora de gravar:
 * o caminho gravado pode ter vindo de qualquer versão anterior do produto, de uma
 * escrita direta no banco, ou de um clone com dado legado. Recusar aqui custa um
 * arquivo órfão; não recusar custa a marca da instalação.
 */
export function podeApagar(caminho: string | null | undefined, prefixo: string): boolean {
  const limpo = (caminho ?? "").trim();
  if (limpo.length === 0) return false;
  return caminhoBateComPrefixo(limpo, prefixo);
}
