---
impacto: capacidade_nova
secao: adicionado
titulo: Automações ganham o passo opcional "a IA decide", que escolhe uma entre as opções montadas na regra (por enquanto só pela API)
---

Uma regra de automação pode ter agora o passo `ai_decide`: quem monta a regra escreve uma instrução e de 2 a 6 opções, cada uma com uma ação comum (etiqueta, tarefa, mover o negócio, responsável, mensagem, chamar endereço externo). A IA lê o caso e devolve só o nome de uma opção, e quem executa a ação é o sistema, pelo mesmo caminho de sempre. Resposta fora da lista, vazia ou ilegível não executa nada, e o motivo aparece na aba Atividade.

É opcional por regra: empresa que não monta esse passo não muda nada e não gasta nada. **Gasta IA**: cada vez que a regra roda, há ao menos uma chamada ao modelo (duas, se a opção escolhida for responder pela IA), que entra no ponto de custo das automações e respeita o teto mensal da empresa; a regra só salva se declarar esse gasto (`custo_de_token: true`). Ainda **não tem tela**: a regra entra só pela API. A ficha mandada ao provedor de IA é uma lista fixa (a mensagem, os dados do negócio e as etiquetas). Os campos de identificação não saem: e-mail, telefone, nome do contato, título do negócio (que costuma ser o nome ou o telefone), identificadores internos e o CPF do cadastro. O texto da mensagem e os campos personalizados do negócio vão como estão, então um dado pessoal digitado ali sai junto. A senha de uma opção que chama endereço externo é guardada cifrada, como a de qualquer webhook. A trava contra laço infinito vale também para as ações dentro das opções.

Nada muda na configuração.

Contribuição de @webtecnica (#2228, Refs #1970).
