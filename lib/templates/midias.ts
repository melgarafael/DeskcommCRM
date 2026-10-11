/**
 * AS IMAGENS DA RESPOSTA RÁPIDA — as regras que a rota de upload, a tela de
 * criação/edição e o compositor compartilham (issue #2526).
 *
 * O banco guarda a DESCRIÇÃO (`storage_path` + mime + tamanho) em
 * `message_templates.midias` (migration 0630); os BYTES ficam no bucket
 * privado `whatsapp-media`, no prefixo `<org>/templates/<template>/`, gerado
 * pela rota — nunca aceito do cliente, como já faz `lib/catalogo/fotos.ts` para
 * as fotos do produto.
 *
 * O caminho é da MESMA forma da foto do produto (uuid + jpg|png) porque é a
 * mesma garantia que interessa: quem LÊ confere, não só quem escreve. A coluna
 * é gravável pelo PostgREST e a leitura do arquivo é por service role, sem RLS
 * — sem a conferência, um caminho de outra organização gravado na linha viraria
 * imagem alheia na tela ou, na remoção, arquivo alheio APAGADO pela rota.
 */
import { extensaoDe, farejarTipo } from "@/lib/branding/logo-arquivo";

/** Bucket privado compartilhado com o envio de mídia do atendimento. */
export const BUCKET_DAS_MIDIAS = "whatsapp-media";

/** O mesmo teto do CHECK da migration 0630 e do input do formulário. */
export const MAXIMO_DE_MIDIAS = 5;

/**
 * 5 MB: o teto da rota de upload e o de imagem do WhatsApp oficial. O bucket
 * `whatsapp-media` aceita até 50 MB; quem segura os 5 é a rota.
 */
export const TAMANHO_MAXIMO_DA_MIDIA = 5 * 1024 * 1024;

/** O que a linha guarda — e o que o compositor precisa para baixar e enviar. */
export interface MidiaDeTemplate {
  storage_path: string;
  media_mime: string;
  media_size_bytes: number;
}

const FORMA_DO_ARQUIVO =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/;

/** O prefixo que a rota de upload gera para um template. */
export function prefixoDoTemplate(orgId: string, templateId: string): string {
  return `${orgId}/templates/${templateId}/`;
}

/**
 * O caminho é DESTE template e tem a forma exata que a rota gera?
 *
 * Vale para quem grava (PATCH) e para quem apaga (DELETE): sem isto, um
 * `storage_path` de outra org enviado no corpo apagaria arquivo alheio.
 */
export function midiaPertenceAoTemplate(
  caminho: string,
  orgId: string,
  templateId: string,
): boolean {
  const prefixo = prefixoDoTemplate(orgId, templateId);
  return caminho.startsWith(prefixo) && FORMA_DO_ARQUIVO.test(caminho.slice(prefixo.length));
}

/** O mime sai do CAMINHO, que a rota escolheu pelos bytes — não do declarado. */
export function mimeDaMidia(caminho: string): "image/png" | "image/jpeg" {
  return caminho.endsWith(".png") ? "image/png" : "image/jpeg";
}

/**
 * A lista nova que a tela mandou no PATCH: só mantém e remove, nunca acrescenta.
 *
 * Imagem nova entra pelo upload, que é quem confere os bytes. Aceitar um
 * caminho inédito aqui seria aceitar um arquivo que ninguém conferiu — ou de
 * outro template. Espelha `conferirNovaOrdem` das fotos do produto.
 *
 * `mantidas` são as entradas da LINHA (na ordem pedida), não as do corpo: o
 * mime e o tamanho foram gravados pelo upload, e o PATCH não os reescreve.
 */
export function conferirMidias(
  atual: readonly MidiaDeTemplate[],
  nova: readonly MidiaDeTemplate[],
): { ok: true; mantidas: MidiaDeTemplate[]; removidas: string[] } | { ok: false } {
  if (nova.length > MAXIMO_DE_MIDIAS) return { ok: false };
  const caminhos = nova.map((m) => m.storage_path);
  if (new Set(caminhos).size !== caminhos.length) return { ok: false };
  if (caminhos.some((c) => !atual.some((a) => a.storage_path === c))) return { ok: false };
  return {
    ok: true,
    mantidas: caminhos.flatMap((c) => atual.filter((a) => a.storage_path === c)),
    removidas: atual.filter((a) => !caminhos.includes(a.storage_path)).map((a) => a.storage_path),
  };
}

/** O formatador de arquivo do logo, que aceita exatamente JPEG e PNG. */
export { extensaoDe, farejarTipo };
