---
impacto: capacidade_nova
secao: adicionado
titulo: Na conversa com a janela de 24h fechada, escolher um modelo aprovado mostra a prévia da mensagem completa, atualizada enquanto você preenche
---
Ao escolher um modelo aprovado numa conversa com a janela de 24h fechada, o painel passa a mostrar a mensagem como o contato vai recebê-la: cabeçalho, corpo, rodapé, botões e itens de carrossel, com cada {{n}} trocado pelo valor que você digita, na hora. O que ainda falta preencher continua destacado como {{n}}, e o envio segue bloqueado enquanto houver campo obrigatório vazio. Cabeçalho de imagem ou vídeo é desenhado a partir do link informado. Quando o agente de IA envia um modelo, os guardrails de conteúdo passam a avaliar o texto com cada valor no seu lugar: antes, num modelo com {{1}} no cabeçalho, no corpo e no botão, eles liam o valor do campo errado. Não é preciso fazer nada na instalação.

Contribuição de @webtecnica (#2539), a partir da issue #2446 de @Fabio-Ribeir0.
