/**
 * "ESTE NEGÓCIO JÁ TEM UMA CÓPIA ABERTA NESTE FUNIL" — o `23505` de UM índice,
 * reconhecido num lugar só (#5281).
 *
 * O índice único `crm_leads_clone_aberto_no_funil_uidx` (migration 9496) recusa a
 * segunda cópia ABERTA do mesmo negócio de origem no mesmo funil. Quem cria a
 * cópia já trata a recusa reaproveitando a existente (`clone-com-anexos.ts`). Os
 * caminhos que MOVEM ou REABREM um card também batem nele: reabrir uma cópia
 * encerrada quando outra do mesmo negócio está aberta no funil, ou levar uma cópia
 * para o funil onde já há outra. Sem esta régua isso chegava como 500.
 *
 * O discriminador é o NOME do índice e não só o código: `23505` é de qualquer
 * índice único, e `crm_leads` tem outros (`uniq_crm_leads_org_source_external`).
 * Mesmo desenho de `lib/ai/agents/nome-repetido.ts`.
 */
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

export const INDICE_COPIA_ABERTA_NO_FUNIL = "crm_leads_clone_aberto_no_funil_uidx";

/** O código estável da recusa (também em `lib/api/errors.ts`). */
export const CODIGO_COPIA_ABERTA_NO_FUNIL = "copia_aberta_no_funil";

/** A frase em português — a CHAVE do dicionário. */
export const COPIA_ABERTA_NO_FUNIL =
  "Este negócio já tem uma cópia aberta neste funil. Continue o atendimento por ela.";

/** O erro do banco é a recusa deste índice? */
export function ehCopiaAbertaRepetida(
  erro: { code?: string | null; message?: string | null; details?: string | null } | null | undefined,
): boolean {
  if (erro?.code !== "23505") return false;
  return [erro.message, erro.details].some(
    (texto) => typeof texto === "string" && texto.includes(INDICE_COPIA_ABERTA_NO_FUNIL),
  );
}

/** A recusa de negócio (409) — ou `null` quando o erro não é deste índice. */
export function recusaDeCopiaAbertaPeloBanco(
  erro: { code?: string | null; message?: string | null; details?: string | null } | null | undefined,
  idioma?: Idioma | null,
): { codigo: typeof CODIGO_COPIA_ABERTA_NO_FUNIL; mensagem: string } | null {
  if (!ehCopiaAbertaRepetida(erro)) return null;
  return {
    codigo: CODIGO_COPIA_ABERTA_NO_FUNIL,
    mensagem: traduzir(COPIA_ABERTA_NO_FUNIL, idioma ?? IDIOMA_PADRAO),
  };
}
