/** Habilitar concessão de IA exige prova de origem no servidor integrador. */
export function assinaturaObrigatoriaAusente(
  atual: { authorize_ai_on_capture: boolean; secret_encrypted: unknown },
  patch: { authorize_ai_on_capture?: boolean; secret?: string | null },
): boolean {
  const ativa = patch.authorize_ai_on_capture ?? atual.authorize_ai_on_capture;
  const assinatura =
    patch.secret === undefined ? Boolean(atual.secret_encrypted) : Boolean(patch.secret);
  return ativa && !assinatura;
}
