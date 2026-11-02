/** Empresas com ids próprios das sementes do curso; nunca inferir propriedade pela data. */
export const ORGANIZACOES_DE_EXEMPLO = new Set(
  Object.entries({ a7000000: 5, a7d00000: 3, a9100000: 2, a1c00000: 1, ab100000: 2, a9e00000: 1, ad000000: 3, a8000000: 3, c0b40000: 5 })
    .flatMap(([prefixo, total]) => Array.from({ length: total }, (_, i) => `${prefixo}-0000-4000-8000-${String(i + 1).padStart(12, "0")}`)),
);

export function validarOrganizacoesExtras(principal: string, extras: Array<{ id: string }>) {
  if (extras.some((x) => x.id === principal || !ORGANIZACOES_DE_EXEMPLO.has(x.id))) {
    throw new Error("recusado apagar organização principal ou dados fora das sementes conhecidas do curso");
  }
}

/** O acesso direto ao Postgres tem a mesma cerca que o client Supabase. Não exibir a URL. */
export function exigirBancoLocal(valor: string | undefined): string {
  if (!valor) throw new Error("defina SUPABASE_DB_URL para restaurar o App da Meta da bancada");
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new Error("SUPABASE_DB_URL inválida; conexão recusada");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("recusado: o Postgres direto da semente precisa ser local");
  }
  // pg-connection-string deixa ?host= e ?port= vencerem a autoridade do URL.
  // Aceitar só o ajuste de TLS impede também variantes codificadas e opções novas
  // de redirecionamento de passarem despercebidas por uma lista de bloqueio.
  for (const parametro of url.searchParams.keys()) {
    if (parametro !== "sslmode") {
      throw new Error("recusado: parâmetros de conexão além de sslmode não são permitidos na semente");
    }
  }
  return valor;
}

/** URL de bancada, sem credenciais, parâmetros ou caminhos que desviem o destino. */
export function exigirHttpLocal(valor: string): string {
  let url: URL;
  try { url = new URL(valor); } catch { throw new Error("URL local inválida"); }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("recusado: somente origem HTTP localhost da bancada");
  }
  return url.origin;
}
