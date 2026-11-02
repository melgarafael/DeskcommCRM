import "server-only";

import { randomUUID } from "node:crypto";

import type { TipoDeLogo } from "@/lib/branding/logo-arquivo";
import {
  BUCKET_DAS_FOTOS,
  extensaoDe,
  farejarTipo,
  TAMANHO_MAXIMO_DA_FOTO,
} from "@/lib/catalogo/fotos";
import { assertUrlDeMidiaSegura } from "@/lib/messaging/media/url-de-midia-externa";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A FOTO DA PLANILHA VIRA ARQUIVO NOSSO — a URL é só o meio de transporte.
 *
 * ─── Por que baixar, em vez de gravar o link ────────────────────────────────
 *
 * O agente manda a foto do produto quando o apresenta, e o que ele lê é
 * `catalog_products.fotos`: CAMINHOS dentro de `catalog-photos`, no formato
 * `<org>/<produto>/<uuid>.<ext>` (migration 0390). `fotoPertenceAoProduto`
 * confere esse formato justamente porque a coluna é gravável pelo PostgREST —
 * uma URL crua ali seria descartada na leitura, e a foto não chegaria ao
 * cliente. Guardar o arquivo também resolve o link que morre: o estoque da
 * revenda é regerado a cada pedido e a foto do anúncio vendido sai do ar.
 *
 * ─── O que a planilha NÃO decide ────────────────────────────────────────────
 *
 * Nem o caminho (gerado aqui, como no upload da tela), nem o tipo (sai da
 * assinatura dos BYTES, `farejarTipo` — o `content-type` do servidor de origem
 * é do outro lado), nem o tamanho (o mesmo teto do bucket). Quem escreve na
 * planilha escolhe só QUAL foto, e em que ordem.
 *
 * ─── A URL é entrada de fora, e o fetch é de DENTRO da rede ─────────────────
 *
 * `assertUrlDeMidiaSegura` é a mesma guarda do `media_url` do envio: esquema,
 * host literal privado e o IP RESOLVIDO (um hostname público que aponta para
 * 169.254.169.254 entregaria credencial de instância). Redirecionamento é
 * seguido à mão, uma casa por vez, com a guarda rodando de novo em cada
 * `Location` — `redirect: "follow"` deixaria o salto para o endereço interno
 * acontecer depois da conferência.
 */

/** O prazo de UMA foto. Catálogo com 5 fotos lentas não pode prender a rota. */
const PRAZO_MS = 15_000;

/** Quantos saltos ainda são "o mesmo link" (http→https, CDN do feed). */
const MAXIMO_DE_SALTOS = 3;

export type ResultadoDasFotos = { ok: true; caminhos: string[] } | { ok: false; motivo: string };

interface Pedido {
  orgId: string;
  produtoId: string;
  urls: readonly string[];
  /** O `traduzir` da rota: as frases são chaves inteiras do dicionário. */
  t: (texto: string) => string;
}

function frase(modelo: string, valores: Record<string, string>): string {
  // Uma passada só, com função: a URL vem de fora e um `$&` dentro dela não
  // pode virar outra coisa na substituição.
  return modelo.replace(/\{(\w+)\}/g, (_, nome: string) => valores[nome] ?? "");
}

/**
 * Lê o corpo aos poucos e PARA ao passar do teto — `null` quando passou.
 *
 * `arrayBuffer()` só deixaria conferir o tamanho depois de o corpo inteiro estar
 * na memória, e o `content-length` é opcional: uma origem em `chunked` mandaria
 * o que quisesse durante todo o prazo. Mesmo padrão de `lerLimitado`
 * (lib/prospecting/site-fetch.ts).
 */
async function lerAteOTeto(resposta: Response): Promise<Uint8Array | null> {
  const leitor = resposta.body?.getReader();
  if (!leitor) return new Uint8Array(0);
  const pedacos: Uint8Array[] = [];
  let recebido = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    recebido += value.byteLength;
    if (recebido > TAMANHO_MAXIMO_DA_FOTO) {
      await leitor.cancel().catch(() => undefined);
      return null;
    }
    pedacos.push(value);
  }
  const bytes = new Uint8Array(recebido);
  let posicao = 0;
  for (const pedaco of pedacos) {
    bytes.set(pedaco, posicao);
    posicao += pedaco.byteLength;
  }
  return bytes;
}

/** Devolve os BYTES e o tipo, ou o motivo em português, já traduzido, para a linha. */
async function baixar(
  url: string,
  t: Pedido["t"],
): Promise<{ bytes: Uint8Array; tipo: TipoDeLogo } | { motivo: string }> {
  let alvo = url;
  for (let salto = 0; salto <= MAXIMO_DE_SALTOS; salto += 1) {
    try {
      await assertUrlDeMidiaSegura(alvo);
    } catch {
      return {
        motivo: frase(t("a foto aponta para um endereço que o servidor não pode acessar: {url}"), {
          url: alvo,
        }),
      };
    }

    let resposta: Response;
    try {
      resposta = await fetch(alvo, {
        redirect: "manual",
        signal: AbortSignal.timeout(PRAZO_MS),
      });
    } catch {
      return { motivo: frase(t("não consegui baixar a foto: {url}"), { url: alvo }) };
    }

    const desvio = resposta.headers.get("location");
    if (resposta.status >= 300 && resposta.status < 400 && desvio) {
      alvo = new URL(desvio, alvo).toString();
      continue;
    }
    if (!resposta.ok) {
      return {
        motivo: frase(t("não consegui baixar a foto (HTTP {status}): {url}"), {
          status: String(resposta.status),
          url: alvo,
        }),
      };
    }

    // Recusa pelo tamanho DECLARADO sem ler nada (como a rota de fotos da tela);
    // a contagem durante a leitura é o check autoritativo.
    const declarado = Number(resposta.headers.get("content-length") ?? 0);
    if (declarado > TAMANHO_MAXIMO_DA_FOTO) {
      await resposta.body?.cancel().catch(() => undefined);
      return { motivo: frase(t("a foto passa de 5 MB: {url}"), { url: alvo }) };
    }
    const bytes = await lerAteOTeto(resposta);
    if (!bytes) {
      return { motivo: frase(t("a foto passa de 5 MB: {url}"), { url: alvo }) };
    }
    const tipo = farejarTipo(bytes);
    if (!tipo) {
      return {
        motivo: frase(t("o endereço não devolveu uma foto JPG ou PNG: {url}"), { url: alvo }),
      };
    }
    return { bytes, tipo };
  }

  return { motivo: frase(t("o link redireciona vezes demais: {url}"), { url }) };
}

/**
 * Baixa e guarda TODAS as fotos da linha, na ordem em que vieram — ou nenhuma.
 *
 * Meia lista é pior que nenhuma: a capa do produto seria a segunda foto da
 * planilha, e ninguém ligaria o desenho errado ao import. Na primeira falha o
 * que já subiu é apagado do bucket e o motivo volta para a linha, que a rota
 * recusa inteira (como faz com preço ilegível).
 */
export async function guardarFotosPorUrl(pedido: Pedido): Promise<ResultadoDasFotos> {
  const { orgId, produtoId, urls, t } = pedido;
  const caminhos: string[] = [];

  const limpar = async (): Promise<void> => {
    if (caminhos.length === 0) return;
    await createAdminClient().storage.from(BUCKET_DAS_FOTOS).remove([...caminhos]);
  };

  for (const url of urls) {
    const baixada = await baixar(url, t);
    if ("motivo" in baixada) {
      await limpar();
      return { ok: false, motivo: baixada.motivo };
    }
    const { tipo } = baixada;
    const caminho = `${orgId}/${produtoId}/${randomUUID()}.${extensaoDe(tipo)}`;
    const { error } = await createAdminClient()
      .storage.from(BUCKET_DAS_FOTOS)
      .upload(caminho, baixada.bytes, { contentType: tipo, upsert: false });
    if (error) {
      await limpar();
      return { ok: false, motivo: frase(t("não consegui guardar a foto: {url}"), { url }) };
    }
    caminhos.push(caminho);
  }

  return { ok: true, caminhos };
}
