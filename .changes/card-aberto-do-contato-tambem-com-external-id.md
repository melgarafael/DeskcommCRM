---
impacto: capacidade_nova
secao: corrigido
titulo: O reaproveitamento do card aberto vale também para o envio com identificador de integração
---

Com a opção "Reaproveitar o card aberto do contato" ligada numa fonte de webhook, o reaproveitamento só valia para envio SEM identificador de integração (`external_id`). Quem integra de verdade manda esse identificador, e o caso medido era este: a pessoa chega pelo WhatsApp e a conversa abre o card dela no funil; o sistema de fora avisa o cadastro novo com um identificador inédito; a captação criava um SEGUNDO card no mesmo funil, e os avisos seguintes mexiam só no card novo — o card da conversa ficava parado e o contato aparecia com dois negócios abertos.

Com a opção ligada, o primeiro envio de um identificador que ainda não existe procura o card aberto do contato no funil da fonte, adota esse card e grava nele o identificador e a fonte que o enviou. Do segundo envio em diante nada muda: o identificador acha o card — inclusive o card adotado, que é da conversa e não nasce da integração — e o atualiza, como sempre. O identificador que já existe continua mandando, e quem não ligou a opção continua com o comportamento de sempre — inclusive quem nunca manda identificador de integração.

Duas perguntas que o review deste PR abriu, respondidas aqui:

- **um segundo identificador diferente do mesmo contato adota o mesmo card?** Não. Cada identificador tem o seu card e a sua idempotência: o card que já responde por um identificador não é adotado por outro, e o envio do segundo identificador cria o card dele. Dois identificadores, dois cards — é o que valia antes, e a opção não muda isso;
- **o card de outra fonte de webhook é reaproveitado?** Não: o reaproveitamento alcança o card que não veio de fonte nenhuma (o da conversa, o criado à mão) e o card da própria fonte. Vale com ou sem identificador;
- **o envio seguinte obedece à opção "Atualizar o card existente"?** Sim, como todo envio que casa por identificador: com essa opção desligada, o reenvio do mesmo identificador recebe sucesso e o card fica intocado; com ela ligada, o que mudou é aplicado. É a mesma régua de sempre do reaproveitamento por identificador.

Contribuição de @webtecnica (#3366).
