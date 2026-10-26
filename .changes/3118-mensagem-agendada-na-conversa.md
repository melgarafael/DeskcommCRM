---
impacto: capacidade_nova
secao: adicionado
titulo: Agendar mensagem na conversa, para sair sozinha na hora marcada
---

O compositor do Inbox ganhou o relógio de agendar: o texto que está no campo pode sair na hora marcada, sem ninguém
precisar estar com a tela aberta. O diálogo escolhe dia e hora no fuso do aparelho, e a faixa "Agendadas" mostra o que
está na fila com o botão de desmarcar — enquanto o pacote não começou a sair.

O envio passa pela mesma porta de todos os outros (`sendMessageHandler`), então herda organização operante, janela de
24h, ritmo do número e a anti-duplicata por `internal_message_id`: se o worker morrer no meio e voltar, nenhuma parte
sai duas vezes. A mensagem agendada pode ser de várias partes, na ordem, e para no primeiro erro, avisando quem
agendou. O opt-out do contato e a anonimização por LGPD cancelam o que estava marcado — o corpo pendente é apagado
junto, pelo mesmo gatilho em `contacts`.

Também está na API (`/api/v1/scheduled-messages`, com `Idempotency-Key`) e no MCP (`crm_schedule_message`,
`crm_list_scheduled_messages`, `crm_cancel_scheduled_message`), para quem opera por agente. O texto nunca entra na
trilha de auditoria: `api_audit_log` guarda ids, hora e contagem de partes.
