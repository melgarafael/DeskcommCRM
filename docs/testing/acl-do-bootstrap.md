# ACL do bootstrap antes do baseline

Melhoria do harness resgatada do PR #3542, de @webtecnica. A issue #887 já teve
seu conserto publicado na1.92. Esta prova adicional não muda SQL de produto nem
obriga tabelas finais a conservar permissões amplas.

O prelude reproduz o perfil legado ALL observado nas imagens Supabase usadas
na medição. Projetos que adotam permissões explícitas continuam com sua própria
política: o perfil de teste permite verificar se um REVOKE do produto funciona
contra uma concessão realmente existente, não restaurar essa concessão no produto.

Antes de aplicar o baseline, as sondas próprias de função, tabela e sequence
registram nove combinações de família e papel em `test_db.acl_do_bootstrap`.
Cada linha guarda a major observada, o perfil, os privilégios diretos e efetivos
e os testemunhos de captura/remoção anteriores ao produto. Só o recibo permanece
nos moldes; os objetos sintéticos são removidos antes do install.

O invariante consulta o catálogo, exige a matriz inteira e rejeita recibos vazios,
incompletos, de outra major/perfil ou sem os testemunhos. O perfil de tabela tem
sete privilégios noPG15 e inclui também MAINTAIN noPG17. Sequence registra
SELECT/UPDATE/USAGE; função registra EXECUTE. A tabela nova do recibo é fechada
aos papéis da API, sem alterar a ACL compartilhada do schema de teste.

O estado final do produto é conferido só nos seus contratos próprios: negação
de UPDATE/DELETE/TRUNCATE na auditoria e TRUNCATE de idempotency_keys por papel.
Um REVOKE final legítimo em outra tabela, executado e desfeito em transação,
não invalida a prova anterior do bootstrap.

## Medição dirigida

No candidato `de50432bfcde`, antes da composição posterior com a main:

| Major | RED: uma concessão direta removida | GREEN normal | Ignorados |
| --- | --- | --- | --- |
| PG15 |18 falhas e7 controles aprovados |3 arquivos,35 testes aprovados |0 |
| PG17 |18 falhas e7 controles aprovados |3 arquivos,35 testes aprovados |0 |

A previsão foi registrada antes da bancada. O RED retirou somente a linha real
de concessão de funções a authenticated no prelude, sem neutralizar sondas.
Direto ficou vazio e efetivo continuou EXECUTE, medidos nas duas majors. As
sondas antigas e install/update passaram; o consumidor novo reprovou pela origem
direta faltante. Cada GREEN usou a cópia normal intacta em container novo.

Foi executado um trecho literal contíguo do próprio harness, recortado
mecanicamente da criação do molde ao fim do UPDATE, em container previamente
limitado. Vitest, configuração e setupFile eram os originais, com um worker e
Docker SSH remoto. Install e reaplicação foram estritos, com moldes de uma e duas
aplicações; o controle de REVOKE e rollback passou nas duas majors.

Essa bancada não executou o script inteiro, a conferência do kit ou todos os
invariantes. Não mediu um projeto Supabase na nuvem nem executou typegen,
typecheck ou build. Os gates completos continuam sendo os do CI. A composição
posterior com a main conserva exatamente os quatro arquivos de código medidos e
recebe baseline, migrations e tipos da main sem alterações próprias.
