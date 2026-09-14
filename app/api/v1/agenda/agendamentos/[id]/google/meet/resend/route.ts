import { requireSupportWrite } from "@/lib/impersonate/support";
import { meetingAction } from "../_action";

/**
 * Reenvio EXPLÍCITO do link, pedido por gente.
 *
 * Irmã de `retry` e `deliver`, e separada de propósito: o `deliver` devolve
 * `false` em estado `sent`, e esse `false` é a proteção contra clique duplo.
 * Reescrevê-lo ganharia o reenvio e perderia a proteção — envio em dobro para
 * cliente é pior que não-envio. A tela só dispara esta rota depois de
 * confirmação.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  return meetingAction(req, context, "resend");
}
