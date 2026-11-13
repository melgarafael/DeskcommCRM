/**
 * O MATERIAL DA EMPRESA — as regras que o turno, o handler de envio e a futura
 * tela compartilham (#4129).
 *
 * Material é o documento pronto da empresa (catálogo em PDF, tabela de preços,
 * ficha técnica) que o agente envia na conversa quando ela pede. Ele NÃO entra
 * no RAG: é enviado, não lido — não há chunk, embedding nem consulta.
 *
 * Este módulo é PURO (nada de rede, banco ou `next/headers`): quem copia é
 * `copiar-no-storage.ts`, quem consulta é `materiais-da-empresa.ts`. Aqui moram
 * só as constantes e a régua do que pode ser enviado.
 *
 * ═══ A régua de tipo é UMA ═══
 *
 * `classificarMidiaComLegenda` (`lib/messaging/media/midia-com-legenda.ts`) é a
 * mesma do passo automático e do upload do Inbox. Este módulo NÃO tem mapa de
 * MIME próprio: ele chama aquela função e só recorta o que o material aceita.
 *
 * Recorte: material é DOCUMENTO ou IMAGEM. Vídeo e áudio passam pela mesma
 * função (o passo automático os aceita), mas não são material de empresa — e
 * mandar um `.mp4` como se fosse o catálogo seria a escolha errada que ninguém vê.
 *
 * ═══ `application/octet-stream` NÃO é um tipo ═══
 *
 * A régua devolve `document` para QUALQUER MIME declarado que a allowlist não
 * nomeia — inclusive `octet-stream`. Isso é certo para um passo automático (o
 * operador colou um tipo exótico de propósito) e ERRADO para material: o
 * arquivo iria ao cliente como "documento genérico" sem ninguém saber o que é.
 * Aqui `octet-stream` é tratado como MIME AUSENTE e a extensão decide; sem
 * extensão conhecida, o material é RECUSADO — nunca rebaixado.
 */
import { classificarMidiaComLegenda, type TipoDeMidiaComLegenda } from '@/lib/messaging/media/midia-com-legenda';
import { MAX_MEDIA_BYTES } from '@/lib/messaging/media/types';

/** O bucket PRIVADO dos materiais (migration 9222). */
export const BUCKET_DOS_MATERIAIS = 'crm-materiais';

/** O bucket em que a cópia da conversa mora — o mesmo das fotos e de toda mídia. */
export const BUCKET_DA_CONVERSA = 'whatsapp-media';

/** O teto do bucket e o do upload do Inbox: o material não é maior que uma mídia. */
export const TAMANHO_MAXIMO_DO_MATERIAL = MAX_MEDIA_BYTES;

/**
 * O prefixo do arquivo copiado na pasta da conversa.
 *
 * Determinístico de propósito, como `catalogo-` nas fotos (0390): reenviar o
 * mesmo material, ou o replay de um job que caiu depois da cópia, reaproveita o
 * arquivo em vez de encher a cota de Storage do cliente com duplicatas.
 */
export const PREFIXO_DO_MATERIAL_NA_CONVERSA = 'material-';

/** O que o material pode ser enviado como. */
export type TipoDeMaterial = Extract<TipoDeMidiaComLegenda, 'document' | 'image'>;

/** A forma do arquivo que a rota de upload grava em `crm-materiais`. */
const FORMA_DO_ARQUIVO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/;

/**
 * O caminho É desta organização, na forma que a rota de upload gera?
 *
 * ⚠️ Quem LÊ confere, não só quem escreve. A coluna é gravável pelo PostgREST e
 * a cópia é por service role (sem RLS): sem esta conferência, um caminho de
 * outra organização gravado na linha viraria um arquivo alheio assinado e
 * enviado ao cliente desta.
 */
export function materialPertenceAOrganizacao(caminho: string, orgId: string): boolean {
  const prefixo = `${orgId}/`;
  if (!caminho.startsWith(prefixo)) return false;
  return FORMA_DO_ARQUIVO.test(caminho.slice(prefixo.length));
}

/** O nome que o arquivo do material recebe na pasta da conversa. */
export function nomeDoMaterialNaConversa(caminho: string): string {
  const base = caminho.split('/').pop() ?? '';
  return `${PREFIXO_DO_MATERIAL_NA_CONVERSA}${base}`;
}

/** O destino da cópia: `whatsapp-media/<org>/<conversa>/material-<arquivo>`. */
export function destinoDoMaterialNoConversa(
  orgId: string,
  conversationId: string,
  caminho: string,
): string {
  return `${orgId}/${conversationId}/${nomeDoMaterialNaConversa(caminho)}`;
}

/**
 * O MIME EFETIVO do material, com o `octet-stream` rebaixado a "não declarado".
 *
 * Devolver `null` não é perder informação: é dizer a verdade — um
 * `octet-stream` gravado na linha não identifica arquivo nenhum.
 */
function mimeDeclarado(mime: string | null | undefined): string | null {
  const limpo = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  if (limpo === '' || limpo === 'application/octet-stream') return null;
  return limpo;
}

/**
 * O caminho como URL — para a régua ÚNICA poder ler a extensão.
 *
 * `classificarMidiaComLegenda` recebe uma URL (é o campo do editor dos passos
 * automáticos) e tira a extensão do `pathname`. O `storage_path` do material é
 * um CAMINHO de bucket, não uma URL: sem esta conversão, `new URL("org/x.pdf")`
 * lança, a extensão some e um material sem MIME declarado seria recusado por um
 * detalhe de forma — não por não ser identificável. O esquema `file:` preserva o
 * caminho inteiro e não inventa host.
 */
function caminhoComoUrl(caminho: string): string {
  return caminho.includes('://') ? caminho : `file:///${caminho}`;
}

/**
 * O tipo COM QUE este material pode sair, ou o motivo da recusa.
 *
 * PDF e imagem passam; `.webm` (e qualquer extensão que a régua não nomeia, sem
 * MIME declarado) é RECUSADO — a mesma extensão serve a áudio e a vídeo, e
 * mandar um como o outro é o envio errado que ninguém vê. Vídeo/áudio com MIME
 * declarado também não passam: material é documento ou imagem.
 */
export function tipoDeMaterial(
  caminho: string,
  mime: string | null | undefined,
): { ok: true; type: TipoDeMaterial; mime: string } | { ok: false; motivo: string } {
  const classificada = classificarMidiaComLegenda(caminhoComoUrl(caminho), mimeDeclarado(mime));
  if (!classificada.ok) {
    return {
      ok: false,
      motivo:
        'Este material não tem tipo identificável (nem MIME reconhecido, nem extensão conhecida), ' +
        'e não é enviado: mandá-lo como "arquivo genérico" faria o cliente receber algo que ninguém ' +
        'sabe o que é. Suba o material em PDF ou imagem.',
    };
  }
  if (classificada.type !== 'document' && classificada.type !== 'image') {
    return {
      ok: false,
      motivo:
        `Este material é ${classificada.type} — material da empresa é enviado como DOCUMENTO ` +
        '(PDF, planilha, apresentação) ou IMAGEM. Converta o arquivo antes de cadastrá-lo.',
    };
  }
  return { ok: true, type: classificada.type, mime: classificada.mime };
}

/**
 * O canal entrega este material?
 *
 * Instagram (direct) aceita PDF e imagem — nada de planilha, apresentação, zip
 * ou texto. É a regra do canal, não preferência: recusar aqui é o que evita a
 * ferramenta prometer ao modelo um envio que o transporte vai falhar.
 */
export function materialCompativelComCanal(
  type: TipoDeMaterial,
  mime: string,
  canal: string | null | undefined,
): boolean {
  if ((canal ?? '').toLowerCase() !== 'instagram') return true;
  return type === 'image' || mime === 'application/pdf';
}

/** O motivo, em texto que o MODELO lê, de o canal não aceitar este material. */
export function motivoIncompativelComCanal(canal: string): string {
  return (
    `O canal desta conversa é ${canal}, que só entrega PDF e imagem. ` +
    'Este material não pode ser enviado aqui — ofereça o conteúdo em texto ou diga que ' +
    'a empresa envia o arquivo por outro canal.'
  );
}

/** Bytes em texto curto para a mensagem de recusa. */
export function tamanhoLegivel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
