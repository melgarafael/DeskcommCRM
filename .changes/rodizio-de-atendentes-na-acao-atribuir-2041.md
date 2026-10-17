---
impacto: capacidade_nova
secao: adicionado
titulo: A ação "Atribuir a um atendente" das automações pode repartir os leads em rodízio entre várias pessoas
---

Na tela de Automações, a ação "Atribuir a um atendente" ganha a opção "Em rodízio entre estas pessoas". Você monta uma fila, na ordem que quiser, e cada lead que dispara a automação vai para a próxima pessoa da fila, voltando à primeira depois da última. Dá para subir, descer, pausar (a pessoa é pulada sem sair da fila) e tirar alguém. Quem saiu da equipe ou só tem acesso de visualização também é pulado. Leads que chegam ao mesmo tempo são repartidos sem repetir a pessoa. Quem recebe é avisado como em qualquer atribuição, e a aba Atividade mostra de quem foi a vez e em que posição da fila. Serve, por exemplo, para os leads de formulário, que nascem sem conversa e por isso não passavam pelo rodízio de conversas. As regras que já atribuem a uma pessoa fixa continuam iguais. A atualização cria uma tabela de histórico do rodízio e uma função no banco; não exige nenhuma ação de quem opera a instalação.

Desenho original de @hamiltonviana (#2269). Refs #2041.
