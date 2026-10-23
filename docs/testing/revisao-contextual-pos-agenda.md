# Revisão contextual, Casos e continuidade

Uma resposta como “esse horário” depende da oferta que o cliente recebeu. Responder a um Caso depende também da decisão humana vinculada ao pedido. A revisão precisa desses fatos, com origem e limites: consulta não comprova reserva, e registrar um Caso não comprova sua conclusão.

A agenda independente da PR #3132 já foi integrada. Esta contribuição foi conciliada com a main oficial até `ef50e7750ab65e700016f280f4a3df96f440e583`. A PR #3069 permanece rascunho, aguardando definição TypeSafe/LGPD para integrar JEV e a conferência semântica. Código preparado não equivale a essa liberação.

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
