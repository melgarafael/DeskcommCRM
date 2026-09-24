---
impacto: capacidade_nova
secao: corrigido
titulo: Hardening — escopo de org no service role, convites fail-closed e runbook de restore
---

Três frentes de segurança. Primeira: auditoria completa dos 195 route handlers que usam service role (que bypasa o RLS). Todos filtram `organization_id` de fonte confiável ou delegam a helpers que filtram; nenhum vazamento entre tenants foi encontrado. Para que continue assim, um teste novo (`tests/unit/admin-client-tem-escopo-de-org.test.ts`) reprova qualquer rota nova com service role que não declare seu escopo — filtro direto, orgId entregue ao helper, ou exceção documentada na allowlist (cron com secret, tabelas de plataforma, rotas públicas de captura por slug).

Segunda: o segredo HMAC dos tokens de convite (`lib/auth/invite-token.ts`) caía para `"dev-fallback"` quando nem `INVITE_TOKEN_SECRET` nem `INTERNAL_SECRET` estavam definidos — um token forjável por qualquer um que lesse o código. Agora o módulo lança em vez de assinar: sem segredo, não há convite. Em produção nada muda (o boot já exige `INTERNAL_SECRET` via `lib/env.ts`); se algum script ou worker isolado importar o módulo sem variáveis de ambiente, vai falhar com mensagem clara em vez de gerar convites fracos.

Terceira: runbook de restore (`docs/runbooks/restore-do-backup.md`) com o passo a passo do `restore.sh`, a verificação pós-restore e as limitações lidas no código — entre elas, que o dump não tem `--clean` (o caminho suportado é banco vazio), que o `restore.sh` não aborta no primeiro erro SQL (ler a saída inteira), e que os backups moram na própria VPS (cópia externa é responsabilidade do operador). O drill completo não foi executado nesta VM (sem Docker/Postgres): o runbook documenta o que foi verificado e o que falta.

Ficou de fora deste commit: a varredura de segredos com gitleaks no CI (`.github/workflows/segredos.yml`). A tag da action (`gitleaks-action@v3`) não pôde ser confirmada a partir deste ambiente e nenhum scan completo da história foi executado ainda — sem varredura real, não há afirmação sobre segredos na história. Entra num commit seguinte, com a tag confirmada e a primeira varredura documentada.

Não há ação para quem opera a VPS: as mudanças chegam na próxima atualização.
