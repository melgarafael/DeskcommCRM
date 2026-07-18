# Política de Segurança

## Versões suportadas

O DeskcommCRM é distribuído em rolling release a partir da branch `main`. Correções de segurança são aplicadas apenas à versão mais recente — mantenha sua instalação atualizada (`bash hostgator-setup-kit/update.sh` em self-host).

| Versão | Suportada |
| --- | --- |
| `main` (mais recente) | ✅ |
| Snapshots antigos | ❌ |

## Reportando uma vulnerabilidade

**Não abra issue pública para vulnerabilidades.**

Use o [relato privado de vulnerabilidades do GitHub](https://github.com/melgarafael/DeskcommCRM/security/advisories/new) — o relato chega só aos mantenedores, e o histórico fica auditável.

O que esperar:

- **Confirmação de recebimento** em até 7 dias.
- **Avaliação e resposta** em até 30 dias, com plano de correção quando confirmada.
- **Crédito** no advisory publicado, se você quiser.

## Escopo

Interessam especialmente relatos sobre:

- Vazamento entre tenants (bypass de RLS ou de filtro `organization_id`)
- Bypass de autenticação/RBAC (roles `viewer`/`agent`/`manager`/`admin`, super-admin)
- Exposição de dados pessoais (LGPD): contatos, conversas, mídia do WhatsApp
- Injeção via payloads de webhook (WAHA, Nuvemshop) ou da API `/api/v1`
- Vazamento de segredos (API keys, tokens bearer, cookies de sessão)

Instalações self-host são responsabilidade de quem hospeda; problemas de configuração do servidor (firewall, TLS do VPS etc.) estão fora do escopo do projeto, mas melhorias no kit de instalação são bem-vindas como issue normal.
