---
impacto: nada_mudou
secao: corrigido
titulo: Em modo de teste, o link de reunião que a IA envia sai só para os números da lista de teste
---

Com a conexão em modo de teste antes de liberar a IA para todos, a IA já respondia só aos números da lista de teste, mas o envio automático do link de reunião não conferia essa lista. Um contato que tinha autorização de atendimento automático de antes e não estava na lista podia receber o link. Agora o envio confere a lista como os outros caminhos da IA: fora dela, o link não sai e o compromisso mostra o motivo. Não é preciso mexer no `.env` para atualizar.
