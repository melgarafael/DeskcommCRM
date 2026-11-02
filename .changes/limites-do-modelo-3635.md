---
impacto: capacidade_nova
secao: adicionado
titulo: Modelo de mensagem passa a conferir os limites da Meta e o exemplo de cada variável antes do envio
---

O formulário aceitava corpo de qualquer tamanho e uma variável `{{n}}` sem valor de amostra, e quem reprovava era a Meta: horas depois, com um erro genérico que não dizia qual campo estourou. Pior, o campo de texto cortava em 1024 no próprio `onChange`, então quem colava 1500 caracteres via o texto parar no meio da palavra sem saber por quê. Agora os limites da plataforma ficam num módulo puro com a fonte declarada — corpo até 1024 caracteres, cabeçalho de texto e rodapé até 60, texto de botão até 25, URL de botão até 2000, até 10 botões —, cada campo tem contador na tela e vira erro visível quando estoura, e o envio fica bloqueado com a mensagem do campo culpado. A rota responde 422 nomeando o campo antes de falar com a Meta, e cada `{{n}}` do corpo exige um exemplo não vazio: a variável que ficou sem amostra, inclusive a salteada (`{{1}}` e `{{3}}`), é apontada pelo número. Contribuição de @webtecnica (#3861).
