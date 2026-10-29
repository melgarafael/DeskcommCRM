---
impacto: nada_mudou
secao: corrigido
titulo: As tabelas criadas pela atualização recebem permissões explícitas e continuam acessíveis depois da mudança da Supabase de 30/10
---

A partir de 30/10/2026 a Supabase deixa de dar permissão automática a tabela nova. As 48 tabelas que a atualização cria e que dependiam dessa permissão automática passam a recebê-la de forma explícita, só do tamanho que o sistema usa: o servidor lê e grava, a pessoa logada só faz o que as regras de acesso já permitiam, e o visitante sem login não alcança nenhuma delas. Nada muda no uso do sistema. As tabelas dos módulos opcionais (honorários e vendas) ficam para uma próxima entrega. Crédito a @webtecnica pela descoberta e pelos testes que esta entrega reaproveita.
