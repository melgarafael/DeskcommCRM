---
impacto: capacidade_nova
secao: corrigido
titulo: Contato da equipe continua sendo atendido e não é mais passado a humano nem silenciado pelo medidor de clima
---

O medidor de clima roda antes do turno do agente e passava para uma pessoa
qualquer conversa medida como irritada — inclusive a do sócio que testa o
agente pelo próprio número. O sócio cobrava uma resposta por texto, a nota saía
baixa, a conversa ia para `pending` com `bot_silenced_until = infinity` e o dono
da empresa recebia «já acionei o time», sendo ele o time. Marcar o contato como
interno resolvia o repasse ao custo de o agente parar de falar com ele, e baixar
o limiar tirava a proteção de todo cliente irritado de verdade.

Agora existe a lista **Equipe**, em Configurações › Tags, ao lado dos contatos
internos: `organizations.settings.crm.team_contact_tags`. Contato marcado com
uma dessas etiquetas continua sendo atendido pela IA — inclusive em canal em
modo de teste, onde um cliente comum ainda é barrado —, continua sendo medido e
registrado pelo clima, e não é passado a humano por clima nem silenciado. O
repasse por clima também é recusado no próprio orquestrador de handoff, para
que nenhum alerta antigo na fila cale a conversa. Cliente comum com o mesmo
texto continua sendo passado e silenciado como antes.

Nenhuma migration: a lista mora no mesmo `settings.crm` das etiquetas internas,
e quem não configurar nada mantém exatamente o comportamento anterior.
