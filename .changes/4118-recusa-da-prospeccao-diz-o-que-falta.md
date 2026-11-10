---
impacto: nada_mudou
secao: corrigido
titulo: A recusa ao ativar a Prospecção diz qual permissão do agente falta e em que aba ligar
---

Um atrito de tela relatado pela comunidade: a frase da recusa dizia uma causa
que não era a medida.

**Prospecção (#4118).** A recusa da ativação usava UMA frase para duas
condições — `crm_move_lead_stage` fora das capacidades publicadas e o funil da
campanha fora de `pipeline_ids` — e mandava fazer as duas. Quem ligava o pacote
"Vender e mover o funil" na aba **Conversa com o cliente** lia o aviso e
concluía que já tinha feito o que ele pedia; o funil se marca na outra aba,
**Organiza o sistema › "Em que negócios ele pode mexer"**, e a mensagem não
dizia isso. Agora `lib/prospecting/recusa-do-agente.ts` decide pelo que falta: a
frase nomeia a capacidade, a aba e o botão, e o código cru (`crm_move_lead_stage`,
`pipeline:<id>`) vai para o log.

Crédito: @webtecnica (#4118, relato da comunidade no Circle).
