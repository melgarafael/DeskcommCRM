import { redirect } from "next/navigation";
import { z } from "zod";

/**
 * A porta do link do e-mail de prazo da LGPD (`lib/lgpd/sla-alarm.ts`).
 *
 * O e-mail é montado num momento e clicado em outro; a empresa pode ser
 * suspensa ou reativada no meio. Por isso o link não escolhe `/app` nem o hub:
 * aponta para cá, e daqui o pedido segue ao hub `/account-suspended`, que
 * decide NO CLIQUE com as duas réguas do layout de `/app` — empresa parada vê o
 * pedido no hub; empresa que opera é devolvida a `/app/lgpd/requests/<id>`.
 *
 * Fora de `app/app/` (o layout de `/app` desviaria sem o pedido) e fora de
 * `lib/auth/public-paths.ts` de propósito: sem sessão, é o proxy que manda ao
 * login com `next=` e traz o DPO de volta a este pedido. O hub é público, e o
 * `requireAuth` dele manda ao login sem `next`.
 *
 * Nenhuma leitura aqui: quem autoriza o pedido é a página/rota de destino.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<never> {
  const { id } = await params;
  // Só uuid entra no destino: sem open-redirect nem caminho injetado.
  redirect(z.uuid().safeParse(id).success ? `/account-suspended?pedido=${id}` : "/app");
}
