"use client";

import { useState } from "react";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import { ListaDeTarefas } from "@/app/app/tasks/_components/ListaDeTarefas";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useTasks } from "@/hooks/tasks/useTasks";
import { resumoDasTarefas, type NovaTarefa, type Tarefa } from "@/lib/tarefas/tipos";
import { Plus } from "@/lib/ui/icons";

interface Props {
  leadId: string;
  /** O contato do negócio vai junto na tarefa nova: a tarefa nasce presa aos dois. */
  contactId: string | null;
  /** Quem pode criar, concluir, editar e apagar — `agent`+, a mesma régua da rota. */
  podeEditar: boolean;
  /** O dossiê aberto. Fechado, a consulta não sai. */
  aberto: boolean;
}

/**
 * A seção "Tarefas" do dossiê: o que ficou combinado PARA ESTE negócio.
 *
 * A tabela, a rota e a lista já existiam (`crm_tasks`, `/api/v1/tasks`, tela de
 * Tarefas), e a tarefa já sabia ser presa a um negócio (`lead_id`) — mas a única
 * porta de criação era a tela de Tarefas, que não pergunta de qual negócio a
 * tarefa é. Na prática toda tarefa nascia avulsa, e as presas a um negócio só
 * vinham de automação. Aqui a tarefa nasce de dentro do card, já presa a ele.
 *
 * Nada de componente novo para a linha nem para o formulário: são OS MESMOS da
 * tela de Tarefas, para a régua de prazo, a confirmação de apagar e a regra de
 * reabrir (#2549) não divergirem entre os dois lugares.
 */
export function TarefasDoNegocio({ leadId, contactId, podeEditar, aberto }: Props) {
  const t = useT();
  const usuario = useUser();
  const [formAberto, setFormAberto] = useState(false);
  const [emEdicao, setEmEdicao] = useState<Tarefa | null>(null);
  // A chave de remontagem do formulário — o motivo está no `TarefasClient`.
  const [aberturas, setAberturas] = useState(0);

  const { tarefas, carregando, falhou, criarTarefa, editarTarefa, apagarTarefa, alternarConcluida } =
    useTasks({ lead_id: leadId }, { enabled: aberto });

  const resumo = resumoDasTarefas(tarefas);

  function abrirNova() {
    setEmEdicao(null);
    setAberturas((n) => n + 1);
    setFormAberto(true);
  }

  function abrirEdicao(tarefa: Tarefa) {
    setEmEdicao(tarefa);
    setAberturas((n) => n + 1);
    setFormAberto(true);
  }

  async function salvar(entrada: NovaTarefa) {
    if (emEdicao) await editarTarefa(emEdicao.id, entrada);
    else await criarTarefa(entrada);
  }

  return (
    <section className="border-b border-border py-3" aria-labelledby="dossie-tarefas">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3
          id="dossie-tarefas"
          className="text-xs font-medium uppercase tracking-wide text-text-muted"
        >
          {t("Tarefas")}
          {resumo.abertas > 0 ? (
            <span className="ml-1.5 normal-case tracking-normal">
              · {resumo.abertas} {resumo.abertas === 1 ? t("aberta") : t("abertas")}
              {resumo.atrasadas > 0 ? (
                <span className="font-semibold text-destructive">
                  {" "}
                  · {resumo.atrasadas}{" "}
                  {resumo.atrasadas === 1 ? t("atrasada") : t("atrasadas")}
                </span>
              ) : null}
            </span>
          ) : null}
        </h3>
        {podeEditar ? (
          <button
            type="button"
            onClick={abrirNova}
            className="flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            <Plus size={12} aria-hidden />
            {t("Nova tarefa")}
          </button>
        ) : null}
      </div>

      {falhou ? (
        <p className="text-xs text-destructive">{t("Não foi possível carregar as tarefas.")}</p>
      ) : carregando ? (
        <p className="text-xs text-text-muted" aria-busy>
          {t("Carregando…")}
        </p>
      ) : tarefas.length === 0 ? (
        // Vazio CURTO, e não o quadro tracejado da tela de Tarefas: no painel
        // estreito do dossiê ele empurraria a linha do tempo para baixo da dobra.
        <p className="text-xs text-text-muted">
          {t("Nenhuma tarefa neste negócio. Anote o próximo passo combinado, com prazo e responsável.")}
        </p>
      ) : (
        <div className="-mx-3">
          <ListaDeTarefas
            tarefas={tarefas}
            podeEditar={podeEditar}
            aoAlternarConcluida={alternarConcluida}
            aoEditar={abrirEdicao}
            aoApagar={(tarefa) => apagarTarefa(tarefa.id)}
            mostrarNegocio={false}
          />
        </div>
      )}

      <FormularioDeTarefa
        key={aberturas}
        aberto={formAberto}
        aoMudarAbertura={setFormAberto}
        tarefa={emEdicao}
        aoSalvar={salvar}
        leadId={leadId}
        contactId={contactId}
        responsavelPadrao={usuario.id}
      />
    </section>
  );
}
