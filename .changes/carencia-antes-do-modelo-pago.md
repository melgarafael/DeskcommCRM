---
impacto: capacidade_nova
secao: adicionado
titulo: Primeiro contato com a janela de 24 h fechada espera o cliente escrever antes de gastar modelo aprovado
---
Quando um lead acaba de chegar por uma integração e a janela de 24 h está fechada, o único envio possível era um modelo aprovado, que é pago — mesmo quando o cliente escrevia no WhatsApp poucos segundos depois e a janela abria de graça. Agora o primeiro contato que gastaria modelo espera 10 segundos e confere a janela outra vez: se o cliente escreveu nesse intervalo, o atendimento segue em texto livre, sem modelo pago; se nada chegou, o modelo sai normalmente. A espera só vale para o primeiro contato de um lead recém-chegado, é configurável em `FOLLOWUP_CARENCIA_DO_MODELO_MS` e `0` desliga e devolve o comportamento anterior. Cada modelo dispensado fica registrado na linha do tempo do acompanhamento, para o ganho poder ser medido. Não muda o motor de follow-up, os gatilhos nem o teto de envio.
