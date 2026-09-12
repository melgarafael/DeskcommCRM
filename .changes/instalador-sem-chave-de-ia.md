---
impacto: nada_mudou
secao: corrigido
titulo: A instalação deixa de exigir chave de IA — dá para cadastrar depois pela tela
---

O instalador exigia uma chave de IA que **passasse numa chamada real** ao
provedor: sem ela, a instalação morria na Fase 2/4. Só que a documentação
(`docs/deploy-selfhost`) sempre prometeu outra coisa — *"deixe vazio e cadastre
a chave depois"* —, e o próprio sistema concorda com a doc: faltar todas as
chaves é um aviso, não um erro.

Agora o campo é opcional de verdade: dá para instalar sem abrir conta em
provedor de IA e cadastrar a chave depois pela tela, em **IA › Credenciais**,
onde ela fica cifrada no banco. A tela final da instalação lembra quem pulou o
passo, com o caminho exato.

Quem digita uma chave continua com ela validada na hora — o que mudou é que
pular deixou de ser erro.
