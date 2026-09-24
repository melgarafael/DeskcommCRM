# Runbook: restaurar o banco a partir do backup

> Última auditoria: 2026-09-24 (branch `rebrand/canti-crm-oro`).
> Escopo: `hostgator-setup-kit/backup.sh` + `hostgator-setup-kit/restore.sh`.
> O drill completo (dump real + restore real) **não** foi executado nesta
> auditoria — ver "O que foi verificado e o que não foi" no fim.

## O que o backup contém

`bash hostgator-setup-kit/backup.sh` gera, em `<projeto>/backups/`:

| Arquivo | Conteúdo | Obrigatório |
|---|---|---|
| `db-AAAAMMDD-HHMMSS.sql.gz` | Dump do Postgres (`pg_dump`, conexão de schema) | sim |
| `waha-AAAAMMDD-HHMMSS.tgz` | Snapshot das sessões do WhatsApp (volume do WAHA) | se existir sessão |
| `storage-AAAAMMDD-HHMMSS.tgz` | Anexos do Storage (só `SINGLE_SERVER=1`) | só single-server |

Retenção: os 14 mais recentes de cada tipo; o resto é apagado.

O `update.sh` roda o `backup.sh` sozinho antes de mexer no banco (etapa 2).
Fora isso, o backup **não** é automático: o operador agenda no cron
(`0 3 * * * cd /caminho/do/projeto && bash hostgator-setup-kit/backup.sh`).
Supabase free não tem backup automático — sem esse cron, não há backup.

## Quando restaurar

- A atualização quebrou o banco e o `update.sh --to <tag> --force` não resolveu.
- A VPS foi perdida e o projeto foi reinstalado do zero (cenário desastre).
- Qualquer caso em que voltar ao estado do backup vale mais que os dados
  gravados depois dele — **o restore é destrutivo**: tudo que o CRM gravou
  depois do backup se perde.

## Passo a passo

1. **Escolha o dump.** Liste `backups/` e pegue o `db-*.sql.gz` mais recente
   (ou o da data que você quer). Confirme que o `waha-*.tgz` e o
   `storage-*.tgz` do mesmo timestamp existem ao lado, se você precisa deles.
2. **Pare de escrever no banco.** Se o app está no ar, o restore vai brigar
   com o tráfego. O cenário suportado é banco parado ou instalação nova.
3. **Rode o restore** a partir da pasta do projeto:
   ```bash
   bash hostgator-setup-kit/restore.sh backups/db-20260923-030000.sql.gz
   ```
   O script pede para digitar `RESTAURAR` — é a trava contra o dedo errado.
4. **Restaure as sessões do WhatsApp** (automático): se o `waha-*.tgz` do mesmo
   timestamp existir ao lado do dump, o script já o descompacta no volume.
   Se não existir, o pareamento do WhatsApp se perdeu — será preciso ler o
   QR code de novo.
5. **Single-server — anexos** (automático): se o `storage-*.tgz` existir, o
   script o restaura. Se não existir, o banco volta mas os anexos ficam
   quebrados — o script avisa.
6. **Reinicie o app:**
   ```bash
   docker compose $(bash -c 'source hostgator-setup-kit/_common.sh && dc_files') restart app
   ```
   (o próprio `restore.sh` imprime o comando certo no fim; use o dele.)

## Verificação pós-restore (não pule)

1. O `restore.sh` **não** usa `ON_ERROR_STOP`: um erro no meio do dump não
   aborta o `psql`, e o script ainda imprime "✓ banco restaurado". **Leia a
   saída inteira** procurando `ERROR`.
2. Confira que as tabelas voltaram:
   ```bash
   bash hostgator-setup-kit/diagnostico.sh   # ou o healthcheck do kit
   ```
3. Abra o CRM e confira: login, inbox, um contato, um card do kanban.
4. Confira que o WhatsApp reconectou sem pedir QR (se o snapshot existia).

## Limitações honestas (lidas no código, não presumidas)

- **O dump não tem `--clean`.** O `pg_dump` do `backup.sh` emite `CREATE TABLE`
  sem `DROP` antes. Restaurar sobre um banco que **já tem as tabelas** falha
  nos `CREATE` (e, sem `ON_ERROR_STOP`, segue para `INSERT`s que colidem em
  chave). O caminho que funciona de verdade é **banco vazio** — instalação
  nova após desastre, ou banco esvaziado de propósito. Não use o restore como
  "desfazer de ontem" sobre o banco vivo sem esvaziar antes.
- **O backup mora na própria VPS** (`<projeto>/backups/`). Se o disco/VPS
  morre, o backup morre junto. Copiar os `db-*.sql.gz` para fora (outro
  servidor, S3, etc.) é responsabilidade do operador — o kit não faz isso.
- **Falha no meio do pipeline do dump é detectada.** O `backup.sh:6` importa
  o `_common.sh:3`, que liga `set -euo pipefail`: se o `pg_dump` falhar ou o
  `gzip` falhar ao gravar (disco cheio incluído), o pipeline inteiro sai
  não-zero, o script aborta e a linha "✓ banco" nunca imprime — e o `update.sh`
  aborta a atualização automática quando o backup falha. O que **não** existe
  é verificação pós-gravação do conteúdo: `gunzip -t backups/db-*.sql.gz` no
  cron segue recomendado como defesa em profundidade (pega truncamento ou
  corrupção depois da escrita, fora do alcance do pipeline).
- **`url_do_schema`**: backup e restore usam a conexão de schema
  (`SUPABASE_DB_ADMIN_URL`, ou a do app como fallback). Com role menor que a
  dona do banco, o dump sai parcial — o script comenta isso no cabeçalho,
  mas não verifica.

## O que foi verificado e o que não foi (drill de 2026-09-23)

Verificado de verdade, com evidência:

- `bash -n` nos três scripts (`backup.sh`, `restore.sh`, `_common.sh`) — sintaxe OK.
- `tar_tem_sessao`: tar vazio rejeitado, tar com conteúdo aceito (teste com
  arquivos reais em `/tmp/drill`).
- `restore.sh` sem argumento → erro de uso; arquivo inexistente → erro de
  uso; confirmação recusada → "Cancelado." (projeto fake em `/tmp/fakeproj`).
- Suíte shell do kit: `tests/shell/waha-backup-volume.test.sh` e
  `tests/shell/atualizacao-de-fora-nao-pula-o-backup.test.sh` — todas verdes.
- `update.sh` chama `backup.sh` antes de tocar no banco e aborta a atualização
  automática se o backup falhar (lido no código, linhas 140–155).

**Não** verificado (sem Docker e sem Postgres nesta VM):

- Gerar um dump real (`pg_dump` precisa do banco e do Docker).
- Restaurar um dump real num Postgres efêmero e conferir os dados.
- O caminho feliz completo do `restore.sh` (para no `docker run`).
- Tempo de restore e comportamento sob carga.

Próximo passo quando houver ambiente com Docker: rodar o drill completo
(backup → derrubar banco → restore → verificação pós-restore) e anexar a
evidência aqui.
