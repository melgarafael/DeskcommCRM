---
impacto: nada_mudou
secao: corrigido
titulo: O instalador não para mais em "Ativando as automações" numa VPS nova
---

Numa VPS recém-criada, o root ainda não tem agendamento nenhum, e o instalador
parava logo depois de "chave de cifra ativa no banco", sem mensagem de erro,
mostrando "A instalação parou" com o CRM já no ar. Rodar o instalador de novo
contornava. Agora ele agenda as automações e o agente de atualização direto,
na primeira rodada. Quem já instalou não precisa fazer nada. Crédito: @rafaelbatistazz.
