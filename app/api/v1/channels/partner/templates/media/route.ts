import type { NextRequest } from "next/server";

import { subirImagemDoCabecalho } from "@/lib/channels/templates-midia";
import { requireSupportWrite } from "@/lib/impersonate/support";

/**
 * A imagem do cabeçalho de uma definição do canal INTERMEDIADO — subir do
 * computador, sem colar URL.
 *
 * A lógica mora em `lib/channels/templates-midia.ts` desde a #3635: o canal
 * oficial direto também gerencia modelo pela tela e precisa da MESMA porta, e o
 * upload não tem nada de específico de canal (o arquivo vai para o nosso
 * storage, não para o do provider). O porquê inteiro — por que não a rota de
 * mídia do inbox, por que URL assinada, por que 7 dias — está lá.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return subirImagemDoCabecalho(req);
}
