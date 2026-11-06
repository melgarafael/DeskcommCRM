# Prova do preenchimento revisado do card — #3476

Medido em 26/10/2026: banco dirigido e tipos gerados em Postgres 17 próprio na
VPS de teste; seis casos de revisão no Playwright real do CI, com Supabase
fresco aplicado do baseline. A [prova visual](../../evidence/propostas-3476/README.md)
preserva três capturas, o manifesto do artefato e o diff autorizado dos invariantes.

O CI identificou cinco erros de consumidores dos tipos gerados e uma policy
intermediária no baseline. Os consumidores agora estreitam JSON sem cast; o
teste da view acompanha a nulabilidade do gerador e mantém a proibição do título
pessoal. A criação intermediária da policy saiu do baseline. A cerca e o teste
da view passaram juntos (24 casos em 2 arquivos). As migrations originais e a
policy final da 0807 permanecem intactas.

O baseline medido tem SHA256
`04651de6660552895f88858ae8ffc608c90f4272be77a896ae733db0c4a98345`.
Foi aplicado duas vezes na bancada VPS do candidato `8866339`, sobre o volume
próprio preservado, e instalado do zero na parte 7 do run `40400799649`. A
tentativa de build na VPS foi interrompida por pressão de recursos e não conta
como prova de build ou UI. Os processos, contêineres, rede e listeners próprios
foram encerrados; os serviços alheios do curso foram preservados.

A integração posterior da `main` em `63dfc0fda` trouxe a 0793. O único conflito
era a inserção dos blocos 0793 e 0797 no mesmo ponto; ambos foram preservados,
nessa ordem e antes da varredura de funções. A policy 0807 permaneceu intacta.
O baseline integrado tem SHA256
`1807cf2be3195d1f642adbc151af35079bb8fa50d1b876a701cad905d2c67197` e recebeu
nova prova de instalação e reaplicação com `ON_ERROR_STOP=1`, num Postgres 17.11
vazio e próprio, sem reaproveitar o volume anterior. Nenhum Next ou stack
Supabase completo foi iniciado nessa rodada; o contêiner de 1 GiB foi removido.

## Banco

O CI existente aplica o baseline em instalação e reaplicação e mede pg15 e pg17.
Os novos invariantes entram nele sem criar outro gate. Para a rodada dirigida
na VPS reservada, usar o mesmo comando do produto, com um worker:

```sh
TEST_DB_IMAGE=pgvector/pgvector:pg17 pnpm test:db \
  tests/invariants/propostas-de-campos-anonimizam-motivo.test.ts \
  tests/invariants/propostas-de-campos-rls-rbac.test.ts \
  tests/invariants/propostas-de-campos-update-com-dados.test.ts --maxWorkers=1
```

Medido em 2026-10-26: antes da 0807, **2 falhas e 8 sucessos**. O INSERT sem
RETURNING aceitou organização A com o negócio de B, e os dois motivos legados
continuaram legíveis após a 0797. Depois da 0807: **10 sucessos em 3 arquivos**,
com instalação e reaplicação do baseline sem erro e as três conferências do kit
(checkout, v1.89.0 e v1.63.0; 184 regras cada) verdes. O banco era novo e só tinha
fixtures sintéticas; foi removido ao terminar. Não é a suíte de banco inteira.
O mesmo SQL foi medido com o número local 0801 e renumerado para 0807 antes da
primeira publicação, por colisão com o PR #3485. A mudança é de nome e cabeçalho;
os comandos SQL medidos permanecem iguais. Essa rodada dirigida precede a
retirada da policy intermediária do baseline; a definição final não mudou.

A 0807 reaplica o vínculo do USING no WITH CHECK e limpa o motivo legado pelas
duas relações com contato já anonimizado. Não recria a cascata: a 0797 continua
sendo a definição final com ACL exclusiva do servidor. Ambas as migrations
anteriores permanecem intactas. O apêndice da 0807 vem depois da criação da
tabela 0772; não cria funções e pode ficar no fim do baseline.

- Anonimização: RPC formal como `service_role` e RPC da ficha como sessão
  autenticada administrativa; vínculo direto e `crm_lead_links`; vizinho na
  mesma organização e outro tenant; decisão preservada; retry sem efeito; ACL.
- RLS/RBAC: viewer lê sua proposta e não decide; manager decide a própria;
  ninguém lê ou decide a do outro tenant. O INSERT sem RETURNING verifica o
  vínculo entre organização e negócio sem esconder o problema por uma policy de SELECT.
- Atualização com dados: aplica a 0772 original, cria proposta, anonimiza e
  comprova o motivo legado ainda legível; aplica a correção forward e exige
  remoção pelos vínculos direto e secundário, com a linha, decisão e data da
  anonimização preservadas. Propostas de contatos vivos na mesma organização
  e noutra mantêm seus conteúdos. Este caso também é diagnóstico:
  somente trocar o corpo da função não cura linhas já anonimizadas.

## Tela e concorrência

A spec roda na parte 7 do workflow E2E existente. Ela semeia seu funil e usa os
seeds canônicos de credenciais e token MCP; não ler ou copiar valores de ambiente
para a conversa. O destino deve ser local ao ambiente de teste. Para reprodução:

```sh
pnpm exec playwright test tests/e2e/propostas-de-campos-do-card.spec.ts --workers=1
```

A chamada real a `/api/mcp` recebe a leitura textual controlada de um documento
sintético. A proposta nasce pela ferramenta de produção e o card permanece
intacto. O manager abre o card no quadro, confere trecho/atual/proposto, confirma
`1,234` sem mudar a escala, corrige outro caso para `9,876` e descarta um campo.
O viewer lê, não recebe botão e tem 403 no POST direto. Uma revisão velha recebe
409 após outra decisão e mantém o valor do card.

Dois casos usam uma trava de linha real para eliminar a sorte do escalonamento:
dois pedidos HTTP leem `pending` antes de disputar o UPDATE; só um pode vencer.
No outro, `vencePropostasDeCampo` executa de verdade numa transação enquanto o
POST ainda enxerga a versão anterior; ao liberar a expiração, confirmar dá 409.
As capturas ficam em `evidence/propostas-3476/`, e o CI as preserva também quando
a parte passa. Elas contêm apenas fixtures sintéticas.
Não se afirma prova de modelo lendo PDF; o seam medido é a entrada MCP.

A parte 7 do run `40400799649` registrou os seis casos acima como verdes
(job `121847899398`, 42 casos no total, 16,5 minutos de testes). O HEAD do PR era
`0a52385384baf59f9bc0135789c91168bf9f91bc`; o checkout de merge compilado foi
`111bbf7581aeedca43a5525692683a9259b51b81`. A comparação de produto, baseline,
spec, seeds e workflow entre eles é vazia. O artefato `12690158434` teve o digest
conferido antes da extração restrita às três imagens.

Na captura de encerramento, o campo Medida ficou abaixo da área visível do
painel; o valor foi comprovado pela asserção do formulário e pelo banco, não por
essa imagem. O teste foi ajustado para rolar até o campo nas próximas capturas.

Depois da prova de UI, a leitura encontrou um erro inesperado de gravação que
escapava da borda API. A rota agora conserva a volta para pendente e devolve
`fail("internal_error", ... , 500)` com o texto genérico já usado pela rota irmã
de contatos. A reprodução ficou vermelha (1 falha/15 sucessos); o reparo ficou
verde (16 sucessos), incluindo controle do `ApiError` 422. Nenhum arquivo de
interface mudou; essa linha do handler não foi executada na prova de UI acima.
Os três componentes `RevisaoDoDocumento`, `LeadDossier` e `LeadFieldsForm` também
mantiveram os blobs após integrar a `main`; outras partes do produto mudaram.
O candidato integrado precisa dos cinco checks obrigatórios antes do merge.

## Tipos gerados e verificação completa

Medido com o CLI Supabase 2.122.0 já em cache na VPS. Essa versão gera TypeScript
no próprio processo pela conexão direta, conforme sua
[documentação de efeitos](https://github.com/supabase/cli/blob/v2.122.0/apps/cli/src/commands/gen/types/SIDE_EFFECTS.md).
O banco recebeu o baseline e as provas acima. Duas passadas de geração do schema
`public` produziram arquivos byte a byte idênticos. Comando de reprodução, na
pasta própria de teste e com o DSN do banco efêmero:

```sh
supabase gen types --db-url "$TEST_DB_CONN" --schema public \
  > /tmp/database-propostas-gerado.types.ts
```

Comparar a saída e substituir `lib/database.types.ts` pelo resultado do gerador,
com formatação mecânica pelo Prettier já instalado. A saída bruta permanece
guardada para comparação. Não montar tipos da nova tabela à mão nem gerar do
projeto remoto. A regeneração alcança a defasagem do arquivo anterior: 170 tabelas
descritas passam a 206 no schema real, e 146 funções passam a 248. O delta inclui
estruturas anteriores à proposta e requer avaliação na tipagem integral.

Depois de integrar a `main`, as duas passadas sobre o baseline integrado
produziram o mesmo SHA256 bruto
`09839121c61af8d5788da5c2dcd095eddb8e99933f83d0ddadbb615a37f413e5`.
Com formatação mecânica, o arquivo publicado tem SHA256
`d629f5f97ddd145211e43041949852069aa065553242a19c66a53408adf318ea`.
A diferença contra a primeira geração é somente a assinatura da função 0793;
nenhum tipo foi montado à mão. O manifesto registra o baseline, o prelude e o
snapshot do índice usados para a geração antes de concluir o merge.

Após a integração, passaram 112 casos em quatro arquivos dirigidos (API da
fila, baseline sem versão intermediária, tipo da view e evidência citada), além
do ESLint dos seis arquivos TypeScript alcançados e da conferência do diff.

O CI de `0a5238538` passou typecheck, lint, banco pg15/pg17 e as outras partes do
verify, mas revelou uma contagem textual frágil em `reabertura-1538.test.ts`:
o gerador descreve `retomado_de_lead_id` em `Row`, `Insert`, `Update` e também em
`Relationships`. O teste agora valida diretamente os três tipos do cliente,
com a nulabilidade de cada um, e preserva as verificações da migration, FK e
MANIFEST. A reprodução tinha uma falha e 15 sucessos; o conjunto de 14 arquivos
unitários que mencionam o artefato passou 165 casos, com um worker e heap de
1,5 GiB. A busca também alcançou os invariantes de banco; eles não foram editados
nem executados por essa rodada unitária. O arquivo gerado permaneceu intacto.

O CI mede typecheck integral, lint, suíte completa, banco nas majors suportadas
e build. Antes de sair do draft, reconciliar os resultados reais do HEAD medido,
preservando o escopo autorizado das adições herdadas de invariantes: somente
+6/−0 e +20/−0 nos dois arquivos identificados, sem alterar assertivas anteriores.
