---
impacto: capacidade_nova
secao: alterado
titulo: A limpeza de mídia antiga passa a alcançar o anexo de nota interna
---

A limpeza diária já apagava fotos, áudios e documentos do WhatsApp mais velhos que o prazo da empresa (padrão 365 dias, mínimo 30). O arquivo anexado a uma **nota interna** ficava fora dessa regra de prazo: enquanto a nota existisse, ele nunca saía, e numa VPS com 1 GB de armazenamento dividido com a mídia do WhatsApp esses anexos (até 50 MB cada) cresciam sem limite.

**Isto muda o que a versão 1.62.0 anunciou** ("enquanto a nota existir, o anexo continua lá"). A partir desta versão, a regra de prazo também alcança o anexo de nota que ainda existe, nas mesmas condições da mídia de conversa:

- o **mesmo prazo** da empresa, contado a partir da data da nota;
- o **mesmo interruptor** ("Limpeza automática de mídia antiga", nas configurações da empresa), que vem **ligado** por padrão: com ele desligado, a regra de prazo não apaga anexo de nota;
- a **mesma pausa**: enquanto a empresa tem um pedido de LGPD em andamento, a limpeza por prazo fica parada.

O que continua como era: o anexo de uma nota **apagada** sai no dia seguinte, com o interruptor ligado ou desligado, e o atendimento de um pedido de LGPD continua apagando os anexos do titular.

Quando o anexo vence, só o arquivo sai. A nota continua lá, com o texto, mas **sem aviso** de que teve um anexo (a mensagem, ao contrário, mostra "Mídia apagada pela política de retenção").

Quando isso começa a apagar: o anexo de nota existe desde a 1.62.0 (28/09/2026). Com o prazo padrão de 365 dias, nenhum vence antes de 28/09/2027. Com um prazo menor, os anexos mais velhos que ele saem na primeira limpeza depois de atualizar.

Você não precisa fazer nada. Quem quer guardar os anexos de nota desliga o mesmo interruptor, sabendo que ele também para a limpeza por prazo da mídia do WhatsApp.

Contribuição de @webtecnica (#2309), a partir da issue #1887.
