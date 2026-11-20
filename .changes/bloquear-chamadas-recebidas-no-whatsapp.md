---
impacto: capacidade_nova
secao: adicionado
titulo: Bloquear chamadas de voz recebidas no WhatsApp
---
Em Configurações › Segurança, o administrador da empresa ganha a opção "Bloquear chamadas recebidas": quando alguém liga por voz para o WhatsApp dos números da empresa, a chamada é recusada sozinha. As mensagens continuam chegando. Vem desligada: nada muda para quem não ligar. Chamada de grupo não é recusada, e se a leitura da opção ou o WAHA falharem, a ligação toca como antes.

A atualização passa a assinar o evento `call.received` do WAHA; o contêiner do WAHA é recriado pelo `update.sh`, sem edição manual.

Contribuição de @vinicoretecnologia-svg.
