/**
 * O nome do cabeçalho que o webhook de ENTRADA exige de quem envia.
 *
 * Mora aqui, e não solto em cada arquivo, porque tem TRÊS leitores que precisam
 * concordar byte a byte: a rota que confere a assinatura, a tela que ensina o
 * integrador a montá-la, e quem integra do outro lado. Renomear invalida a
 * assinatura de todo integrador já configurado, e o sintoma para ele é um 401
 * sem explicação — por isso é contrato de fio, não detalhe interno.
 *
 * Módulo sem dependência de propósito: ele é importado por um client component,
 * e `lib/webhooks/inbound.ts` (que faz o HMAC) puxa `node:crypto`.
 */
export const HEADER_ASSINATURA_DE_ENTRADA = "x-deskcomm-signature";
