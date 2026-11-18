---
impacto: nada_mudou
secao: corrigido
titulo: Passo de modelo aprovado com a janela de 24 h já aberta não cobra mais modelo — a mensagem sai como texto livre
---

Quando um passo de acompanhamento aponta para um modelo aprovado do canal e a janela de 24 horas da conversa **já está aberta** — o cliente escreveu nas últimas 24 horas —, o envio deixou de gastar modelo aprovado, que é pago: o mesmo texto do modelo sai como mensagem livre, sem custo. É o texto que o cliente já receberia; o que muda é a via de envio. O passo não é pulado, então o contato recebe a mensagem como antes, e o dossiê do acompanhamento registra "Nenhum modelo pago foi enviado — a janela de 24 horas já estava aberta".

Modelos com botão ou carrossel continuam saindo como modelo aprovado, porque o texto sozinho perderia o que o cliente precisa tocar. A espera curta que já existia antes do primeiro modelo pago continua igual e agora tem teto de 30 segundos: um valor maior em `FOLLOWUP_CARENCIA_DO_MODELO_MS` é aparado, para um lead recém-chegado nunca ficar sem resposta por causa de configuração. Nenhuma ação é necessária na atualização, e nada muda nos canais por QR (que não têm janela de 24 horas).
