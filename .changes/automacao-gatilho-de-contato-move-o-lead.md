---
impacto: nada_mudou
secao: corrigido
titulo: Automação por tag do contato deixa de criar lead repetido
---
Uma regra com gatilho "quando um contato ganhar uma tag" e ação "criar/mover lead no funil" criava um negócio novo toda vez que rodava, mesmo quando o contato já tinha um negócio aberto naquele funil — o contato acabava com vários leads iguais. E as ações seguintes da mesma regra, como "atribuir a um atendente", ficavam sem lead para agir, então a execução aparecia como "Parcial" na aba Atividade. Agora a automação move o negócio que o contato já tem no funil de destino, cria só quando não existe nenhum, e as ações seguintes passam a agir sobre esse lead. Leads criados em duplicidade antes desta versão continuam onde estão. Crédito: @rafaelbatistazz.
