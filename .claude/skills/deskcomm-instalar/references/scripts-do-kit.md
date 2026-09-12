# Os scripts do kit — o que cada um faz, quando usar e o que imprime

Todos vivem em `hostgator-setup-kit/` e rodam **de dentro da VPS**, a partir da pasta do clone
(`cd deskcommcrm`). Use-os em vez de reimplementar: cada um carrega correções de instalação real.

| script | quando a pessoa diz | o que faz | como ler a saída |
|---|---|---|---|
| `install.sh` | "instala", "troca a configuração", "coloquei um dado errado" | instala do zero **ou** re-roda sobre o que existe (idempotente): retoma respostas, corrige pelo número da conferência, re-aplica o schema, sobe tudo | termina em "Instalação concluída!" com a pendência de e-mails (se sem token). `--yes` = sem perguntas, exige `.env` completo |
| `healthcheck.sh` | "está tudo no ar?", "o site caiu?" | lista os contêineres, chama `/api/v1/health` **de dentro** do contêiner do app, confere o cron do agente e o log dele | `✓ app saudável` se o JSON traz `"status":"ok"`; `⚠` nomeia o subsistema (supabase/redis/waha) degradado |
| `diagnostico.sh` | "o agente parou de melhorar", "a versão está solta", "atualizei e nada mudou" | **só lê** (nada de escrever, puxar ou reiniciar): diz se a instalação foi afetada pelo worker que nunca era atualizado. Roda até avulso: `curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/hostgator-setup-kit/diagnostico.sh \| bash` | código de saída 1 = afetada; explica o conserto |
| `update.sh` | "atualiza", "tem versão nova?" | confere se há versão nova (senão sai na hora), **faz backup antes**, puxa o código, re-aplica o `baseline.sql` (idempotente e auto-curativo; muitos "já existe" são esperados), puxa as imagens da tag, confere a saúde | código 3 = recusou e **nada foi tocado** (ex.: sem internet para confirmar o que é mais novo, ou a versão pedida é anterior). `--force` volta no tempo de propósito; `--to <tag>` fixa uma versão; `--skip-backup` não recomendado |
| `backup.sh` | "faz backup", "antes de mexer" | dump do banco pela conexão de schema (o app usa uma role menor e o dump sairia parcial) + snapshot do volume do WhatsApp; guarda 14 | `backups/db-<data>.sql.gz` e `backups/waha-<data>.tgz` **na própria VPS** |
| `restore.sh <arquivo>` | "restaura o backup" | **sobrescreve** o banco com o dump; pede para digitar `RESTAURAR` | restaura **só o banco**: se o volume do WhatsApp se perdeu, é parear de novo por QR (ou restaurar o `.tgz` à mão) |
| `reset-password.sh <email>` | "esqueci a senha", "me tranquei fora" | redefine a senha pela admin API do Supabase | pede a senha nova no terminal, sem ecoar |
| `reset-mfa.sh <email>` | "perdi o celular do autenticador" | apaga os fatores de verificação em duas etapas do usuário | no próximo login a pessoa entra só com a senha (a verificação é opcional; o comentário do script ainda diz "forçado para admin" — regra antiga) |
| `marca-emails.sh` | "os e-mails estão em inglês", "o link de recuperar senha vem quebrado" | sobe os e-mails de acesso (criar conta, recuperar senha) com a marca e configura Site URL / Redirect URLs | precisa de `export SUPABASE_ACCESS_TOKEN=sbp_...` no ambiente; sem token instrui e sai com 0. `--render-em /tmp/x` só renderiza |
| `supabase-provision.sh "Nome" [região]` | "cria o banco pra mim" | cria o projeto Supabase pela Management API, espera ficar saudável, descobre o pooler testando conexão | imprime as 4 linhas `CHAVE='valor'` para o `.env`; o instalador chama sozinho quando há token e credenciais vazias |
| `comecar.sh` | "ainda não tenho servidor", "que plano contrato?" | roda **no computador da pessoa**: nomeia o plano, abre o link de parceria, devolve o comando de instalação | não instala nada |
| `agent.sh` | (ninguém chama à mão) | o agente de atualização pela tela; roda por cron a cada 5 minutos | erros ficam em `.update-agent.log` na pasta do clone |

## Compose: os dois arquivos quando há proxy da hospedagem

Numa VPS com Traefik/Nginx próprio (`REVERSE_PROXY=traefik` no `.env`), **todo** `up -d` leva os
dois arquivos — senão o contêiner sobe sem as etiquetas de roteamento e o domínio inteiro responde
404 com tudo "healthy":

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

## Validar um valor sem instalar

O instalador expõe seus validadores como biblioteca — útil para conferir uma connection string ou
uma chave antes de gravar:

```bash
INSTALL_SH_LIB=1 . hostgator-setup-kit/install.sh
v_db_url 'postgresql://postgres.xxx:senha@aws-1-sa-east-1.pooler.supabase.com:5432/postgres' && echo ok
```
