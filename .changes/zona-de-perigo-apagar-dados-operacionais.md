---
impacto: capacidade_nova
secao: adicionado
titulo: Admin agora apaga os dados de teste da organização pela própria tela
---

Configurações › Organização ganhou uma "Zona de perigo": um botão que apaga de
vez todas as mensagens, conversas, leads, contatos, agendamentos e pedidos da
organização, para quem quer recomeçar os testes do zero sem pedir a alguém
para rodar SQL.

Só quem administra a empresa vê o botão, e a ação exige digitar o nome exato
da organização antes de confirmar — como apagar um repositório. A função por
trás (`fn_apagar_dados_operacionais_da_organizacao`, já existente no banco)
não muda; o que entra é a tela e a auditoria (`org.dados_operacionais_apagados`
em `api_audit_log`).

Nada muda para quem opera uma instalação já em produção: nenhuma migration,
nenhum passo de atualização.
