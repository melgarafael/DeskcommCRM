import { ApiError } from "@/lib/api/types";

/** O banco diz QUEM está ocupado (id); a frase na tela diz o nome (#3067). */
export function erroComNomeDoResponsavel(
  err: unknown,
  pessoas: ReadonlyArray<{ id: string; nome: string }>,
  frase: string,
): unknown {
  if (!(err instanceof ApiError) || err.code !== "responsavel_indisponivel") return err;
  const nome = pessoas.find((p) => p.id === err.details?.user_id)?.nome;
  if (!nome) return err;
  return new ApiError(err.status, err.code, err.details, err.requestId, frase.replace("{nome}", nome));
}
