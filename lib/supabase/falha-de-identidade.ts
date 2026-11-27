interface FalhaDeIdentidade {
  name?: string;
  code?: string;
  status?: number;
}

const codigosDeSessao = new Set([
  "bad_jwt",
  "no_authorization",
  "session_not_found",
  "session_expired",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "user_not_found",
  "user_banned",
]);

/** O Auth pode ficar indisponível enquanto o cookie continua válido. */
export function identidadeIndisponivel(erro: FalhaDeIdentidade | null): boolean {
  if (!erro || erro.name === "AuthSessionMissingError" || erro.name === "AuthInvalidJwtError") return false;
  if (erro.name === "AuthRetryableFetchError") return true;
  if (erro.code && codigosDeSessao.has(erro.code)) return false;
  return erro.status !== 401 && erro.status !== 403;
}
