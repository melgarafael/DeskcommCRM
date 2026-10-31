---
impacto: capacidade_nova
secao: adicionado
titulo: Bloquear chamadas de voz recebidas no WhatsApp
---
Em Configurações › Segurança, o administrador da empresa ganha a opção "Bloquear chamadas recebidas": quando alguém liga por voz para o WhatsApp dos números da empresa, a chamada é recusada sozinha. As mensagens continuam chegando. Vem desligada: nada muda para quem não ligar.

Em Recursos opcionais, a chamada de voz da empresa passa a aparecer como recurso extra, com valor ainda a definir.

A atualização passa a assinar o evento `call.received` do WAHA; o contêiner do WAHA é recriado pelo `update.sh`, sem edição manual.
