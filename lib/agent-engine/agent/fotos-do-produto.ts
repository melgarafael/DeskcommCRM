/**
 * A FOTO VAI JUNTO — o agente apresenta o produto com a foto do catálogo.
 *
 * Ideia de @vgamkt, a partir do #1130 (lá, sob medida para uma loja de motos);
 * aqui, para todo nicho que cadastra produto com foto (migration 0390).
 *
 * O caminho do envio é o que o handler de mensagens JÁ sabe mandar: mídia com
 * `media_storage_path` em `whatsapp-media/<org>/<conversa>/…`, URL assinada curta
 * para o canal, nunca base64. Para chegar lá, a foto é COPIADA do catálogo para
 * a pasta da conversa. É essa cópia que a conversa possui: a inbox a mostra, a
 * LGPD a apaga junto com a conversa — e o catálogo não perde nada.
 *
 * O destino é determinístico (`catalogo-<arquivo>`): reenviar a mesma foto na
 * mesma conversa, ou o replay de um job que caiu depois da cópia, reaproveita o
 * arquivo em vez de encher a cota de Storage do cliente com duplicatas.
 */
import { BUCKET_DAS_FOTOS, fotoPertenceAoProduto, mimeDaFoto } from '@/lib/catalogo/fotos';
import { createAdminClient } from '@/lib/supabase/admin';

import type { Queryable } from '../queue/queue';
import { OK_KINDS, type BubbleOutcome } from './split-message';

/** Teto de legenda de imagem do WhatsApp. Texto maior sai como texto, antes das fotos. */
export const LIMITE_DA_LEGENDA = 1024;

const BUCKET_DA_CONVERSA = 'whatsapp-media';

export interface FotoParaEnvio {
  /** caminho em `whatsapp-media`, dentro da pasta da conversa */
  storagePath: string;
  mime: string;
}

/** Copia do catálogo para a conversa. `true` = o arquivo está no destino. */
export type CopiarFoto = (origem: string, destino: string) => Promise<boolean>;

interface Log {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export function copiarFotoNoStorage(log: Log): CopiarFoto {
  return async (origem, destino) => {
    const { error } = await createAdminClient()
      .storage.from(BUCKET_DAS_FOTOS)
      .copy(origem, destino, { destinationBucket: BUCKET_DA_CONVERSA });
    if (!error) return true;
    // Já copiada antes para esta conversa: o arquivo que precisamos está lá.
    if (/already exists/i.test(error.message) || (error as { statusCode?: string }).statusCode === '409') {
      return true;
    }
    log.warn('foto do catálogo não copiada para a conversa', { detalhe: error.message.slice(0, 120) });
    return false;
  };
}

export type FotosPreparadas =
  | { ok: true; fotos: FotoParaEnvio[]; tinha: number }
  | { ok: false; code: 'produto_nao_encontrado'; message: string };

/**
 * Acha o produto pelo código e deixa as fotos dele prontas na pasta da conversa.
 *
 * Produto que não existe (ou está desativado) é erro de ENSINO, antes de enviar
 * qualquer coisa: o modelo corrige o código e tenta de novo. Foto que não copia
 * NÃO derruba o envio — ela fica de fora e o texto sai (degradar para só texto);
 * `tinha` deixa quem chama dizer ao modelo que faltou foto.
 */
export async function prepararFotosDoProduto(
  db: Queryable,
  copiar: CopiarFoto,
  input: { tenantId: string; conversationId: string; codigo: string },
): Promise<FotosPreparadas> {
  const { rows } = await db.query<{ id: string; fotos: string[] | null }>(
    'select id, fotos from catalog_products where organization_id = $1 and codigo = $2 and ativo',
    [input.tenantId, input.codigo.trim()],
  );
  const produto = rows[0];
  if (!produto) {
    return {
      ok: false,
      code: 'produto_nao_encontrado',
      message:
        `não há produto ativo com o código ${JSON.stringify(input.codigo)} no catálogo. Use o ` +
        '`codigo` que crm_search_products devolveu, ou envie sem produto_codigo.',
    };
  }
  // Só caminho que é DESTE produto: a linha é gravável pelo PostgREST e a cópia
  // é por service role — sem o filtro, sairia foto de outra organização.
  const deste = (produto.fotos ?? []).filter((c) =>
    fotoPertenceAoProduto(c, input.tenantId, produto.id),
  );
  const fotos: FotoParaEnvio[] = [];
  for (const origem of deste) {
    const destino = `${input.tenantId}/${input.conversationId}/catalogo-${origem.split('/').pop()}`;
    if (await copiar(origem, destino)) fotos.push({ storagePath: destino, mime: mimeDaFoto(origem) });
  }
  return { ok: true, fotos, tinha: deste.length };
}

/**
 * Manda o texto com as fotos. O texto vira a LEGENDA da primeira foto — uma
 * mensagem só, que é como uma pessoa apresenta um produto no WhatsApp. Texto
 * acima do teto de legenda sai primeiro, como texto, e as fotos depois sem
 * legenda. Entre uma e outra, o mesmo jitter anti-ban das bolhas; para no
 * primeiro desfecho que não seja de sucesso, como `sendInBubbles`.
 *
 * `restantes` é quantas mensagens físicas o turno ainda pode mandar
 * (`max_sends_per_turn`), consultado ANTES de cada foto. Consultar uma vez só,
 * antes de tudo, não contava o texto que sai à parte quando passa do teto de
 * legenda (uma ou mais bolhas): com teto 3, um produto de 3 fotos e descrição
 * longa mandava 4 mensagens. Sem `restantes`, nenhum teto (quem chama decide).
 */
export async function enviarComFotos<T extends BubbleOutcome>(
  body: string,
  fotos: readonly FotoParaEnvio[],
  opts: {
    enviarTexto: (body: string) => Promise<T>;
    enviarFoto: (foto: FotoParaEnvio, legenda: string) => Promise<T>;
    sleep: (ms: number) => Promise<void>;
    jitter: () => number;
    restantes?: () => number;
  },
): Promise<T> {
  const cabeMaisUma = () => (opts.restantes?.() ?? Number.POSITIVE_INFINITY) > 0;
  const [capa, ...demais] = fotos;
  if (!capa || !cabeMaisUma()) return opts.enviarTexto(body);
  const legendaCabe = body.length <= LIMITE_DA_LEGENDA;
  let ultimo = legendaCabe ? await opts.enviarFoto(capa, body) : await opts.enviarTexto(body);
  for (const foto of legendaCabe ? demais : fotos) {
    if (!OK_KINDS.has(ultimo.kind)) return ultimo;
    if (!cabeMaisUma()) return ultimo;
    await opts.sleep(opts.jitter());
    ultimo = await opts.enviarFoto(foto, '');
  }
  return ultimo;
}
