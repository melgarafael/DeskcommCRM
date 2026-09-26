---
impacto: capacidade_nova
secao: adicionado
titulo: Atualizar lead e marcar/remarcar/cancelar compromisso por integração externa
---

`PATCH /api/v1/leads/[id]` e `POST/PATCH/DELETE /api/v1/agenda/agendamentos`
passam a aceitar `Authorization: Bearer dsk_...` além da sessão do navegador —
o mesmo padrão que `/api/v1/messages` e `/api/v1/contacts` já usavam. Serve
qualquer integração de servidor que precise atualizar um negócio ou marcar um
compromisso sem navegador (ex.: monitoramento de andamento processual via
n8n). Nada muda para quem usa a tela.
