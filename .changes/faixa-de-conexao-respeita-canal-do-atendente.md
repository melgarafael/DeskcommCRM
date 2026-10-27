---
impacto: nada_mudou
secao: corrigido
titulo: A faixa de conexão caída respeita as regras de acesso da sessão
---

A faixa de conexão caída passa a consultar os canais com a identidade da pessoa
conectada, aplicando as mesmas regras de acesso no banco que a listagem de
canais já usa.

No produto padrão, a visibilidade continua sendo por organização. Esta correção
não cria uma divisão de canais por atendente. O cenário da instalação adaptada
relatado no issue #3088 ainda depende de conferir a regra específica usada ali.

Não é preciso alterar a configuração da instalação.

Contribuição de @webtecnica (Refs #3088).
