-- Prova dos Envios: função temporária com tarefas.criar e o membro de teste TEMPORARIAMENTE
-- agent da "Empresa Modelo (Testes)" para responder como cliente. Desfazer com envios-limpar.sql.
with f as (insert into agencia_funcoes (nome, permissoes, ativa) values ('Envios (prova)', array['tarefas.criar'], true) returning id)
insert into agencia_membros_funcoes (membro_id, funcao_id) select 'f49cbbe8-933c-4164-91fb-dbac2b18a791', id from f;
insert into user_organizations (user_id, organization_id, role, accepted_at)
values ('8e2cd8b3-1064-498b-ba83-5476b980dcf0', 'ca2e3ea3-3d5d-4c9d-b421-4da37073051a', 'agent', now())
on conflict do nothing;
