import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";

/**
 * A chave do provedor é UMA para a instalação: um admin de empresa com um
 * script esgotaria o limite da conta e derrubaria a leitura, o checkout e a
 * régua de TODAS as empresas. 10 chamadas por minuto por org sobram para gente.
 */
export async function limiteDoProvedorPorOrg(orgId: string): Promise<boolean> {
  return (await checkRateLimit(`cobranca-provedor:${orgId}`, 10, 60)).allowed;
}

/**
 * A falha do provedor em linguagem de quem clicou (spec §7b): fora do ar é
 * "tente de novo" (503); recusa é "confira os dados" (502). Erro que não veio
 * do adaptador é defeito nosso e sobe.
 */
export function recusaDoProvedor(e: unknown): { status: 503 | 502; code: "provedor_indisponivel" | "provedor_recusou"; message: string } {
  if (!(e instanceof ErroDoProvedor)) throw e;
  return e.transitorio
    ? { status: 503, code: "provedor_indisponivel", message: "O provedor de pagamento não respondeu. Nada mudou; tente de novo em alguns minutos." }
    : { status: 502, code: "provedor_recusou", message: "O provedor de pagamento recusou o pedido. Tente de novo ou fale com quem administra o sistema." };
}
