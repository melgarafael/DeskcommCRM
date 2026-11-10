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

O par com identidade forte que se **contradiz** deixa de ser sugerido: dois CPFs
diferentes são duas pessoas, e dois telefones diferentes são duas fichas — o nome
sozinho não junta nenhum dos dois. A ficha sem número (a que nasce do WhatsApp)
continua sendo o par útil.

Sem migration: a opção é um booleano em `organizations.settings.crm`, como as
vizinhas.
