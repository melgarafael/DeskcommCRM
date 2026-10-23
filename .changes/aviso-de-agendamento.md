---
impacto: capacidade_nova
secao: adicionado
titulo: Aviso de agendamento no WhatsApp do dono, com resumo do dia às 7h
---

Nova tela em Configurações › Sua empresa › **Aviso de agendamento**. Ligada, ela manda pelo WhatsApp da própria empresa uma mensagem curta para o número escolhido sempre que um horário é marcado, remarcado ou cancelado: primeiro nome do cliente, serviço, dia e hora no fuso da empresa, quem atende e de onde veio (IA, equipe ou Google Agenda). Às 7h chega o resumo do dia, em ordem de horário e com o total. Das 22h às 7h não sai aviso individual: o que mudou nesse horário aparece no resumo.

Vem desligado. O padrão é usar o mesmo número do aviso de caso, e dá para escolher outro número. O botão "Enviar teste" manda uma mensagem de verdade. O envio respeita o espaçamento e o limite diário do número, cada mudança é avisada uma vez, e o número que recebe os avisos não pode ser uma conexão da própria empresa.

Remarcações e cancelamentos feitos pelo Google Agenda num compromisso criado no CRM agora geram os eventos `appointment.rescheduled` e `appointment.cancelled`. Antes eles não geravam evento nenhum, então automações e webhooks que escutam esses eventos passam a disparar também nesse caso.
