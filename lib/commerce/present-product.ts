/**
 * Monta a apresentação de UM produto para envio (Entrega 4 do plano de
 * concierge de compras, §7.1 `present_product`): confirma o produto ao vivo
 * na loja (preço/status — nunca confia só no cache de busca), busca a imagem
 * principal, baixa e sobe no Storage privado — pronto para o `send_message`
 * nativo do harness enviar pelo caminho governado (throttle, opt-out, janela).
 *
 * Não manda nada sozinho: devolve o material para quem chama (o `execute` da
 * tool `present_product` em `inbound-turn.ts`) passar pela cadeia de
 * guardrails, exatamente como `send_message` já faz para texto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  withMagentoSession,
  magentoGetProduct,
  magentoGetProductImages,
  magentoGetStock,
  type MagentoConnectionConfig,
} from "@/lib/magento/soap";

export class PresentProductError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "produto_nao_encontrado_no_catalogo"
      | "produto_indisponivel"
      | "produto_sem_estoque"
      | "produto_sem_imagem"
      | "download_imagem_falhou"
      | "upload_falhou",
  ) {
    super(message);
    this.name = "PresentProductError";
  }
}

export interface PresentProductInput {
  organizationId: string;
  integrationId: string;
  conversationId: string;
  storeView: string;
  config: MagentoConnectionConfig;
  externalId: string;
}

export interface PresentProductResult {
  storagePath: string;
  mime: string;
  productName: string;
  priceCents: number | null;
  productUrl: string | null;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // mesmo teto de imagem do upload manual (validateOutboundMedia)

export async function presentProduct(
  admin: SupabaseClient,
  input: PresentProductInput,
): Promise<PresentProductResult> {
  // IDs Magento não vêm do texto do modelo sem checagem (doutrina): o
  // `external_id` só é aceito se já estiver no cache de busca DESTA
  // integração — prova que veio de um `commerce_search_products` real, não
  // de invenção do modelo.
  const { data: cached } = await admin
    .from("commerce_products")
    .select("name, url_path")
    .eq("organization_id", input.organizationId)
    .eq("integration_id", input.integrationId)
    .eq("external_id", input.externalId)
    .maybeSingle();
  if (!cached) {
    throw new PresentProductError(
      "produto não está no catálogo importado desta loja — busque de novo antes de apresentar",
      "produto_nao_encontrado_no_catalogo",
    );
  }

  // Consulta ao vivo (plano §6.1): preço/status efetivos vêm do Magento na
  // hora, nunca do cache de busca.
  const info = await withMagentoSession(input.config, (sessionId) =>
    magentoGetProduct(input.config, sessionId, input.externalId, input.storeView),
  );
  if (info.status !== "1") {
    throw new PresentProductError("produto está desabilitado na loja agora", "produto_indisponivel");
  }

  // Estoque ao vivo: `status` habilitado NÃO quer dizer que dá para vender. Apresentar
  // com foto e preço algo que o carrinho vai recusar foi o defeito de 20/09/2026 (2 de 4
  // rendas sem estoque → lote recusado inteiro). Só recusa quando a loja CONFIRMA
  // is_in_stock=false; se a consulta falhar ou a loja não gerenciar estoque desse item,
  // segue — o carrinho ainda diz a verdade, e isto não pode derrubar a apresentação.
  const estoque = await withMagentoSession(input.config, (sessionId) =>
    magentoGetStock(input.config, sessionId, [input.externalId]),
  ).catch(() => []);
  const linhaEstoque = Array.isArray(estoque)
    ? estoque.find((e) => e.productId === input.externalId)
    : undefined;
  if (linhaEstoque && !linhaEstoque.isInStock) {
    throw new PresentProductError("produto está sem estoque na loja agora", "produto_sem_estoque");
  }

  const images = await withMagentoSession(input.config, (sessionId) =>
    magentoGetProductImages(input.config, sessionId, input.externalId, input.storeView),
  );
  const main = images.find((img) => img.types.includes("image")) ?? images[0];
  if (!main) {
    throw new PresentProductError("produto não tem imagem cadastrada na loja", "produto_sem_imagem");
  }

  const download = await fetch(main.url, { signal: AbortSignal.timeout(20_000) });
  if (!download.ok) {
    throw new PresentProductError(
      `não consegui baixar a imagem do produto (HTTP ${download.status})`,
      "download_imagem_falhou",
    );
  }
  const buffer = Buffer.from(await download.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new PresentProductError("imagem do produto excede o tamanho máximo aceito", "download_imagem_falhou");
  }
  const mime = download.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
  const ext = mime.split("/")[1] ?? "jpg";

  const storagePath = `${input.organizationId}/${input.conversationId}/commerce/${input.externalId}-${Date.now()}.${ext}`;
  const { error: uploadError } = await admin.storage
    .from("whatsapp-media")
    .upload(storagePath, buffer, { contentType: mime, upsert: false });
  if (uploadError) {
    throw new PresentProductError(`upload da imagem falhou: ${uploadError.message}`, "upload_falhou");
  }

  return {
    storagePath,
    mime,
    productName: cached.name as string,
    priceCents: info.price ? Math.round(parseFloat(info.price) * 100) : null,
    // `url_path` é relativo à RAIZ da loja, não ao endpoint SOAP (que tem
    // `/index.php/api/v2_soap/` no caminho) — usa só o origin do endpoint.
    productUrl: cached.url_path
      ? `${new URL(input.config.endpoint).origin}/${cached.url_path}`
      : null,
  };
}
