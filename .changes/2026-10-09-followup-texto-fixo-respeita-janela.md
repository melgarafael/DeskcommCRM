---
impacto: nada_mudou
secao: corrigido
titulo: Follow-up de texto fixo respeita a janela de disparo do canal e a faixa do agente
---

O follow-up de texto fixo agora respeita a janela de disparo do canal e a faixa de horário do agente antes de enviar. Fora delas o envio não sai mais: o job volta para `pending` no primeiro instante em que as duas estão abertas, com `action_deferred` gravado no enrollment e o mesmo motivo que o caminho do worker já registrava (`outside_window` / `followup_send_window`). Dentro da janela nada muda — fluxos que já disparavam no horário certo seguem disparando.

Contribuição de @webtecnica (#2677, issue #2658).
