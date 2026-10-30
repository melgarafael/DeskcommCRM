import { sufixoDoMembro } from "@/lib/users/rotulo-do-atendente";

/** Rótulos de apresentação da agenda. Nunca altera o ID ou o responsável. */
export function textoDeIdentidade(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

export type TraduzirIdentidade = (texto: string) => string;
export interface IdentidadeDaAgenda {
  full_name: string | null;
  display_label: string;
}

export function identidadeDoResponsavel(
  id: string,
  usuario: { email?: unknown; user_metadata?: unknown } | null,
  indisponivel: boolean,
  t: TraduzirIdentidade = (texto) => texto,
): IdentidadeDaAgenda {
  if (indisponivel || !usuario) {
    return { full_name: null, display_label: `${t("Identidade indisponível")} · ${sufixoDoMembro(id)}` };
  }
  const metadata = usuario.user_metadata;
  const nome = textoDeIdentidade(
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).full_name
      : null,
  );
  const email = textoDeIdentidade(usuario.email);
  return {
    full_name: nome,
    display_label: nome ?? email ?? `${t("Sem nome ou e-mail")} · ${sufixoDoMembro(id)}`,
  };
}

/** DTO novo ou legado: somente texto, nunca HTML/metadata; fallback distinguível. */
export function rotuloDoResponsavel(
  id: string,
  rotulo: unknown,
  nome: unknown,
  t: TraduzirIdentidade = (texto) => texto,
): string {
  return textoDeIdentidade(nome) ?? textoDeIdentidade(rotulo)
    ?? `${t("Identidade indisponível")} · ${sufixoDoMembro(id)}`;
}
