---
impacto: capacidade_nova
secao: adicionado
titulo: Você escolhe quais tabelas do banco conectado o assistente pode ler
---

Cada conexão de banco de dados externo passa a ter uma lista de fontes liberadas: o assistente e a grade só enxergam as tabelas e views que um administrador marcar, com a descrição que ele escrever, e só as colunas que ele liberar. Conexões que já existem continuam como estão: o assistente segue lendo tudo que o usuário do banco enxerga, até alguém marcar. Conexões novas começam com nada liberado, e o assistente avisa "nenhuma tabela foi liberada" até um administrador escolher; quem cria conexão por API precisa marcar as fontes em seguida. Por enquanto a marcação é feita pela API (`PUT /api/v1/external-db/connections/:id/sources`); o painel na tela é uma etapa separada.
