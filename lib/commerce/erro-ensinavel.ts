/**
 * Erro de commerce → resposta que o MODELO consegue usar, em vez de derrubar o turno.
 *
 * Antes só `CommerceCartError`/`PresentProductError` viravam resposta de ensino. Qualquer
 * `MagentoSoapError` (loja recusou, timeout, XML inesperado) caía em `noteRunError` e o job
 * inteiro falhava: em 20/09/2026 o agente já tinha dito "tive um erro aqui na inclusão" ao cliente
 * quando o job foi marcado `falhou` e reexecutado — o cliente ouvia o turno duas vezes.
 * Quem fala com o cliente é o modelo; ele só pode fazer isso se receber o motivo.
 *
 * Devolve `null` para erro que NÃO é de commerce (bug nosso, banco fora): esses continuam indo
 * para `noteRunError`, porque aí falhar o job e re-tentar é o comportamento certo.
 */
import { CommerceCartError } from "@/lib/commerce/cart";
import { PresentProductError } from "@/lib/commerce/present-product";
import { MagentoSoapError } from "@/lib/magento/soap";

export interface ErroEnsinavel {
  ok: false;
  error: { code: string; message: string };
}

export function erroEnsinavelDeComercio(err: unknown): ErroEnsinavel | null {
  if (err instanceof CommerceCartError || err instanceof PresentProductError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  if (err instanceof MagentoSoapError) {
    return err.code === "soap_fault"
      ? {
          ok: false,
          error: {
            code: "loja_recusou",
            message: `a loja recusou a operação: ${err.message.replace(/\s+/g, " ").trim()} — explique ao cliente em palavras simples e ofereça uma alternativa.`,
          },
        }
      : {
          ok: false,
          error: {
            code: "loja_indisponivel",
            message:
              "não consegui falar com a loja agora (instabilidade temporária) — avise o cliente que vai tentar de novo em instantes; não diga que a operação foi feita.",
          },
        };
  }
  return null;
}
