---
impacto: capacidade_nova
secao: corrigido
titulo: Em "Cadastro apenas por convite", ninguém mais cria conta direto pelo Supabase
---

Com "Cadastro apenas por convite" ligado, o CRM recusava cadastro sem convite, mas o Supabase continuava aceitando conta nova criada direto pela chave pública do navegador. Agora a atualização fecha também essa porta no Supabase desta VPS (instalação de servidor único), e quem recebeu convite continua criando a conta normalmente. Quem usa o Supabase na nuvem ou em outro servidor pode desligar "Allow new users to sign up" no painel do Supabase, e o convite segue funcionando. Se trocar o modo em /admin/cadastro, rode a atualização para o Supabase desta VPS acompanhar. Relato de @spoliagency na issue #1653.

Contribuição de @webtecnica (#1665).
