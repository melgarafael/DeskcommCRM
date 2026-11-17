---
impacto: nada_mudou
secao: corrigido
titulo: Em modo de teste, o compromisso mostra por que o link de reunião não saiu para quem está fora da lista
---

Com a conexão em modo de teste antes de liberar a IA para todos, a IA já respondia só aos números da lista de teste, mas o envio automático do link de reunião só conferia essa lista no último passo: para um contato fora dela, a mensagem ficava como falha na conversa e o envio era tentado de novo, sem o motivo no compromisso. Agora o envio confere a lista antes, como os outros caminhos da IA: fora dela, o link não sai e o compromisso mostra o motivo. Um número da lista, ou uma conta de Instagram ou Facebook marcada como testadora, recebe o link mesmo sem autorização anterior, como nas respostas da IA. Não é preciso mexer no `.env` para atualizar.
