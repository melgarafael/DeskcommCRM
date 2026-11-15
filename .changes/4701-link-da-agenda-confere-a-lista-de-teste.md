---
impacto: nada_mudou
secao: corrigido
titulo: A entrega do link de reunião passa a respeitar a lista de teste do canal
---

Numa conexão ainda em período de teste, só os números escolhidos para teste podem receber mensagem da IA. O dreno, o turno, o follow-up e a varredura de silêncio já conferiam essa lista; a entrega automática do link de reunião não — ela montava a elegibilidade sem o modo do canal, sem a lista e sem o telefone do contato, e por isso um contato fora da lista que tivesse autorização de campanha recebia o link de um canal ainda fechado ao público. Agora a política da agenda devolve os três campos e a entrega usa a mesma régua dos outros caminhos: contato fora da lista é recusado com o motivo `fora_da_lista_de_teste` no registro do compromisso. Canal já liberado continua entregando como antes, e o modo desligado não muda. Nada a configurar.

Correção de @webtecnica (#4701).
