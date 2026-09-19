# Segurança — escreve.ai

## Versões e correções

A branch padrão é `versao-atual`. Atualizações do DeskcommCRM original passam por integração e validação antes de serem adotadas. A branch `integracao-oficial` está em revisão e não representa uma atualização publicada em produção.

A execução automática de CI está desativada neste repositório. Não considere uma revisão validada apenas porque foi enviada ao GitHub. Consulte [Identidade e operação](docs/escreve-ai.md) antes de usar atualizadores herdados.

## Reportar uma vulnerabilidade

Comunique a vulnerabilidade diretamente aos administradores que concederam seu acesso a este repositório privado, por um canal privado já estabelecido. Não publique credenciais, dados pessoais ou detalhes exploráveis em issues, PRs ou logs. Esta edição não estabelece um prazo de resposta ou serviço de suporte público.

Inclua a revisão afetada, os passos mínimos de reprodução, o impacto e exemplos com dados fictícios. Se o problema também existir no projeto original, utilize o [canal de segurança do DeskcommCRM](https://github.com/melgarafael/DeskcommCRM/security/policy).

## Escopo

- Isolamento entre organizações e regras de acesso (RLS/RBAC).
- Autenticação, sessões e permissões de agentes e atendentes.
- Dados pessoais de contatos, conversas, mídia e enriquecimento.
- Webhooks, APIs e integrações com provedores externos.
- Chaves, tokens e outros segredos.

Segredos devem permanecer fora do Git. Instalações precisam de atualização planejada, backup e validação dos canais antes da publicação.
