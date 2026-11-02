---
impacto: capacidade_nova
secao: adicionado
titulo: A pergunta do roteiro de atendimento pode gravar a resposta no card do negócio, e cada negócio responde por si
---

Cada pergunta do roteiro de atendimento ganhou "Onde a resposta é guardada":
ficha do contato (o de sempre — e o padrão, inclusive para todo roteiro já
publicado) ou card do negócio. Com o card, o valor entra em
`crm_leads.custom_fields`, que é o que o card da tela, os campos obrigatórios da
etapa do funil e as automações por data leem.

O card do roteiro é escolhido UMA vez, no começo da execução, e vale até ela
terminar: fica gravado na trilha da própria execução, então editar outro negócio
do mesmo contato no meio do caminho não muda o destino da resposta. Contato com
um único negócio aberto não é perguntado — esse é o card. Com dois ou mais, a
ficha do contato pede a escolha antes de gravar, sem chutar "o mais recente"; até
alguém escolher, as respostas de negócio ficam pendentes. Roteiro que termina não
deixa vínculo para o próximo: uma execução nova resolve o card de novo, e a
pergunta de negócio é refeita para o novo negócio — o destino da viagem anterior
não vale para a viagem seguinte. Atenção: quem já concluiu o roteiro só começa
uma execução nova se o roteiro permitir recomeçar (desligado por padrão) ou se
alguém recomeçar pela ficha.

Pergunta sem essa marca continua gravando no contato, byte a byte como hoje, e a
ficha do contato mostra "no card do negócio" em vez de "não respondido" para a
resposta que mora no card.
