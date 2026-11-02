---
impacto: nada_mudou
secao: corrigido
titulo: O fluxo de follow-up respeita "Quando o contato tiver horário marcado" e registra o pulo com o motivo
---

A configuração publicada do follow-up aceita a escolha "Quando o contato tiver horário marcado" (`quando_ha_compromisso`), com "esperar", "enviar mesmo assim" e "não enviar". Por enquanto ela é gravada pela API e ainda não tem controle na tela. Ela valia nas automações e no caminho de texto fixo, mas o worker que roda os fluxos de follow-up (o que trabalha 24 horas) continuava sempre esperando: quem publicava "enviar mesmo assim" não via a mensagem sair, e quem publicava "não enviar" não via o pulo registrado — a mensagem simplesmente esperava o horário marcado e, no fim, saía.

Agora as duas escolhas valem também nesse caminho. Em "enviar mesmo assim", a mensagem do fluxo sai com o horário marcado. Em "não enviar", o passo é encerrado como pulado, com o motivo "contato com horário marcado" no histórico do acompanhamento, e sem gerar texto pela IA — o mesmo registro que os outros pulos do follow-up já usavam.

Quem não configurou nada continua exatamente como antes: o padrão é esperar, e o acompanhamento é retomado no horário, como sempre foi.

Você não precisa fazer nada.
