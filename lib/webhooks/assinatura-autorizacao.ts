/**
 * Qual opção da fonte exige assinatura configurada, e está sendo ligada sem ela.
 *
 * As figuras que dependem de PROVA DE ORIGEM têm a mesma régua, e por isso
 * moram na mesma pergunta: conceder IA a partir do formulário, ATUALIZAR o
 * card de um envio que chegou depois (#2316) e REAPROVEITAR o card aberto do
 * contato (#3101). São integração entre sistemas — o formulário HTML público,
 * que qualquer um posta, não tem como assinar, e não é por ele que um card
 * pode ser reescrito.
 *
 * Devolver QUAL opção pediu a assinatura (e não um `true` seco) é o que permite
 * à rota dizer o motivo certo em cada caso — a mensagem genérica fazia a pessoa
 * procurar o problema na tela errada.
 */
export type OpcaoQueExigeAssinatura = "ai" | "update_lead" | "reuse_lead";

export function opcaoSemAssinatura(
  atual: {
    authorize_ai_on_capture: boolean;
    update_existing_lead_on_capture?: boolean | null;
    reuse_open_lead_on_capture?: boolean | null;
    secret_encrypted: unknown;
  },
  patch: {
    authorize_ai_on_capture?: boolean;
    update_existing_lead_on_capture?: boolean;
    reuse_open_lead_on_capture?: boolean;
    secret?: string | null;
  },
): OpcaoQueExigeAssinatura | null {
  // `secret: null` REMOVE a assinatura da fonte; ausente mantém a que existe.
  // `patch.secret === undefined ? atual : patch` responde as duas perguntas com
  // uma leitura só, e nunca com o segredo em claro (que o patch traz e o banco
  // não devolve).
  const assinatura =
    patch.secret === undefined ? Boolean(atual.secret_encrypted) : Boolean(patch.secret);
  if (assinatura) return null;

  const ia = patch.authorize_ai_on_capture ?? atual.authorize_ai_on_capture;
  if (ia) return "ai";

  const atualiza =
    patch.update_existing_lead_on_capture ?? atual.update_existing_lead_on_capture ?? false;
  if (atualiza) return "update_lead";

  const reusa = patch.reuse_open_lead_on_capture ?? atual.reuse_open_lead_on_capture ?? false;
  if (reusa) return "reuse_lead";

  return null;
}

/**
 * A pergunta booleana de sempre — usada por quem só quer saber se HÁ uma opção
 * ligando sem assinatura. A rota usa `opcaoSemAssinatura` para dizer QUAL.
 */
export function assinaturaObrigatoriaAusente(
  atual: {
    authorize_ai_on_capture: boolean;
    update_existing_lead_on_capture?: boolean | null;
    reuse_open_lead_on_capture?: boolean | null;
    secret_encrypted: unknown;
  },
  patch: {
    authorize_ai_on_capture?: boolean;
    update_existing_lead_on_capture?: boolean;
    reuse_open_lead_on_capture?: boolean;
    secret?: string | null;
  },
): boolean {
  return opcaoSemAssinatura(atual, patch) !== null;
}
