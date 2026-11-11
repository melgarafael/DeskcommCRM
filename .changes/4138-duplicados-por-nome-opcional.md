---
impacto: capacidade_nova
secao: adicionado
titulo: A sugestão de contato duplicado pelo nome vira opção da empresa, desligada por padrão
---

A tela Contatos › Duplicados mostrava "Parecidos — confira" para todo mundo: pares
sugeridos só pelo NOME, com a régua da Spec 31 (palavras raras em comum ou nome
inteiro contido). Em base de pessoa física o nome repete e a seção virava ruído; em
base de empresa prospectada ela é o único caminho medido para achar a mesma empresa
com dois telefones. Quem sabe qual dos dois mundos é o seu é quem opera.

Agora é uma opção por organização — Configurações › Atendimento, "Sugerir contatos
duplicados pelo nome" — e nasce **desligada**, inclusive para quem atualizar o
produto: desligada, a varredura por nome não roda, as dispensas nem são lidas, a
seção não aparece e a tela diz por quê. Ligada, o comportamento é o da Spec 31
inteiro, com "Não são a mesma empresa". Nada é fundido sozinho em nenhum dos dois
estados: a sugestão só abre a conferência, e juntar continua sendo um clique de
gestor.

O par com CPF que se **contradiz** deixa de ser sugerido: dois CPFs diferentes
são duas pessoas, e o nome sozinho não as junta. Telefone diferente não tira o
par da lista — a mesma empresa com dois números é justamente o par que a
sugestão existe para achar.

Sem migration: a opção é um booleano em `organizations.settings.crm`, como as
vizinhas.
