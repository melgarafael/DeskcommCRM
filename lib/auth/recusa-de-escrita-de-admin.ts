/**
 * A recusa de ESCRITA de platform admin — o código e a frase que a tela mostra.
 *
 * Sem `next/*` nem Supabase: o servidor lança com estas frases
 * (`requirePlatformAdminEscrita`) e o formulário do cliente as traduz pela
 * mesma tabela, então as duas pontas não divergem.
 */
export const MENSAGEM_DA_RECUSA_DE_ESCRITA = {
  forbidden_scope: "Seu acesso à administração da plataforma é somente leitura.",
  mfa_required: "Confirme a verificação em duas etapas nesta sessão.",
} as const;

/** Código de `lib/api/errors.ts`. */
export type CodigoDaRecusaDeEscrita = keyof typeof MENSAGEM_DA_RECUSA_DE_ESCRITA;

/** O que uma server action devolve quando a escrita é recusada. */
export type RecusaDeEscritaDeAdmin = { ok: false; error: CodigoDaRecusaDeEscrita };

export function ehRecusaDeEscrita(codigo: unknown): codigo is CodigoDaRecusaDeEscrita {
  return typeof codigo === "string" && Object.hasOwn(MENSAGEM_DA_RECUSA_DE_ESCRITA, codigo);
}

/** Platform admin que existe mas não pode ESCREVER. */
export class EscritaDePlatformAdminNegada extends Error {
  constructor(
    readonly code: CodigoDaRecusaDeEscrita,
    message: string = MENSAGEM_DA_RECUSA_DE_ESCRITA[code],
  ) {
    super(message);
    this.name = "EscritaDePlatformAdminNegada";
  }
}
