---
impacto: capacidade_nova
secao: adicionado
titulo: Módulo de agenda de avaliação veicular na rota /app/agenda
---

A instância ganha o módulo opcional **avaliacao** (ADR-0002): instale-o em **Administração › Módulos** antes de usar. Com o módulo ligado, o item **Agenda** no CRM abre a agenda de avaliação — lista, grade semanal (09:00–18:40, slots de 20 minutos), unidades, status, confirmação para WhatsApp e ações de cancelar/reativar. Com o módulo desligado, `/app/agenda` continua mostrando a agenda de compromissos e Google Calendar como antes. APIs novas em `/api/v1/avaliacao/*` e cron `avaliacao-atrasados` marcam agendamentos vencidos como atrasados.
