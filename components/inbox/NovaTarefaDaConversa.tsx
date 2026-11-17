"use client";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import { useTasks } from "@/hooks/tasks/useTasks";

/**
 * O formulário de tarefa aberto a partir da conversa (#4630) — pelo item
 * "Criar tarefa" do ⋯ do cabeçalho e pelo botão "Nova tarefa" do painel.
 *
 * Quem chama monta isto SÓ com o formulário aberto. Assim o `useTasks` (e a
 * busca dele) existe enquanto a pessoa cria a tarefa, e não em todo cabeçalho
 * e todo painel de toda conversa aberta — o mesmo desenho do convite e da
 * reserva no `ConversationHeader`.
 */
export function NovaTarefaDaConversa({
  contactId,
  leadId,
  demandaId,
  responsavelPadrao,
  aoFechar,
}: {
  contactId: string;
  leadId?: string | null;
  demandaId?: string | null;
  responsavelPadrao?: string | null;
  aoFechar: () => void;
}) {
  const { criarTarefa } = useTasks({ contact_id: contactId, aberto: true });
  return (
    <FormularioDeTarefa
      aberto
      aoMudarAbertura={(aberto) => {
        if (!aberto) aoFechar();
      }}
      aoSalvar={async (entrada) => {
        await criarTarefa(entrada);
      }}
      contactId={contactId}
      leadId={leadId ?? null}
      demandaId={demandaId ?? null}
      responsavelPadrao={responsavelPadrao ?? null}
    />
  );
}
