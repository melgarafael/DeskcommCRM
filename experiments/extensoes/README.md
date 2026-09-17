# Bancada experimental de extensões

Instrumentos locais do PROG-019. Dados sintéticos, PostgreSQL exclusivo e executores separados do CRM. Um resultado aprovado aqui cobre o mecanismo medido; não aprova integração ao produto, instalação em VPS, Supabase/baseline, PostgreSQL 15 ou Linux amd64.

## Preparação e comandos

Execute na worktree que contém estes arquivos, com dependências do lockfile instaladas, Node ≥22 e Python 3. O lifecycle usa `fcntl.flock` do Python para exclusão entre processos. PostgreSQL nativo precisa disponibilizar `initdb`, `pg_ctl` e `pg_controldata`; o default é `/opt/homebrew/opt/postgresql@16/bin`. Para outro local, defina `EXTENSIONS_BENCH_PG_BIN` explicitamente. Isso não inicia Docker nem procura bancos existentes.

```bash
node experiments/extensoes/db-harness.mjs start
node experiments/extensoes/db-harness.mjs status
node experiments/extensoes/db-harness.mjs stop
```

`start` cria a bancada em `.superpowers/evidence/extensoes-bancada/`, escolhe uma porta livre em `127.0.0.1` e registra sua identidade. A reserva da porta é fechada antes de PostgreSQL iniciar; se outro processo ocupá-la nesse intervalo, o início falha. Nunca escolhe um servidor existente como substituto. `stop` preserva todos os dados e só opera após comprovar a propriedade offline e, se o servidor estiver ativo, sua identidade numa conexão real. `status` informa também a fase persistida, que pode estar incompleta após interrupção.

O banco chama-se `extensions_bench`, o dono sintético `extensions_bench_owner`. O endereço efetivo sai de `database.json`; não há senha. O cluster admite somente loopback, sem socket Unix. O gerenciador não lê `.env`, pgpass ou credenciais do CRM. Não use estes comandos sobre a pasta de outra sessão e não edite os marcadores manualmente.

Para preparar apenas o executor Wasmtime na área já marcada por `start`:

```bash
python3 -m venv --copies .superpowers/evidence/extensoes-bancada/venv
.superpowers/evidence/extensoes-bancada/venv/bin/python -m pip install -r experiments/extensoes/requirements.txt
```

Isso baixa a dependência fixada em `requirements.txt`. `--copies` é necessário porque a guarda recusa links no caminho do interpretador. O runner do runtime valida o proprietário antes de executar esse ambiente ou escrever evidências.

## Console e prova pelo navegador

```bash
node experiments/extensoes/console.mjs
# Abra http://127.0.0.1:38761
pnpm exec playwright test -c experiments/extensoes/playwright.config.mjs
```

A porta é fixa para recusar consoles concorrentes, sem encerrar o processo que já a ocupa. O console aceita somente as três provas enumeradas. Um supervisor Python mantém a exclusão entre console e CLI durante a vida real do trabalho, inclusive se o console morrer. Os resultados e traces ficam na área exclusiva da bancada; falha e ambiente incompleto não viram sucesso. Encerre o console com Ctrl+C. Isso não para o PostgreSQL, cujo encerramento é feito pelo comando `stop` acima.

Cada início usa um UUID de solicitação e recibo persistido antes da autorização do trabalho. Se a resposta se perder, a tela informa que a confirmação está pendente e consulta o mesmo recibo; reenviar o mesmo ID não executa novamente. A recarga recupera resultados já gravados. Ela não reconstrói um relatório perdido por interrupção do executor.

O caminho de CLI é `node experiments/extensoes/runner.mjs runtime` (ou `events`/`state`). Ele compartilha a guarda do console. Timeout ou SIGTERM do supervisor encerra o grupo de processos próprio e confirma seu término antes de liberar a reserva. SIGKILL do supervisor ou saída anormal do runner conserva a reserva e recusa nova execução. Nesse caso, inspecione os processos e a reserva da área própria antes de qualquer recuperação manual; não apague o arquivo de lock para forçar uma execução, nem mate PIDs lidos de arquivo sem confirmar sua identidade. A bancada não faz essa recuperação incerta automaticamente.

A prova de navegador valida a identidade da worktree antes de enviar mutações. O cenário de ambiente ausente move temporariamente o venv exclusivo e o restaura em `finally`; não execute outra prova Wasmtime simultaneamente por CLI durante essa jornada. A execução bem-sucedida seguinte verifica a recuperação. A suíte da bancada usa sua configuração própria e fica fora do Vitest do produto.

O perfil Docker usa comandos e journals próprios, descritos no [relatório 07](../../docs/research/extensoes/07-perfil-comparacao-executor.md). Não é acionado pelos três botões nem pela guarda do supervisor acima. Execute-o separadamente, sem concorrência com outras medições. O diagnóstico do ensaio Wasmtime distingue disponibilidade do Docker de execução do perfil: `container_comparison.status=not_run` significa que aquele relatório não executou contêineres, mesmo quando `daemon_status=ready`.

## Recuperação e propriedade

`owner.json` identifica a worktree. `cluster.json` registra criação, caminho, identidade do diretório (dispositivo/inode), porta, identificador PostgreSQL e hashes das configurações. É escrito por troca atômica com `fsync`; a intenção de criar/iniciar fica durável antes da operação. `database.json` só publica o contexto depois da criação do banco e da instalação da atestação.

Fases: `created` → `initialized` → `start_requested` → `server_started` → `database_created` → `ready`; encerramento usa `stop_requested` → `stopped`. O estado do processo é medido novamente, sem confiar apenas no nome da fase. O lock de lifecycle é liberado pelo SO quando o supervisor morre; um segundo comando simultâneo falha com `Lifecycle ocupado`, sem disputar os arquivos.

Depois de uma interrupção, repita `status` e então `start` para completar ou `stop` para encerrar. Ambos funcionam quando o servidor iniciou ou o banco foi criado, mas `database.json` ainda não existe. Após `initdb` completo, um registro `created` pode ser retomado somente no mesmo diretório originalmente criado, antes de qualquer início; o identificador é lido offline e persistido. Se `initdb` deixou arquivos parciais sem controle utilizável, o comando preserva os arquivos e recusa iniciar. Essa situação exige inspeção manual da área própria; o gerenciador não apaga automaticamente um cluster parcial.

Um `postgres/` não vazio sem registro de criação é recusado, mesmo com `owner.json` e `PG_VERSION`. Diretório substituído, links, tablespace externo, configuração modificada e identidade offline divergente também são recusados antes de iniciar. Configurações que carreguem arquivos, executem bibliotecas/comandos externos ou redirecionem dados/autenticação não são admitidas.

A única migração de metadados legados é explícita e exige que a bancada antiga esteja viva, possua `database.json` e tenha identificador previamente conhecido:

```bash
node experiments/extensoes/db-harness.mjs upgrade IDENTIFICADOR_PREVIAMENTE_REGISTRADO
```

O comando compara o argumento com o registro anterior, com `pg_controldata` offline e com a conexão real, além do diretório/configurações. Só então grava o novo marcador e instala a atestação; não reinicia o serviço. Não serve para adotar cluster desconhecido ou para recuperar uma instalação legada sem registro confiável.

## Contrato de conexão das provas

```js
import { connectBenchDatabase, readContext } from './common.mjs';
const context = await readContext(repoRoot);
const client = await connectBenchDatabase(context); // já conectado e atestado
try {
  await client.query('select 1');
} finally {
  await client.end();
}
```

Cada conexão física, inclusive workers, deve vir dessa fábrica. Não crie `pg.Client` ou `pg.Pool` diretamente nas provas. `assertBenchDatabase` continua disponível como diagnóstico; não substitui a fábrica nas conexões que executam SQL.

A fábrica fixa host, porta, banco, papel, encoding, SSL, opções de startup e demais campos relevantes do driver. O callback de senha lança em qualquer desafio de autenticação: nem `PGPASSWORD` nem pgpass podem ser enviados a uma porta reutilizada. Valores vazios isoladamente não protegeriam contra o fallback do driver. A conexão é devolvida somente depois de conferir banco, `session_user`, `current_user`, diretório e identificador no mesmo socket. O consumidor pode configurar `search_path` e timeouts após recebê-la e precisa encerrá-la.

`{ user: 'bench_state_tenant_a' }` e `{ user: 'bench_state_tenant_b' }` conectam como papéis reais, preservando RLS e `session_user`; não usam `SET ROLE`. Nessa base sintética, `bench_identity.attest()` é uma função `SECURITY DEFINER` com `search_path=pg_catalog`, sem parâmetros nem acesso a dados do ensaio. Ela só retorna diretório/identificador para os três logins admitidos. Uso/execução dessa função são públicos para permitir papéis criados depois do bootstrap, mas criação no schema e execução direta de `pg_control_system()` são revogadas. Nenhum privilégio de tabela ou bypass de RLS é concedido.

A atestação protege contra destino acidental incorreto e reutilização de porta entre conexões. Não é autenticação criptográfica de um servidor hostil capaz de forjar o protocolo/respostas, nem isolamento contra alguém com o mesmo usuário do sistema operacional e acesso de escrita aos arquivos.

## Provas focadas da base

```bash
node --test experiments/extensoes/common.test.mjs experiments/extensoes/db-harness.test.mjs
pnpm exec eslint experiments/extensoes/common.mjs experiments/extensoes/common.test.mjs experiments/extensoes/db-harness.mjs experiments/extensoes/db-harness.test.mjs
```

As provas de protocolo usam somente sentinelas sintéticas: o controle inseguro precisa transmitir a sentinela e a fábrica segura precisa recusar sem pacote de senha. As provas de lifecycle criam clusters próprios sob `extensoes-bancada/lifecycle-tests/`, interrompem seus supervisores com SIGKILL após initdb/início/criação do banco e verificam recusa, retomada e encerramento. Não param o cluster principal da bancada. Só apagam os recursos de teste depois de confirmar seu encerramento; falha no cleanup preserva os arquivos para inspeção.

Esses testes exigem o PostgreSQL nativo indicado acima e Python com `fcntl` (macOS/Linux). Não simulam perda de energia, falha de disco, interrupção no meio de todos os writes internos de `initdb`, nem substituem as provas do produto.
