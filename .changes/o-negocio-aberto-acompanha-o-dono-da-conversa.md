---
impacto: nada_mudou
secao: corrigido
titulo: O negócio aberto do contato acompanha o dono da conversa em todo caminho que atribui
---
O negócio aberto do contato passa a seguir o novo responsável dentro da `fn_conversation_assign`, na mesma transação da troca de dono — e não mais numa chamada que só a tela fazia. Fecha os três caminhos que deixavam o card para trás: o Atendente transferindo, que batia na RLS de negócios e desistia; a transferência fora da tela (MCP `crm_assign_conversation` e chamada direta da função); e o Assumir do Inbox, que só preenchia card sem responsável. Medido no relatório da issue: **14 de 46 conversas com dono tinham negócio aberto com outro responsável**. A régua continua a mesma do #3177: um negócio aberto acompanha, nenhum não vira card novo, mais de um não é tocado. "Iniciar conversa" mantém o comportamento antigo e só preenche card **sem responsável**. Não muda tela, não muda permissão de ninguém e não contorna a RLS: com sessão, o card só se move se quem transfere já enxerga o dono atual, e quem recebe passa a enxergá-lo por ser o dono.
