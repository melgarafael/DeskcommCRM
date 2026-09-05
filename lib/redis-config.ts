/**
 * A CONFIGURAÇÃO DO REDIS É CONFERIDA ANTES DE VIRAR CLIENTE.
 *
 * ─── O erro que isto nomeia ─────────────────────────────────────────────────
 *
 * `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` são `required()` puro em
 * `lib/env.ts` — sem `.url()`, sem forma. Qualquer texto passa pelo Zod. E a
 * forma errada mais comum não é digitação: é o `.env` do self-host levando junto
 * o que estava em volta do valor —
 *
 *     UPSTASH_REDIS_REST_URL="https://srh:80"      → as aspas entram no valor
 *     UPSTASH_REDIS_REST_TOKEN=UPSTASH_REDIS_REST_TOKEN=abc  → a linha inteira
 *     UPSTASH_REDIS_REST_TOKEN=abc\n               → a quebra vinda do heredoc
 *
 * Nenhum desses três é rejeitado por ninguém hoje. Os dois primeiros viram
 * header HTTP inválido; o terceiro, dependendo do runtime, levanta na hora de
 * montar o `fetch`. O sintoma é sempre o MESMO — o Redis "não responde" —, e ele
 * aponta para o contêiner, que está de pé.
 *
 * ─── Por que a checagem vale mais que o retry ───────────────────────────────
 *
 * Sem ela, cada chamada paga uma ida à rede que não tinha como dar certo, e o
 * aviso que sobra no log fala do Redis, não do arquivo que precisa ser editado.
 * A diferença entre "o Redis caiu" e "o seu `.env` está malformado" é a
 * diferença entre reiniciar um contêiner saudável e abrir o editor — e a casa já
 * pagou por essa confusão uma vez, na QA de instalação em VPS.
 *
 * ─── Escopo, dito em voz alta ───────────────────────────────────────────────
 *
 * Isto valida a FORMA do valor, nunca se ele funciona. URL bem formada com host
 * inexistente e token bem formado mas revogado passam por aqui e falham na rede,
 * que é onde essas duas coisas se descobrem. O que se ganha é separar "não dá
 * nem para tentar" de "tentei e não deu".
 *
 * Achado de @prevprocesso-maker no PR #465.
 */

export type RedisConfigReason = "ok" | "nao_configurado" | "configuracao_invalida";

export type RedisConfigStatus = {
  ok: boolean;
  reason: RedisConfigReason;
};

/**
 * O valor tem de ser o valor PURO da variável — sem o que envolvia ele no
 * arquivo. Espaço nas pontas, quebra de linha, tabulação e aspas sobrando são
 * todos sinais de que o recorte pegou mais do que o valor.
 */
function valorSemFormatacaoExtra(value: string): boolean {
  return (
    value === value.trim() &&
    !/[\r\n\t]/.test(value) &&
    !value.startsWith('"') &&
    !value.endsWith('"') &&
    !value.startsWith("'") &&
    !value.endsWith("'")
  );
}

export function validarConfigRedisRest(
  url: string | undefined,
  token: string | undefined,
): RedisConfigStatus {
  if (!url || !token) return { ok: false, reason: "nao_configurado" };

  if (!valorSemFormatacaoExtra(url) || !valorSemFormatacaoExtra(token)) {
    return { ok: false, reason: "configuracao_invalida" };
  }

  // O `.env` copiado com o nome da variável dentro do valor. Sem esta linha ele
  // passaria como token opaco — que é exatamente o que um token parece.
  if (token.startsWith("UPSTASH_REDIS_REST_TOKEN=") || url.startsWith("UPSTASH_REDIS_REST_URL=")) {
    return { ok: false, reason: "configuracao_invalida" };
  }

  try {
    const parsed = new URL(url);
    if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, reason: "configuracao_invalida" };
    }
  } catch {
    return { ok: false, reason: "configuracao_invalida" };
  }

  return { ok: true, reason: "ok" };
}
