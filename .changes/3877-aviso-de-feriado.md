---
impacto: capacidade_nova
secao: adicionado
titulo: O agente pode não atender em feriado nacional, e o aviso de fora do horário ganha texto próprio de feriado (opção desligada de fábrica)
---

O horário de funcionamento do agente só olhava a janela semanal: em 02/11/2026
(Finados, segunda-feira) quem escrevia às 10h era atendido pela IA como num dia
comum, e o aviso de fora do horário dizia "atendemos hoje das 8h às 18h" com a
empresa fechada.

O horário de funcionamento do agente ganha a opção "Não atender em feriado
nacional". Ela vem desligada, e quem não ligar não vê nada mudar: o feriado
continua sendo um dia comum, e a IA atende no horário configurado. Ligada, o
feriado nacional conta como dia fechado, pela régua que o CRM já usa
(`isHolidayBR`, no fuso do horário de funcionamento): quem escreve no feriado,
mesmo dentro do horário semanal, recebe a mensagem de fora do horário, e a IA
só responde na abertura do próximo dia útil. Os dois andam juntos, para o
cliente não receber "estamos fechados" e uma resposta logo depois. A opção só
vale para organizações no Brasil.

Quem quiser um texto próprio escreve em "Mensagem em feriado nacional", ao lado
da mensagem de fora do horário. Ele substitui a mensagem de sempre quando o
aviso sai num dia de feriado: com a opção desligada, isso é só para quem escreve
fora do horário. Em branco, continua saindo a mesma mensagem de sempre, sem
nenhuma alteração de texto. Contato que pediu para parar, titular anonimizado,
aviso já enviado no período fechado e o limite de envio do número continuam
barrando o recado.

Crédito: @webtecnica, que mediu o defeito e escreveu o texto de feriado e a
régua do aviso (#4169, issue #3877).
