# Como chegar no dado — e o que pode sair dele

## Onde o dado mora

- **Não há Postgres na VPS.** O `docker-compose.prod.yml` sobe app, worker, WAHA, Redis, o proxy
  do Redis, scheduler e Caddy. O banco é o **Supabase** do cliente, alcançado pela connection
  string `SUPABASE_DB_URL` do `.env` da instalação — a do **Session pooler** (porta 5432).
- **Não existe papel só-leitura** no produto: a string do app é a role da aplicação e enxerga
  todas as organizações da instalação. Por isso **toda consulta filtra `organization_id`**, e
  nenhuma faz `SELECT *` em tabela com dado pessoal.
- Uma instalação pode ter várias organizações (`organizations`): peça o **nome**, descubra o id,
  confirme com a pessoa.

## Como obter o acesso (peça uma coisa por vez)

1. **Dentro da VPS** (por SSH), na pasta do clone: `grep '^SUPABASE_DB_URL=' .env` — use a string
   **sem** ecoá-la no chat. Rode as consultas com `psql "$SUPABASE_DB_URL" -c "…"` ou via um
   contêiner descartável: `docker run --rm -i postgres:17-alpine psql "$URL" < consulta.sql`.
2. **Fora da VPS** (computador da agência): a pessoa cria, no SQL editor do Supabase, um papel
   só-leitura para você — é a opção de menor privilégio, e precisa ser feita por ela:

   ```sql
   create role crm_leitura login password '<senha forte>';
   grant usage on schema public to crm_leitura;
   grant select on all tables in schema public to crm_leitura;
   alter role crm_leitura set default_transaction_read_only = on;
   ```

   Sem `bypassrls`, esse papel vê **zero linhas** nas tabelas com RLS (a política depende do
   usuário logado). Então ou a pessoa concede `bypassrls` (`alter role crm_leitura bypassrls;` —
   privilégio alto; explique) ou você roda de dentro da VPS com a string do app. Não há terceira
   via hoje sem mudança no produto.
3. **Alternativa por MCP** (sem SQL): um token `dsk_…` criado em Configurações › Tokens de API com
   o escopo `mcp:read` apenas (sem `role:*`) dá acesso a listas prontas — fila de atendimento,
   leads em risco, casos, follow-ups, propostas de melhoria. Serve para um retrato, não para as
   análises de funil e custo. Atenção: as ações de leitura de contato e conversa do MCP **devolvem
   dado pessoal** — não as use para análise.

Nunca peça `SUPABASE_SERVICE_ROLE_KEY` nem o token pessoal do Supabase para analisar: não são
necessários e ampliam o raio de dano.

## O que pode ir para o modelo (a fronteira da LGPD nativa)

A anonimização do produto apaga nome, telefone, e-mail, CPF, corpo de mensagem, notas, título do
lead, campos personalizados, mídia — e **preserva** ids, datas, estados, valores e contagens. Essa
é a linha: **o que a anonimização preserva pode ser agregado e analisado; o que ela apaga não sai
do banco**.

| pode | não pode |
|---|---|
| contagens, medianas, percentis, taxas | `messages.body`, `lead_checkpoints.*`, notas, rascunhos de resposta |
| `direction`, `sent_via`, `status`, `stage`, `outcome`, `purpose`, `vetoed_gate` | `contacts.*` (nome, telefone, e-mail, consentimento cru) |
| `value_cents`, `cost_cents`, tokens, latência | `crm_leads.title`, `lost_reason` em texto livre (trate como categoria: cruze com a lista de motivos do funil; o resto vira "outro") |
| `crm_leads.source`, nome de funil/etapa/agente/fluxo | `contact_phone` da consulta de atividades (o relatório de atividades devolve telefone nos itens — use só os totais) |

Contatos anonimizados **continuam nos contadores** (contar é aceitável; nomear não). Não há escopo
de consentimento para "análise por modelo externo" no produto — logo, agregado é o único caminho
defensável. Se a pessoa pedir "lê as conversas e me diz o que está errado", é o guia
`deskcomm-prompt`, com amostra mínima e ciência dela.

## Higiene da sessão

- Consultas em arquivo `.sql` na pasta que a pessoa indicar; resultados agregados no relatório;
  nada de dump.
- A connection string não vai para arquivo nenhum seu, nem para o chat; se for preciso repetir
  comandos, `export URL=…` no shell da sessão.
- Ao terminar numa máquina fora da VPS: `unset URL`, apague arquivos temporários.
