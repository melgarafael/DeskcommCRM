// Fora do "use client" de propósito: page.tsx (servidor) lê esta lista, e um valor
// importado de módulo de cliente chega ao servidor como referência, não como o array
// (o `.find` quebrava a página inteira — só a execução real pegou).
export const ABAS_DA_COBRANCA = ["visao-geral", "conexao", "regua", "planos", "clientes"] as const;
export type AbaDaCobranca = (typeof ABAS_DA_COBRANCA)[number];
