-- Desfaz a prova dos Envios (os ARQUIVOS saem antes, pela API: envios-apagar-arquivos.mjs — o Storage recusa DELETE direto na tabela).
delete from agencia_aprovacoes where titulo like '%(prova)%';
delete from user_organizations where user_id = '8e2cd8b3-1064-498b-ba83-5476b980dcf0' and organization_id = 'ca2e3ea3-3d5d-4c9d-b421-4da37073051a';
delete from agencia_membros_funcoes where funcao_id in (select id from agencia_funcoes where nome = 'Envios (prova)');
delete from agencia_funcoes where nome = 'Envios (prova)';
