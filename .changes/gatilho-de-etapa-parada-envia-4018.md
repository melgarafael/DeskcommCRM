---
impacto: nada_mudou
secao: corrigido
titulo: Regra de "lead parado N dias na mesma etapa" volta a enviar WhatsApp
---

A regra que usa o gatilho "Quando um lead ficar N dias na mesma etapa" com a ação de enviar WhatsApp parava no meio: o envio aparecia na Atividade como falha por fronteira de atendimento desatualizada, e a mensagem nunca saía. A causa é a mesma que já tinha sido corrigida para o gatilho de data do funil — o evento não era reconhecido como pertencente a um contato, e por isso a automação não conseguia provar em nome de quem estava enviando.

Agora o evento dessa regra é reconhecido como os demais do funil, e a mensagem é enviada. Nada muda para as regras que já funcionavam, e os gatilhos que nunca fizeram parte desse reconhecimento continuam recusados como antes.

Nada a fazer na sua instalação: a atualização aplica a correção e as regras existentes passam a enviar.
