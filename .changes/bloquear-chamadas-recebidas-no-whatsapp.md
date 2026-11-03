---
impacto: capacidade_nova
secao: adicionado
titulo: Bloquear chamadas de voz recebidas no WhatsApp
---
Em Configurações › Segurança, o administrador da empresa ganha a opção "Bloquear chamadas recebidas": quando alguém liga por voz para o WhatsApp dos números da empresa, a chamada é recusada sozinha. As mensagens continuam chegando. Vem desligada: nada muda para quem não ligar.

Junto vem um campo opcional, "Mensagem para quem ligou": quando preenchido, quem teve a chamada recusada recebe esse texto no WhatsApp (no máximo uma vez a cada 10 minutos por pessoa). Vazio, não manda nada.

Em Recursos opcionais, a chamada de voz da empresa passa a aparecer como recurso extra, com valor ainda a definir.

A atualização passa a assinar o evento `call.received` do WAHA; o contêiner do WAHA é recriado pelo `update.sh`, sem edição manual.
