# Revisão contextual, Casos e continuidade

Uma resposta como “esse horário” depende da oferta que o cliente recebeu. Responder a um Caso depende também da decisão humana vinculada ao pedido. A revisão precisa desses fatos, com origem e limites: consulta não comprova reserva, e registrar um Caso não comprova sua conclusão.

A agenda independente da PR #3132 já foi integrada. Esta contribuição foi conciliada com a main oficial até `2b34aba9b09492c808162c010b2ffcfe88377195`. A PR #3069 permanece rascunho, aguardando definição TypeSafe/LGPD para integrar JEV e a conferência semântica. Código preparado não equivale a essa liberação.

## Fluxo e limites de autoridade

A ponte comum observa as ferramentas do conversador/operador, inclusive pré-gravação, depois da política de prévia. O envio espera concluir as ferramentas iniciadas no mesmo passo antes de obter a fotografia factual. O rastreamento e a proteção de circuito nativos continuam presentes. O contrato compartilhado não importa o executor, não grava e não envia.

JEV permanece principal. A reserva configurada assume falha ou confiança insuficiente, com padrão de revisão de 70% e preservação das configurações persistidas. Consentimento continua explícito por finalidade/destino, inclusive para histórico, com releitura e revogação. Instruções do agente são dados auxiliares; não alteram critérios nem autoridade do revisor.

Respostas pela interface e pelo WhatsApp convergem para um evento humano autenticado, vinculado ao Caso e ao pedido. O handler relê esse vínculo e sua validade no banco. O canal WhatsApp continua opt-in; a migração não habilita a função. A origem da resposta não amplia a autoridade da pessoa nem transforma texto livre em autorização verificável.

O pacote preserva ordem, pedido, decisões, recibos, cobertura e omissões. Materiais comerciais autorizados podem fundamentar oferta; histórico de conversas não substitui essa fonte. Igualdade de pacotes entre revisores, isoladamente, não comprova o contexto do agente.

Reserva, publicação Google e comunicação são estados distintos. A retomada usa a operação existente e sua referência atual, preserva idempotência e não transforma espera técnica em nova aprovação humana obrigatória. Os avisos distinguem veto semântico, revisão inconclusiva, proteção do número e janela de envio. Recusas permanentes mantêm PT409.

O roteador preserva quatro mensagens quando a configuração legada está ausente; novos roteadores salvam explicitamente oito. Escolhas explícitas de 0 a 16 continuam possíveis. Aceite legado não autoriza silenciosamente a finalidade ampliada de histórico.

## Verificação de 23/10/2026

Foram usadas dependências do lock público e PostgreSQL real no QA existente, com bancos próprios de teste e provedores/canais controlados. Não houve mensagem externa nem chamada a modelos pagos. As medições dirigidas foram feitas em rodadas, reutilizando provas de arquivos cujo conteúdo permaneceu igual; não representam uma execução integral verde do repositório.

| Recorte | Resultado |
| --- | --- |
| Contratos, ferramentas, roteador, UI, retenção e cercas | 18 arquivos, 197 testes aprovados |
| Compatibilidade após a última main: ponte, cerca JEV, espanhol e ferramenta nativa de análise de site | 5 arquivos, 66 testes aprovados; há sobreposição com a linha anterior |
| Banco: Casos/WhatsApp, Google, recuperação, revisão, consentimento e RLS | 9 arquivos, 108 testes aprovados |
| Varredura RLS importada e não executada | 108 casos skipped, excluídos dos aprovados |
| Instalação e reaplicação do baseline atual | Ambas aprovadas |
| Tipos dirigidos | 195 arquivos alterados e dependências transitivas aprovados; checagem adicional do inbound/ferramenta de site aprovada após a última main |
| Controle negativo pós-commit da cerca JEV | 1 falha prevista em 12; restauração por hash e 12/12 aprovados |

A prova RLS dedicada está em `tests/invariants/google-publication-isolamento.test.ts`: duas organizações, acesso autorizado ao serviço, anon/authenticated sem leitura/escrita e releitura com JWTs distintos. O teste concede leitura apenas dentro de uma transação revertida para exercitar a política; não altera o ACL final. Revogação também é medida.

Os arquivos de banco exercitados foram `google-publication-isolamento`, `caso-whatsapp-contexto-integrado`, `agenda-recupera-comunicacao`, `rls-completude-varredura`, `google-publication-continuation`, `agenda-presenca-recuperacao`, `promessas-conversas-nao-provam-oferta`, `jev-roteador-no-turno` e `revisor-comunicacao-diagnostico`, todos em `tests/invariants/`.

Para reproduzir os recortes, use o lock do repositório, o prelude/baseline de `scripts/test-db.sh` e os arquivos acima. Testes que criam fixtures precisam de banco descartável próprio e de conferir `current_database()` antes da execução; não os aponte a uma base compartilhada com a UI. As cercas JEV e traduções estão em `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts` e `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`.

## O que não foi medido

Não executei localmente uma nova suíte completa, build ou E2E visual da árvore pública final. A tentativa local de typecheck completo esgotou heap de 5 GiB. O CI oficial posteriormente aprovou o typecheck completo e o build na cabeça `8d0b6b0762f270a306365230c81e9908bb810045`; os arquivos TypeScript permaneceram iguais na correção SQL seguinte. Isso não equivale a declarar todos os checks ou o E2E público aprovados. Os resultados automáticos precisam ser lidos separadamente na PR.

Provedores/canais controlados não provam precisão de modelos reais, entrega WhatsApp/Google ou cobertura universal. Evidência privada de instalações anteriores não foi transferida para o repositório nem atribuída a esta cabeça pública. Captura de revisão continua opt-in, auditada, com TTL e sem ampliação automática de consentimento.

## Migrações e integração

Os números 0717–0720 permanecem segundo a orientação do mantenedor na PR #3069, comentário de 22/10: colisões serão tratadas na integração. Não interpretar essa pendência como inexistência de colisão. A nova migração `20261023171454_0758_resposta_whatsapp_com_evento_verificavel.sql` foi criada pela CLI nativa depois de medir branches/PRs, com manifest e apêndice no baseline. O vocabulário canônico do Inbox mantém os eventos atuais, inclusive tarefas e parada da captura.


### Correção encontrada pelo CI oficial

Em 23/10, a cerca `check-do-baseline-nao-diverge-da-cadeia` encontrou `google_publication_turn` ausente nos dois blocos canônicos de `job_queue` do baseline. A migration 0718 já continha esse valor. O conserto acrescenta-o nos blocos existentes de `job_queue_kind_check` e `job_queue_turn_needs_contact`, preservando todos os valores nativos, sem criar outro bloco nem editar a cadeia aplicada.

Após o commit, as três cercas dirigidas passaram (8 testes). Retirar o valor de um bloco provocou exatamente 1 falha em 8; a restauração por hash devolveu 8/8. Em uma cópia própria do banco de QA, o baseline corrigido aceitou uma continuação Google com contato, recusou a mesma categoria sem contato pela constraint esperada e foi reaplicado mantendo a linha existente. A cópia descartável foi removida; a base compartilhada da UI e a produção não foram alteradas.

Na rodada oficial anterior, as partes 2–6 de `verify` e o typecheck completo passaram. A parte 1 parou na colisão 0717; a parte 7 apontou essa mesma colisão em duas cercas e a divergência do baseline descrita acima. A colisão continua a cargo do mantenedor na integração; o reparo do baseline foi validado separadamente. Não somar esses resultados a uma alegação de CI integral verde.


## Retomada pública: RLS, recibo e decisão de contrato

A conciliação com a main `2b34aba9b09492c808162c010b2ffcfe88377195` preservou o baseline oficial inteiro, os blocos públicos e os três acréscimos de vocabulário canônico. Não levou essa atualização às instalações privadas. O arquivo `contexto-do-atendimento.ts` consulta a capacidade do papel efetivo antes de construir a leitura; a função interna de resposta WhatsApp só aparece no SQL quando o papel já dispõe de EXECUTE. Não há GRANT, troca de papel, SECURITY DEFINER novo ou cache de capacidade. Um membro continua sujeito a RLS e recebe um limite explícito quando não pode validar a pergunta interna; o worker conserva o caminho completo e verificado.

São **duas consultas por fotografia**: capacidade do papel e leitura agrupada. O rótulo fixo `queries_per_snapshot:1` do benchmark antigo não mede esse novo total. A rodada de 30 leituras mediu p95 de 4,81 ms no QA isolado; não é promessa de latência de produção.

Provas da fonte `8371c80f402c7a1b558852325d2ef524a12cb576`, com lock exato e PostgreSQL real no QA existente:

- 90 testes em seis arquivos, lint dirigido e tipos dos reparos com importações transitivas aprovados.
- Baseline atual instalado e reaplicado em banco próprio. Recortes de continuidade Google, RLS Google, fontes de atendimento, resposta WhatsApp e a nova prova de capacidade do papel passaram. O conjunto de seis arquivos ficou com **54 testes aprovados e uma falha conhecida de contrato**, descrita abaixo; não é uma suíte integral verde.
- O recibo nativo de serviço conserva `failed` após uma tentativa malsucedida. `publicationReceipt` projeta `retrying` da mesma linha persistida para a recuperação automática. Identidade, revisão e ausência de prova de comunicação permanecem. Controle negativo pós-commit: 1 falha prevista em 7; restauração por hash e 7/7 aprovados.
- A prova de RLS verifica membro, outra organização, worker e troca de papel na mesma conexão, sem ampliar ACL. Controle negativo pós-commit: 2 falhas previstas em 3; restauração por hash e 3/3 aprovados.

### Decisão de contrato pendente da triagem

O invariante congelado `tests/invariants/revisor-conclusao-caso-encerrado.test.ts`, no caso negativo `fiel=false`, devolve `repasseConcluidoFiel:false` **sem** `verificacao_decisao` e espera `human_decision_unfaithful`. O contrato desta PR exige que uma acusação de divergência tenha vínculo com a candidata completa, a decisão elegível e um trecho/natureza concretos. Sem essa demonstração, o resultado é `human_decision_review_inconclusive`. **O envio permanece bloqueado nos dois estados**; o positivo fiel e os demais critérios não foram relaxados.

O recorte atual reproduziu exatamente uma falha em dois casos desse arquivo: envio fiel aprovado e envio infiel bloqueado; a diferença é o código persistido no cenário sem diagnóstico. A asserção e o arquivo congelado foram preservados. Conforme `CONTRIBUTING.md`, seção “tests/invariants/ é congelado”, a razão da regra concorrente fica explícita para a triagem escolher o contrato. Não foi acrescentada exceção para testes nem relaxada a regra de evidência para pintar o CI de verde. A unidade `repasse-concluido-sem-nova-pendencia.test.ts` comprova tanto a negativa sem prova/inconclusiva quanto a divergência demonstrada/veto semântico.

### Limites da rodada oficial anterior

Na cabeça pública `8d0b6b07`, as seis partes E2E 1/2/4/5/6/7 passaram; a parte 3 teve 94 aprovados, um skipped e a falha de recibo tratada acima. As duas majors de PostgreSQL tiveram 3987 aprovados, 17 falhas, um expected fail e sete skipped cada: as causas estavam nos CHECKs canônicos da fila, na chamada do validador sob authenticated e na classificação congelada do Caso. Esses resultados não foram reatribuídos à candidata atual. Os reparos têm suas provas dirigidas; novos resultados oficiais precisam ser conferidos pela cabeça a que pertencem.

A colisão 0717 e a definição TypeSafe/LGPD continuam explicitamente pendentes do mantenedor. A PR permanece rascunho. Não houve mensagem externa, chamada a modelos pagos, alteração de captura/TTL empresarial nem novo deploy nesta retomada.

## Complemento do CI oficial e dos testes dirigidos

A rodada automática da cabeça `75617107da8035b5c05d27dd3d326d72917ced11` terminou: typecheck integral, build e boot das imagens de app/worker/scheduler em AMD64 e ARM64 aprovados. As partes E2E **1, 3, 4, 5, 6 e 7** passaram; a parte 3 inclui o recibo que falhara na rodada anterior. PostgreSQL 15 e 17 tiveram, **cada um**, 4.052 testes aprovados, um expected fail, um skipped e **uma falha**: exatamente a classificação do invariante congelado descrita acima. A fila canônica e a leitura sob RLS passaram nessa rodada; as duas cercas estruturais ainda reprovam a colisão 0717 assumida pelo mantenedor.

A parte unitária 2 encontrou duas expectativas antigas do contexto que ainda contavam uma consulta e selecionavam o primeiro SQL. Foram atualizadas para conferir exatamente capacidade + leitura agrupada, os filtros anteriores e o argumento de capacidade explícito. O teste de opt-out automático de upstream também usava a hora real do runner e caiu fora da janela anti-ban; agora injeta o relógio nativo do handler em um instante dentro da janela. **24/24 testes dos dois arquivos, lint e tipos com importações transitivas passaram**. Critérios de revisão, proteções de envio e o invariante congelado não mudaram.

A parte E2E 2 ficou com 100 aprovados, seis skipped e uma falha em `cobranca-revendedor.spec.ts:82`: o menu ainda não exibia Cobrança. O trace mostrou POST de `/admin/sistema` iniciado às 01:22:52.239 UTC e navegação para `/admin/dashboard` às 01:22:52.550, antes da conclusão da gravação. A UI já tinha marcado o estado otimista e o POST ficou sem resposta concluída (status -1). O teste agora aguarda o interruptor sair de pendente e confere `MODULO_COBRANCA=ligado` no banco antes de navegar, mantendo a mesma busca do menu e todas as assertivas seguintes. Não força a chave nem acrescenta espera fixa. Lint e tipos desse arquivo passaram; **o fluxo completo após esse ajuste ainda depende do próximo CI**, sem alegação de verde antecipado. Os arquivos de runtime de cobrança e administração permaneceram iguais à main de referência, cuja parte E2E 2 passou; isso não transforma a falha observada em prova de defeito universal do upstream.

Depois da cabeça 756, os reparos adicionais alteraram somente três testes e este documento. As provas de runtime dessa cabeça permanecem atribuídas a ela. As falhas de classificação e numeração continuam explícitas à triagem, TypeSafe/LGPD continua condição de integração, e a PR permanece rascunho. Nenhuma suite integral local, novo ambiente ou chamada paga foi acrescentada para repetir os resultados já válidos.
