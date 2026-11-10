/**
 * Os cabeçalhos de requisição que um Server Component recebe depois do
 * `proxy.ts`, montados como o Next os monta: só os nomes listados em
 * `x-middleware-override-headers`, cada um com o valor de
 * `x-middleware-request-<nome>`. O que o proxy gravou na requisição DEPOIS do
 * `NextResponse.next` não está nessas duas listas e não chega.
 *
 * Quem chama mocka `@supabase/ssr` (o proxy valida a sessão).
 */
export async function cabecalhosQueOProxyEntrega(
  url: string,
  doNavegador?: Record<string, string>,
): Promise<Headers> {
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  const resposta = await proxy(new NextRequest(url, { headers: doNavegador }));
  const nomes = (resposta.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
  const entregues = new Headers();
  for (const nome of nomes) {
    const valor = resposta.headers.get(`x-middleware-request-${nome}`);
    if (valor !== null) entregues.set(nome, valor);
  }
  return entregues;
}
