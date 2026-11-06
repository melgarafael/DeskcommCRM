/**
 * A MÍDIA DO ENCAMINHAMENTO — de ONDE ela sai para poder ser reenviada (#2835).
 *
 * ─── O defeito que este arquivo conserta ────────────────────────────────────
 *
 * O encaminhamento nascia com uma premissa errada escrita no cabeçalho:
 * a `media_url` da mensagem RECEBIDA seria "a URL do CDN público do WhatsApp", e
 * bastaria repassá-la ao `sendMessageHandler`. Medido no que o inbound grava de
 * verdade: no provedor de canal padrão da instalação é
 * `http://localhost:3000/api/files/...` (o endereço que o provedor de canal manda, porque o
 * compose não define URL pública) e na Meta é `meta-media:<id>`.
 *
 * O `sendMessageHandler` passa toda `media_url` SEM `media_storage_path` pela
 * guarda anti-SSRF antes de criar a linha. A medida dele, literal:
 *
 *   RECUSA http://localhost:3000/api/files/default/ABC.jpg  unsafe_url:https_required
 *   RECUSA meta-media:123456                                unsafe_url:scheme
 *   PASSA  https://cdn.exemplo.com/a.jpg
 *
 * Resultado: encaminhar uma imagem recebida devolvia 422 `unsafe_media_url` e a
 * pessoa via o texto técnico "media_url recusada".
 *
 * ─── O caminho primário: o OBJETO, não a URL do provedor ────────────────────
 *
 * O envio normal tem um segundo caminho, e é o do upload e o da mídia que o
 * worker `media-persist` guarda: `media_storage_path`. O handler ASSINA o objeto
 * no bucket `whatsapp-media` e manda a URL assinada — nenhuma URL crua do
 * provedor, e a guarda anti-SSRF não é sequer consultada (ela só olha
 * `media_url` sem path).
 *
 * E o objeto pode ser COPIADO de pasta: `storage.copy` já é a forma usada para
 * levar a foto do catálogo para a pasta da conversa
 * (`lib/agent-engine/agent/fotos-do-produto.ts`). Então o encaminhamento copia o
 * objeto para a pasta da conversa de DESTINO — posse validada pela MESMA régua
 * do envio (`isMediaPathOwnedBy`) — e manda por `media_storage_path`. A partir
 * daí o encaminhamento manda MÍDIA de verdade.
 *
 * O nome no destino é o nome do arquivo de origem (`{mensagem}.{ext}`, que já é
 * único): encaminhar a mesma mensagem duas vezes reaproveita o objeto em vez de
 * encher a cota do cliente com duplicatas.
 *
 * ─── O que sobra para a URL crua, e por quê ─────────────────────────────────
 *
 * Quando a mensagem AINDA não tem objeto nosso — a janela entre a chegada e a
 * persistência, ou uma persistência que falhou —, só resta a `media_url`. Aí
 * vale a régua do envio: se ela passa na guarda anti-SSRF (mídia EXTERNA de
 * verdade, `https://` público), é ela que vai; se não passa (`localhost`, esquema
 * estranho), o encaminhamento RECUSA com motivo traduzido — nunca repassando o
 * texto técnico da guarda para a tela.
 */
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { assertUrlDeMidiaSegura } from "@/lib/messaging/media/url-de-midia-externa";
import { createAdminClient } from "@/lib/supabase/admin";

/** O bucket em que vivem a mídia da conversa e a do catálogo. */
export const BUCKET_DA_MIDIA = "whatsapp-media";

/** O que o encaminhamento precisa saber da origem para resolver a mídia. */
export interface MidiaDaOrigem {
  organization_id: string;
  conversation_id: string;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
}

/**
 * O desfecho da resolução da mídia.
 *
 * `copia` e `externa` são os dois enviáveis; `aguardando`, `falhou` e
 * `fora_da_conversa` são recusas com motivo próprio, e `sem_midia` é a mensagem
 * que só tem texto.
 */
export type MidiaParaEncaminhar =
  /** Objeto nosso, já copiado para a pasta do destino. */
  | { tipo: "copia"; media_storage_path: string; media_mime: string | null }
  /** URL externa que passa na guarda anti-SSRF do envio. */
  | { tipo: "externa"; media_url: string; media_mime: string | null }
  /** A mídia chegou e ainda não está no nosso Storage: tente de novo. */
  | { tipo: "aguardando" }
  /** Objeto nosso que não copiou: Storage indisponível ou objeto ausente. */
  | { tipo: "falhou" }
  /**
   * Objeto fora da pasta da conversa de origem — a proposta em PDF, que mora no
   * bucket `propostas` (`{org}/{proposta}.pdf`). Nunca vai poder ser copiado,
   * então a recusa não pode dizer "tente de novo".
   */
  | { tipo: "fora_da_conversa" }
  | { tipo: "sem_midia" };

/** Copia um objeto dentro do bucket da mídia. `true` = o arquivo está no destino. */
export type CopiarObjeto = (origem: string, destino: string) => Promise<boolean>;

/**
 * A cópia por service role: a pasta de destino é de OUTRA conversa e o cliente
 * do request não tem por que poder escrever nela (nem o path sai do request).
 */
export function copiarObjetoNoStorage(): CopiarObjeto {
  return async (origem, destino) => {
    const { error } = await createAdminClient()
      .storage.from(BUCKET_DA_MIDIA)
      .copy(origem, destino);
    if (!error) return true;
    // Já copiado antes: o arquivo que precisamos está lá — é o desfecho de quem
    // encaminha a mesma mensagem duas vezes.
    if (
      /already exists/i.test(error.message) ||
      (error as { statusCode?: string }).statusCode === "409"
    ) {
      return true;
    }
    return false;
  };
}

/**
 * Resolve a mídia da mensagem de origem para o destino escolhido.
 *
 * A ordem é a do que dá certo primeiro: objeto nosso (o caso comum da mídia
 * recebida, já persistida) → URL externa segura → recusa com motivo.
 */
export async function resolverMidiaDoEncaminhamento(
  origem: MidiaDaOrigem,
  conversationIdDestino: string,
  copiar: CopiarObjeto = copiarObjetoNoStorage(),
): Promise<MidiaParaEncaminhar> {
  if (origem.media_storage_path) {
    // Só caminho desta organização E desta conversa: um path de fora copiaria o
    // arquivo de outro cliente para dentro desta conversa.
    if (!isMediaPathOwnedBy(origem.media_storage_path, origem.organization_id, origem.conversation_id)) {
      return { tipo: "fora_da_conversa" };
    }
    const nome = origem.media_storage_path.split("/").pop() ?? "";
    if (!nome) return { tipo: "falhou" };
    const destino = `${origem.organization_id}/${conversationIdDestino}/${nome}`;
    const copiou = await copiar(origem.media_storage_path, destino);
    if (!copiou) return { tipo: "falhou" };
    return { tipo: "copia", media_storage_path: destino, media_mime: origem.media_mime };
  }

  if (origem.media_url) {
    try {
      // A MESMA guarda que o envio aplica: a decisão de hoje é a do envio, e
      // amanhã muda junto com ele.
      await assertUrlDeMidiaSegura(origem.media_url);
    } catch {
      return { tipo: "aguardando" };
    }
    return { tipo: "externa", media_url: origem.media_url, media_mime: origem.media_mime };
  }

  return { tipo: "sem_midia" };
}
