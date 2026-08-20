/**
 * Validação de configuração REST do Redis antes de construir o cliente Upstash.
 *
 * O valor deve ser o valor puro da variável de ambiente. Não aceitamos blocos
 * `.env`, aspas externas, espaços ou quebras de linha, pois isso pode gerar
 * headers inválidos e fazer o healthcheck reproduzir detalhes sensíveis.
 */
export type RedisConfigReason = "ok" | "nao_configurado" | "configuracao_invalida";

export type RedisConfigStatus = {
  ok: boolean;
  reason: RedisConfigReason;
};

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

export function validarConfigRedisRest(url: string | undefined, token: string | undefined): RedisConfigStatus {
  if (!url || !token) return { ok: false, reason: "nao_configurado" };

  if (!valorSemFormatacaoExtra(url) || !valorSemFormatacaoExtra(token)) {
    return { ok: false, reason: "configuracao_invalida" };
  }

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

export function redisConfigError(status: RedisConfigStatus): "not_configured" | "invalid_configuration" | undefined {
  if (status.reason === "nao_configurado") return "not_configured";
  if (status.reason === "configuracao_invalida") return "invalid_configuration";
  return undefined;
}
