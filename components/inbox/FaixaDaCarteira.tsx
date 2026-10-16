"use client";

import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useCarteiraDoContato } from "@/hooks/contacts/useCarteiraDoContato";
import { useT } from "@/hooks/i18n/useT";
import { estadoDaCarteira, faixaDaCarteiraAparece } from "@/lib/carteira/tela";
import { UsersThree } from "@/lib/ui/icons";

interface Props {
  contactId: string;
  /** Responsável pela conversa (`conversations.assigned_to_user_id`) ou `null`. */
  quemAtendeId: string | null | undefined;
}

/**
 * FAIXA EM CIMA DO CHAT: "este cliente pertence à carteira de A" (#2591, regra 2).
 *
 * ─── O que ela responde, e por que ANTES de digitar ─────────────────────────
 *
 * O atendente precisa saber de quem é o cliente ANTES de prometer algo — é o que
 * a issue mede: o cliente do vendedor A escreve no número de B, B atende sem
 * saber, e o negócio novo nasce no nome de B. A faixa põe essa informação na
 * linha de visão de quem vai responder, não num painel que é preciso abrir.
 *
 * ─── Quando ela NÃO aparece (e cada ausência tem motivo) ────────────────────
 *
 *   sem dono gravar       → não há carteira de ninguém (regra 1: nada muda).
 *   dono não conta        → quem saiu da equipe ou só lê não é dono (regra 5):
 *                           avisar aqui prometeria a carteira de quem não tem.
 *   dono é quem atende    → o próprio dono atendendo não precisa de aviso.
 *
 * Só `outro_dono` vira faixa — a decisão é de `lib/carteira/tela.ts`, não deste
 * JSX, para a faixa e o cartão da ficha nunca divergirem sobre o mesmo contato.
 */
export function FaixaDaCarteira({ contactId, quemAtendeId }: Props) {
  const t = useT();
  const carteira = useCarteiraDoContato(contactId, true);
  // O nome do dono sai da mesma lista do cartão (uma fonte de nomes só). O teto
  // dela é `agent`+, o mesmo de quem vê a faixa.
  const membros = useAssignableMembers(true);

  const donoId = carteira.data?.dono_user_id ?? null;
  const estado = estadoDaCarteira(
    { dono_user_id: donoId, qualificado: carteira.data?.qualificado === true },
    quemAtendeId,
  );
  if (!faixaDaCarteiraAparece(estado)) return null;

  const membro = (membros.data ?? []).find((m) => m.user_id === donoId) ?? null;
  const nomeDoDono = membro?.full_name ?? t("outro vendedor");

  return (
    <div
      role="status"
      data-testid="faixa-da-carteira"
      className="flex w-full items-center gap-2 rounded-md border border-warning-fg/30 bg-warning-bg px-3 py-2 text-sm text-warning-fg"
    >
      <UsersThree size={16} weight="duotone" aria-hidden />
      <span className="min-w-0 break-words">
        {t("Este cliente pertence à carteira de {nome}.").replace("{nome}", nomeDoDono)}
      </span>
    </div>
  );
}
