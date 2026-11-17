---
impacto: nada_mudou
secao: corrigido
titulo: Intervalos de refetch dinâmicos e recomendação de backup para evitar estouro de egress no Supabase Free
---

O painel de atualização (`UpdatePanel.tsx`) consultava `GET /api/v1/system/version` a cada 5 segundos incondicionalmente enquanto aberto, drenando egress e cota de Auth mesmo sem nenhuma atualização em curso. O hook `useSystemVersion` passa a aceitar intervalo dinâmico, e a tela só acelera o polling para 5 s quando há um run de atualização despachado (`status === 'dispatched'`); com o sistema ocioso, mantém a cadência relaxada de 5 minutos (#2235).

A visualização de agendamento (`DetalheDoCompromisso.tsx`) também reduz o polling de 5 s para 30 s, alinhando-se aos demais modais de detalhe da aplicação.

O script `hostgator-setup-kit/backup.sh` e o runbook de custo do Supabase detalham o impacto de egress do `pg_dump` no plano Free (onde um dump diário consome ~4,5 GB/mês da cota de 5 GB), recomendando agendamento semanal para quem opera na faixa gratuita com banco volumoso.

Crédito: @jlom2024 (#2235).
