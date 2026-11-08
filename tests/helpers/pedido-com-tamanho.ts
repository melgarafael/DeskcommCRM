/**
 * Upload de teste COM `content-length`, como o navegador manda.
 *
 * O `Request` do undici não põe o cabeçalho para corpo FormData ou string (o
 * tamanho só é calculado no envio), e as rotas de upload recusam envio sem
 * tamanho declarado (`lib/api/corpo-com-teto.ts`). Aqui o corpo é serializado
 * uma vez e reenviado como bytes, com o `content-type` (boundary inclusive) e o
 * tamanho que ele tem de verdade.
 */
import { NextRequest } from "next/server";

type Init = ConstructorParameters<typeof NextRequest>[1];

export async function pedidoComTamanho(url: string, init: Init = {}): Promise<NextRequest> {
  const serializado = new Request(url, init as RequestInit);
  const bytes = new Uint8Array(await serializado.arrayBuffer());
  const headers = new Headers(serializado.headers);
  // Um teste que declara tamanho de propósito (o 413 antes da leitura) é respeitado.
  if (!headers.has("content-length")) headers.set("content-length", String(bytes.byteLength));
  return new NextRequest(url, { method: init.method ?? "POST", headers, body: bytes });
}
