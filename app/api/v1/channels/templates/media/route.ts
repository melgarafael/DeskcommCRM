import type { NextRequest } from "next/server";

import { subirImagemDoCabecalho } from "@/lib/channels/templates-midia";
import { requireSupportWrite } from "@/lib/impersonate/support";

/**
 * A imagem do cabeçalho de uma definição do canal OFICIAL DIRETO (#3635).
 *
 * O upload é o mesmo em qualquer fonte de modelos — o arquivo vai para o nosso
 * storage e a plataforma baixa o link assinado na revisão —, então o handler é
 * literalmente o de `lib/channels/templates-midia.ts`. A rota existe separada
 * porque cada fonte de tela tem as suas rotas (`lib/channels/templates-fonte.ts`)
 * e a tela do canal oficial não deve apontar para uma URL que diz `partner`.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return subirImagemDoCabecalho(req);
}
