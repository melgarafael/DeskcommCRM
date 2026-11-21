"use client";

import { useT } from "@/hooks/i18n/useT";
import type { Sector } from "@/hooks/team/useSectors";
import type { SetorDaTarefa } from "@/lib/tarefas/setor-da-tarefa";

/**
 * O SELO DE SETOR DA TAREFA (#4883) — um só, para a lista e o quadro.
 *
 * O que ele desenha vem do SERVIDOR (`tarefa.setor`, decidido por
 * `setorDaTarefa`): o setor da conversa, o do negócio, ou — só quando não há
 * nenhum dos dois — o do responsável. O `origem` é o que impede o fallback de
 * mentir: quando o setor é o de quem tem a tarefa, o selo DIZ isso no título
 * acessível. Sem isso, "Viagens Nacionais" na tarefa de um cliente que pediu
 * Peru voltaria a parecer o tipo do atendimento.
 *
 * Sem `setores` (painel do inbox e dossiê do negócio não pedem setores), não há
 * chip — como antes.
 */
export function SeloDeSetor({
  setor,
  setores,
}: {
  setor?: SetorDaTarefa | null;
  setores: ReadonlyMap<string, Sector>;
}) {
  const t = useT();
  if (!setor) return null;
  const dados = setores.get(setor.id);
  // Setor apagado depois de o servidor responder: sem nome, sem selo.
  if (!dados) return null;

  const titulo =
    setor.origem === "responsavel"
      ? t("Setor do responsável — a tarefa não tem conversa nem negócio com setor")
      : undefined;

  return (
    <span
      title={titulo}
      aria-label={titulo}
      data-origem-do-setor={setor.origem}
      className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        backgroundColor: dados.color ? `${dados.color}18` : undefined,
        color: dados.color ?? undefined,
        borderColor: dados.color ? `${dados.color}35` : undefined,
      }}
    >
      {dados.name}
    </span>
  );
}
