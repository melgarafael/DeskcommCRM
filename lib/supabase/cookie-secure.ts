import { env } from "@/lib/env";

/**
 * Secure do cookie de sessão derivado do PROTOCOLO da URL pública do app —
 * não de NODE_ENV. Motivo (achado nº 8 do deploy VPS): self-host por HTTP
 * (sem TLS) com NODE_ENV=production setava Secure=true e o navegador
 * DESCARTAVA o cookie — login autenticava e voltava para a tela de login.
 * https → Secure (produção com TLS); http → não-Secure (self-host/porta alta).
 *
 * ATENÇÃO: precisa ler de `lib/env` (parse do objeto process.env em RUNTIME),
 * nunca por acesso literal `process.env` + `NEXT_PUBLIC_APP_URL` encadeados —
 * o compilador do Next INLINA esse acesso em build time, e a imagem genérica
 * builda com o
 * placeholder `https://placeholder.invalid` (Dockerfile), congelando
 * Secure=true para sempre, qualquer que seja o .env de runtime.
 */
export function cookieSecure(): boolean {
  return env.NEXT_PUBLIC_APP_URL.startsWith("https://");
}
