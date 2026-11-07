---
impacto: nada_mudou
secao: corrigido
titulo: Contato apagado a pedido não volta pela agenda do app, e a sincronização pergunta uma vez por lote
---

Quem pediu para ser apagado (LGPD) e continua na agenda do WhatsApp Business não volta mais ao CRM quando a Meta entrega a sincronização de contatos da coexistência (`smb_app_state_sync`): a sincronização agora **consulta a marca de apagamento antes de escrever qualquer coisa** — a mesma pergunta que o importador de histórico já fazia — e um número marcado é pulado.

A pergunta é feita **uma vez por entrega, não uma por contato**: um webhook pode trazer dezenas de contatos, e antes disso cada um custava uma consulta ao banco. Também deixou de haver escrita em ficha **já anonimizada** que ainda seja encontrada pelo número (anonimizações anteriores à marca, que não têm como ser reconhecidas de outro jeito), e o que foi pulado aparece no log com a contagem — sem telefone, sem nome.

Contato normal continua sincronizando exatamente como antes, com o nome da agenda no campo que só a equipe vê; outra organização não é afetada; e se a consulta falhar a sincronização não cria o contato na dúvida nem para os demais. Contribuição de @webtecnica (#3432).
