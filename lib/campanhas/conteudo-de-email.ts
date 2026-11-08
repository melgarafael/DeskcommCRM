/**
 * O CONTEÚDO DE UM E-MAIL DE CAMPANHA (#3441, fatia E2a): assunto e corpo, com
 * limite e motivo explícito. Puro, sem banco e sem rede — a tela, a rota e a
 * gravação importam daqui, e é isso que faz "a mesma função valida na prévia e
 * no salvar".
 *
 * ─── Por que TEXTO PURO, e não HTML ─────────────────────────────────────────
 *
 * Esta fatia entrega conteúdo, público e validação; o ENVIO é a fatia seguinte.
 * HTML livre traria uma superfície inteira que ninguém pediu agora: sanitização
 * (o corpo vira mark-up que a tela renderiza), modelos visuais, imagens remotas
 * (rastreio de abertura, que a fatia de métricas vai decidir) e o par
 * texto/HTML que todo cliente de e-mail espera. Texto puro é o que a conta
 * Resend consegue mandar hoje sem inventar nada: o corpo vai como `text`, com
 * as quebras de linha que a pessoa escreveu. Markdown fica fora pelo mesmo
 * motivo — sem renderizador no envio, `**negrito**` chegaria literal ao cliente.
 *
 * ─── Os limites são NOMEADOS, e não números soltos na validação ─────────────
 *
 * O assunto tem limite porque é o que cabe na linha do cliente de e-mail, não
 * porque o banco reclama: acima de ~150 caracteres a maioria dos clientes corta
 * com reticências, e um assunto cortado no meio de uma frase é um e-mail que
 * parece spam. O corpo tem limite de 20.000 caracteres — muito acima de um
 * e-mail de campanha útil (uma lauda inteira) e muito abaixo do que faria a
 * linha de `campaigns.message_body` virar payload de banco.
 *
 * `message_body` é a MESMA coluna do texto do WhatsApp. Um corpo de e-mail não
 * precisa de coluna nova; o que precisa é de assunto, e esse ganhou
 * `campaigns.email_subject` (migration 9252).
 */
import type { ApiErrorCode } from "@/lib/api/errors";

/** O que cabe na linha de assunto sem o cliente cortar. */
export const LIMITE_DO_ASSUNTO_DO_EMAIL = 150;

/** Uma lauda de texto — muito acima de um e-mail de campanha útil. */
export const LIMITE_DO_CORPO_DO_EMAIL = 20_000;

export interface ConteudoDeEmail {
  assunto: string;
  corpo: string;
}

export type DecisaoDoConteudoDeEmail =
  | { ok: true; conteudo: ConteudoDeEmail }
  | { ok: false; codigo: ApiErrorCode; mensagem: string; status: number };

/**
 * Confere assunto e corpo de um e-mail de campanha.
 *
 * A ordem dos motivos é a que o operador lê: assunto antes de corpo porque é o
 * primeiro campo da tela; vazio antes de comprimento porque "escreva o assunto"
 * é acionável e "assunto com 151 caracteres" só interessa a quem já escreveu.
 *
 * Espaço em branco nas pontas não conta: um assunto de três espaços é vazio, e
 * o corpo é gravado com o `trim` que a conferência fez — senão a tela mostraria
 * um texto e o envio outro.
 */
export function conferirConteudoDeEmail(pedido: {
  email_subject?: string | null | undefined;
  message_body?: string | null | undefined;
}): DecisaoDoConteudoDeEmail {
  const assunto = (pedido.email_subject ?? "").trim();
  if (assunto === "") {
    return {
      ok: false,
      codigo: "campanha_email_assunto_vazio",
      mensagem: "Escreva o assunto do e-mail: é ele que o cliente vê antes de abrir.",
      status: 422,
    };
  }
  if (assunto.length > LIMITE_DO_ASSUNTO_DO_EMAIL) {
    return {
      ok: false,
      codigo: "campanha_email_assunto_longo",
      // A frase sai com o número já escrito: a chave do dicionário carrega o
      // mesmo texto (PT e ES), e mudar o limite exige mudar os três.
      mensagem: `O assunto do e-mail passa de ${LIMITE_DO_ASSUNTO_DO_EMAIL} caracteres: o cliente corta o resto.`,
      status: 422,
    };
  }

  const corpo = (pedido.message_body ?? "").trim();
  if (corpo === "") {
    return {
      ok: false,
      codigo: "campanha_email_corpo_vazio",
      mensagem: "Escreva o corpo do e-mail.",
      status: 422,
    };
  }
  if (corpo.length > LIMITE_DO_CORPO_DO_EMAIL) {
    return {
      ok: false,
      codigo: "campanha_email_corpo_longo",
      mensagem: `O corpo do e-mail passa de ${LIMITE_DO_CORPO_DO_EMAIL} caracteres.`,
      status: 422,
    };
  }

  return { ok: true, conteudo: { assunto, corpo } };
}
