---
impacto: capacidade_nova
secao: adicionado
titulo: A linha da mensagem some quando o campo está vazio
---

No texto da automação, do follow-up, do e-mail e da mensagem de campanha agora vale o bloco condicional `{{#campo}}...{{/campo}}`: o trecho entre a abertura e o fechamento só sai quando o campo tem valor, e quando o campo está vazio o trecho sai vazio. Se o bloco era o conteúdo inteiro de uma linha, a linha inteira some junto — o cliente para de receber o rótulo sozinho, como `🔢 Apólice:` sem nada depois.

O bloco também conversa com o modificador de data que já existe: `{{#data_inicio}}Início: {{data_inicio|data}}{{/data_inicio}}` sai com a data no idioma e no fuso da organização, e some quando a data não está preenchida. As telas de rascunho (Inbox) e de campanha mantêm a linha com a variável visível, para o operador ver o que falta preencher.

Nada muda para quem não usa o bloco: texto sem `{{#` continua saindo exatamente como hoje, e nenhuma automação já publicada precisa ser reeditada.

Crédito: @webtecnica.
