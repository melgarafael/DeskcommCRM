---
impacto: capacidade_nova
secao: adicionado
titulo: O cliente pode ter um vendedor dono (carteira); o dono é avisado por tarefa quando o cliente escreve numa conversa que está com outro vendedor, e o negócio novo desse cliente nasce com ele
---

Um gerente ou administrador pode pôr um cliente na carteira de um vendedor, e os negócios abertos sem responsável desse cliente passam para o dono. A partir daí, o negócio novo desse cliente que chegar sem responsável nasce com o vendedor dono, e o dono recebe uma tarefa interna quando o cliente escreve numa conversa que já está com outro vendedor (uma tarefa por cliente enquanto ela estiver aberta; o cliente não recebe mensagem nenhuma). A primeira mensagem de uma conversa nova, que ainda não tem responsável, e as mensagens enviadas pelo vendedor não geram aviso. Vendedor que saiu da equipe ou passou a só leitura deixa de contar como dono, e excluir o login dele devolve os clientes ao fluxo normal. Por enquanto a carteira é definida pela API (`PATCH /api/v1/contacts/{id}/carteira`, gerente ou acima); o cartão na ficha do contato e a faixa no chat vêm depois (#2591). Nada muda para quem não usa: cliente sem carteira segue o rodízio de hoje, e a atualização não põe ninguém em carteira nenhuma. Nada precisa ser feito ao atualizar.

Proposta e desenho de @hudson-souza-mkt (#2591), implementação de @webtecnica (#2667).
