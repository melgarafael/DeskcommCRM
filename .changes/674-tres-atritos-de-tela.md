---
impacto: nada_mudou
secao: corrigido
titulo: Prospecção e agenda do celular param de mandar a pessoa ao lugar errado
---

Dois atritos de tela da comunidade, com a mesma raiz: a frase da recusa dizia
uma causa que não era a medida.

**Prospecção (#4118).** A recusa da ativação usava UMA frase para duas
condições — `crm_move_lead_stage` fora das capacidades publicadas e o funil da
campanha fora de `pipeline_ids` — e mandava fazer as duas. Quem ligava o pacote
"Vender e mover o funil" na aba **Conversa com o cliente** lia o aviso e
concluía que já tinha feito o que ele pedia; o funil se marca na outra aba,
**Organiza o sistema › "Em que negócios ele pode mexer"**, e a mensagem não
dizia isso. Agora `lib/prospecting/recusa-do-agente.ts` decide pelo que falta: a
frase nomeia a capacidade, a aba e o botão, e o código cru (`crm_move_lead_stage`,
`pipeline:<id>`) vai para o log.

**Sincronizar agenda do celular (#4102).** Todo erro do transporte virava "o
WhatsApp deste número não respondeu, confira se ele está conectado". No NOWEB
sem store o `GET /api/contacts/all` devolve **400** — e o 400 é o pedido para
ligar **"Guardar o histórico anterior à vinculação"** na conexão. O número
estava conectado; a frase mandava reconectar o que funcionava. A rota agora
separa o 400 (`lib/contacts/recusa-da-agenda.ts`) e cita a opção e a tela de
Conexões; os outros status continuam na frase da conexão, com o código cru no
log. O comentário do cliente do WAHA que supunha `[]` foi corrigido para o
comportamento medido.

Crédito: @webtecnica (#4118 e #4102, relatos da comunidade no Circle).
