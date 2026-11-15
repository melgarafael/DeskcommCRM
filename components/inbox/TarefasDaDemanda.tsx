"use client";

import { useState } from "react";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import { ListaDeTarefas } from "@/app/app/tasks/_components/ListaDeTarefas";
import { Separator } from "@/components/ui/separator";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useTasks } from "@/hooks/tasks/useTasks";
import { resumoDasTarefas, type NovaTarefa, type Tarefa } from "@/lib/tarefas/tipos";
import { Plus } from "@/lib/ui/icons";

interface Props {
  /** A demanda vigente do atendimento (#2818). Sem ela, a seção mostra as tarefas do contato (#4630). */
  demandaId: string | null;
  /** O contato da conversa vai junto: a tarefa nasce presa à demanda E ao contato. */
  contactId: string | null;
  /** O negócio ativo do contato, quando houver: a tarefa também o aponta. */
  leadId?: string | null;
  /** Quem pode criar, concluir, editar e apagar — `agent`+, a mesma régua da rota. */
  podeEditar: boolean;
}

/**
 * A seção "Tarefas desta demanda" do inbox (#2818).
 *
 * O que a issue pede: o atendente está na conversa, combina algo com o cliente
 * ("te chamo amanhã") e precisa deixar o combinado SEM sair da tela e SEM
 * depender de nota de texto. A tabela, a rota e a lista já existiam — o que
 * faltava era a tarefa saber de qual ATENDIMENTO ela é, e nascer daqui já presa
 * a ele.
 *
 * Nada de componente novo para a linha nem para o formulário: são OS MESMOS da
 * tela de Tarefas (`ListaDeTarefas`, `FormularioDeTarefa`), para a régua de
 * prazo, a confirmação de apagar e a regra de reabrir (#2549) não divergirem
 * entre os lugares onde a tarefa aparece.
 *
 * A consulta é UMA, e a régua de "aberto" é a mesma da tela, via `useTasks`:
 * com demanda vigente, por `demanda_id` — o que ficou combinado NESTE
 * atendimento —; sem demanda, por `contact_id` (#4630), para a tarefa criada
 * pelo "Nova tarefa" do painel numa conversa sem demanda aparecer na conversa.
 * A rota filtra a organização pela sessão. Sem demanda e sem contato, o guarda
 * abaixo devolve `null` antes dos hooks: nenhuma consulta sai.
 */
export function TarefasDaDemanda({ demandaId, contactId, leadId, podeEditar }: Props) {
  // A seção desenha quando há demanda vigente OU contato identificado. O guarda
  // vem ANTES dos hooks: conversa sem contato não monta `useUser` nem `useTasks`.
  if (!demandaId && !contactId) return null;
  return (
    <>
      <Separator />
      <SecaoDeTarefasDaDemanda
        demandaId={demandaId}
        contactId={contactId}
        leadId={leadId}
        podeEditar={podeEditar}
      />
    </>
  );
}

function SecaoDeTarefasDaDemanda({ demandaId, contactId, leadId, podeEditar }: Props) {
  const t = useT();
  const usuario = useUser();
  const [formAberto, setFormAberto] = useState(false);
  const [emEdicao, setEmEdicao] = useState<Tarefa | null>(null);
  // A chave de remontagem do formulário — o motivo está no `TarefasClient`.
  const [aberturas, setAberturas] = useState(0);

  const { tarefas, carregando, falhou, criarTarefa, editarTarefa, apagarTarefa, alternarConcluida } =
    useTasks(
      demandaId
        ? { demanda_id: demandaId, aberto: true }
        : { contact_id: contactId ?? undefined, aberto: true },
      { enabled: true },
    );

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
    <section data-testid="inbox-tarefas-da-demanda">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-text">
          {demandaId ? t("Tarefas desta demanda") : t("Tarefas do contato")}
          {resumo.abertas > 0 ? (
            <span className="ml-1.5 font-normal text-muted-foreground">
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
            data-testid="inbox-nova-tarefa"
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
        <p className="text-xs text-muted-foreground" aria-busy>
          {t("Carregando…")}
        </p>
      ) : tarefas.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {demandaId
            ? t("Nenhuma tarefa nesta demanda. Anote o próximo passo combinado, com prazo e responsável.")
            : t("Nenhuma tarefa para este contato. Anote o próximo passo combinado, com prazo e responsável.")}
        </p>
      ) : (
        <ListaDeTarefas
          tarefas={tarefas}
          podeEditar={podeEditar}
          aoAlternarConcluida={alternarConcluida}
          aoEditar={abrirEdicao}
          aoApagar={(tarefa) => apagarTarefa(tarefa.id)}
          mostrarNegocio={false}
        />
      )}

      <FormularioDeTarefa
        key={aberturas}
        aberto={formAberto}
        aoMudarAbertura={setFormAberto}
        tarefa={emEdicao}
        aoSalvar={salvar}
        demandaId={demandaId}
        leadId={leadId ?? null}
        contactId={contactId}
        responsavelPadrao={usuario.id}
      />
    </section>
  );
}
