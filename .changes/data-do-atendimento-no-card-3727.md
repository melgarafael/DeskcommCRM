---
impacto: capacidade_nova
secao: adicionado
titulo: "A automação grava a data do atendimento no card e a mensagem de manutenção sai N dias depois"
---

A clínica que precisa chamar de volta quem fez toxina a cada 4 ou 6 meses agora monta isso com duas regras, sem depender de alguém digitar data no card.

A primeira é `Quando alguém comparecer ao compromisso` → **Gravar a data do atendimento num campo do negócio**. É uma ação nova: você escolhe o funil e um campo de data dele, e a data do comparecimento vai para esse campo no dia em que a recepção marca "Realizado". O dia gravado é o do relógio da sua empresa, não o do servidor — um atendimento às 23h30 continua sendo o dia dele.

A segunda é `Quando faltarem N dias para uma data do funil`, que já existia: aponte para o mesmo funil e o mesmo campo, com **N negativo**. `-120` manda a mensagem 120 dias depois do atendimento; `-180`, meio ano. O prazo mora nessa regra, e não na ação — um campo só serve à manutenção de 4 meses e à de 6, e mudar o prazo é editar um número em vez de refazer a automação.

Remarcar o atendimento rearma o aviso sozinho: o gatilho de data já reconhece a data nova como um episódio novo. E a espera fica guardada no campo, não numa execução pendente — nada fica meses em fila e nenhum follow-up fica vivo segurando a vaga de "um follow-up vivo por contato".

A ação não cria card: ela grava no card do atendimento e, quando o compromisso não está ligado a um negócio, no card aberto daquele contato no funil escolhido. Sem card aberto e sem negócio, ela não faz nada e a Atividade diz que pulou.

Crédito: @webtecnica.
