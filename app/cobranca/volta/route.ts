import { respostaDePonte } from "@/lib/auth/ponte-de-volta";
import { marcaDaSaida } from "@/lib/branding/saida";
import { destinoDaVolta } from "@/lib/cobranca/url";

/**
 * A volta do provedor de pagamento (checkout, cancelamento do checkout, portal
 * de "Gerenciar pagamento"). Quem chega aqui é o NAVEGADOR que o provedor
 * devolveu — navegação vinda de outro site, onde o cookie de sessão
 * (`sameSite: "strict"`) não viaja. Mandar o provedor direto para
 * /app/settings/billing levava quem acabou de pagar à tela de login, logado
 * (e2e da primeira cobrança: `/login?next=%2Fapp%2Fsettings%2Fbilling%3Fvoltou%3D1`).
 *
 * Mesmo remédio da volta do Google e das redes sociais (issue #1646): um
 * documento nosso dispara a navegação seguinte, e aí o cookie viaja. Nada da
 * query é refletido: só a PRESENÇA de `voltou` e o valor exato `hub` escolhem
 * entre destinos fixos. Sem efeito nenhum — quem relê o provedor é a tela.
 */
export async function GET(request: Request) {
  const destino = destinoDaVolta(new URL(request.url).searchParams);
  const marca = await marcaDaSaida(null);
  return respostaDePonte(destino, marca.nome, "Voltando para o seu plano…");
}
