/**
 * O provedor Google está LIGADO nesta instalação?
 *
 * ─── Por que esta pergunta precisa ser feita aqui (issue #1652) ─────────────
 *
 * `supabase.auth.signInWithOAuth()` NÃO fala com o GoTrue: ele só monta a URL
 * do `/authorize` localmente e devolve `{ data: { url } }, error: null` — até
 * quando o provedor está desligado. Quem recusa é o `/authorize`, já no
 * navegador, e a recusa é uma página de JSON cru
 * (`{"code":400,"error_code":"validation_failed","msg":"Unsupported provider:
 * provider is not enabled"}`) para onde a pessoa é mandada SEM caminho de
 * volta. Por isso o ramo `google_indisponivel` da `signInWithGoogle` nunca
 * disparava: o `error` que ele esperava não existia.
 *
 * `GET {SUPABASE_URL}/auth/v1/settings` é público (basta a anon key) e traz
 * `external.google` — é a MESMA resposta que o GoTrue usa para decidir se
 * aceita o `/authorize`. Aqui, antes do redirect, ainda dá para recusar dentro
 * do CRM e mostrar a mensagem que a tela já sabe mostrar.
 *
 * ─── Por que `desconhecido` NÃO bloqueia ────────────────────────────────────
 *
 * Rede fora do ar, GoTrue dormindo, corpo ilegível, resposta ≠ 200, `external`
 * ausente: nada disso PROVA que o provedor está desligado. Tratar tudo como
 * "desligado" transformaria uma instalação que funciona num botão que passa a
 * mentir — e mentir no sentido oposto ao da issue: pessoa sem entrada com
 * Google que a instalação tem. Então a falha de leitura devolve
 * `desconhecido`, e quem o lê (a `signInWithGoogle`) segue o comportamento de
 * SEMPRE: tenta o redirect. O JSON cru continua sendo o pior caso conhecido,
 * que é exatamente o que ele era antes desta leitura existir — sem regressão.
 */
import { env } from "@/lib/env";

/** `ligado`/`desligado` = lido nas settings; `desconhecido` = não deu para ler. */
export type EstadoDoProvedorGoogle = "ligado" | "desligado" | "desconhecido";

/**
 * Prazo da leitura, que acontece DENTRO do clique de login: um GoTrue mudo não
 * pode deixar a pessoa esperando para sempre num botão — melhor cair no
 * `desconhecido` e tentar o redirect do que travar a tela.
 */
const PRAZO_MS = 4_000;

export async function estadoDoProvedorGoogle(): Promise<EstadoDoProvedorGoogle> {
  let resposta: Response;
  try {
    const base = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "");
    resposta = await fetch(`${base}/auth/v1/settings`, {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      cache: "no-store",
      signal: AbortSignal.timeout(PRAZO_MS),
    });
  } catch {
    return "desconhecido";
  }

  if (!resposta.ok) return "desconhecido";

  try {
    const corpo = (await resposta.json()) as { external?: { google?: unknown } } | null;
    const google = corpo?.external?.google;
    // Só um `false` EXPLÍCITO desliga. Ausente (GoTrue que não devolve o
    // campo, resposta que não é a das settings) é `desconhecido` — e não
    // "ligado", que seria inventar um estado que ninguém leu.
    if (typeof google !== "boolean") return "desconhecido";
    return google ? "ligado" : "desligado";
  } catch {
    return "desconhecido";
  }
}
