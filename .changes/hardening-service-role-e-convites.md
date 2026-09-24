---
impacto: exige_acao
secao: seguranca
titulo: Convites agora exigem segredo configurado; gate anti-vazamento entre tenants
---

Duas correções de segurança. Primeira: o segredo HMAC dos tokens de convite (`lib/auth/invite-token.ts`) caía para `"dev-fallback"` quando nem `INVITE_TOKEN_SECRET` nem `INTERNAL_SECRET` estavam definidos — um token forjável por qualquer um que lesse o código. Agora o módulo lança em vez de assinar: sem segredo, não há convite. Em produção nada muda (o boot já exige `INTERNAL_SECRET` via `lib/env.ts`); se algum script ou worker isolado importar o módulo sem variáveis de ambiente, vai falhar com mensagem clara em vez de gerar convites fracos.

Segunda: auditoria completa dos 195 route handlers que usam service role (que bypasa o RLS). Todos filtram `organization_id` de fonte confiável ou delegam a helpers que filtram; nenhum vazamento entre tenants foi encontrado. Para que continue assim, um teste novo (`tests/unit/admin-client-tem-escopo-de-org.test.ts`) reprova qualquer rota nova com service role que não declare seu escopo — filtro direto, orgId entregue ao helper, ou exceção documentada na allowlist (cron com secret, tabelas de plataforma, rotas públicas de captura por slug). Não há ação para quem opera a VPS: a mudança chega na próxima atualização.
