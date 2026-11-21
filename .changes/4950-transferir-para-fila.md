---
impacto: capacidade_nova
secao: adicionado
titulo: Transferir a conversa para uma fila, sem escolher pessoa por pessoa
---

O diálogo "Transferir conversa" ganhou a aba **Fila**, ao lado de "Atendente" e "Número". Escolher uma fila grava o setor na conversa; com o interruptor **"Soltar o responsável atual"** ligado (padrão), a conversa passa a ser da fila e qualquer pessoa dela pode assumir — quem já estava nela continua no histórico como quem entregou.

É o gesto que faltava para o caso em que o cliente pede outro time: a Secretaria atendeu, o pai pediu a Pedagogia, e antes era preciso escolher uma pedagoga pelo nome — se ela estivesse em aula, a conversa ficava parada com ela. Agora a conversa fica com a Pedagogia, e a primeira pessoa disponível do setor assume.

A aba só aparece quando a conversa aceita mudar de fila: módulo Setores ligado, conversa não encerrada e papel de atendente para cima — a mesma régua do item "Mover para fila" do menu. O interruptor de soltar o responsável existe só quando a conversa está com quem transfere: a rota de liberar recusa quem não é o dono da conversa, e conversa sem dono já volta para a distribuição ao mudar de fila. Nenhuma fila é criada por aqui: com o módulo ligado e nenhuma fila cadastrada, a aba aparece dizendo que não há fila.

Contribuição de @webtecnica (#4952), a partir da proposta #4950.
