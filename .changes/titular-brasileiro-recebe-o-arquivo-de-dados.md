---
impacto: capacidade_nova
secao: adicionado
titulo: Quem pede acesso aos próprios dados no Brasil recebe também o arquivo de dados, com todas as mensagens e sem as anotações da equipe
---

Quando um cliente pede acesso aos dados que a empresa tem sobre ele (LGPD, art. 18, II), o e-mail com o relatório em PDF passa a trazer também o link do **arquivo de dados** (`data.json`), com o mesmo prazo do relatório. Antes, o arquivo era montado e guardado, mas só quem estava em Portugal recebia o link.

O arquivo brasileiro passa a trazer **todas as mensagens** do cliente, e não só as 100 mais recentes, e a lista das partes do arquivo que chegaram no limite de registros (por exemplo, as mensagens que ele escreveu em grupos, que param em 100), como já acontecia em Portugal.

Antes de sair, o arquivo passa a perder o que é da equipe e não do cliente, no Brasil e em Portugal:

- a conversa interna da equipe com a IA sobre o caso, os avisos da Central sobre os compromissos dele e a divisão de honorários entre o escritório e o advogado;
- o nome e o telefone de funcionários;
- **o que a IA digitou em cada ação**: fica a lista do que ela fez (o nome de cada ação e quando rodou). O termo que a IA usa numa busca de contato pode ser o nome ou o telefone de outro cliente, e o que ela escreve ao chamar um atendente é texto para a equipe;
- **o que a IA digitou ao chamar um atendente** sai também do registro da passagem de atendimento: a razão, o que ela já tentou e a leitura dela do que o cliente quer, junto com o resumo montado para quem vai atender, que repetia esse texto. Fica que a conversa foi passada a uma pessoa, por qual motivo, quando, se o cliente foi avisado e as últimas palavras dele. Vale também para a passagem pedida por um sistema externo (pela integração MCP): o registro não guarda se quem pediu foi uma IA, uma integração ou uma pessoa, e por isso esse texto sai sempre;
- **o que a IA digitou no caso** aberto quando ela trava: o título, o resumo e o bloqueio que ela escreve ao abrir o caso para a equipe, e as notas e a nota de encerramento registradas pela integração MCP (pelo mesmo motivo: o registro não diz se foi uma IA, uma integração ou uma pessoa). Fica que o atendimento parou e foi para a equipe, quando, como terminou, cada passo da linha do tempo e o que o cliente informou;
- os identificadores internos do banco de dados. Os que o próprio cliente forneceu (por exemplo, nos campos personalizados) ficam;
- os dados técnicos do sistema, como o estado da sincronização com o Google Agenda, os horários da fila interna e os códigos de erro e de reenvio.

As anotações que a equipe escreve **sobre o cliente** (as notas internas da conversa, a anotação na comanda, as notas da base de empresas, o motivo de uma proposta recusada, a razão que uma pessoa da equipe escreveu ao escalar o caso e o texto da equipe no caso dele):

- **no Brasil** não vão no arquivo;
- **em Portugal** vão, com o texto e a data e **sem o nome de quem escreveu** nem o anexo da nota. Pelo RGPD, a opinião registrada sobre uma pessoa também é dado dela. Quem atende clientes em Portugal deve saber que o cliente pode ler essas notas ao pedir os próprios dados. A razão que uma pessoa escreveu ao passar o atendimento **pela integração MCP** não volta, pelo motivo acima.

O relatório em PDF não muda.

Nada a fazer na atualização.
