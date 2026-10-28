# Conta de e-mail da organização e diagnóstico do domínio

Resgate de #3443/#3464 de @webtecnica. Fontes `9e71f1a016a92113a7cb2c46779c1950df34f939`, `01857f308a574e770b0d4a7669a40ed1bab99799` e `b488ed1a83c5040393f53e9ae0149a970c4029bc`. A composição explícita com a main `b8870b3dc0cceb04954966f3d141a22ae2a0992c` preserva a marca fresca e o saneamento dos logs de e-mail, os participantes, as propostas de campos e a retenção de mídia.

## Contrato

Em Configurações → Marca, o administrador conecta sua conta Resend com From verificado para envio. A conexão usa `fromAddress`, a mesma régua do envio, e exige permissão de consulta de domínios. O servidor resolve o tenant, papel, suporte somente leitura e MFA; o navegador não escolhe organização ou domínio da consulta. A conta é cifrada em tabela própria sem policies e sem privilégios do navegador; a projeção de tela contém somente From/last4. Erros de banco da conexão/desconexão não voltam em texto bruto.

Só ausência de linha permite o fallback da automação para o transporte da instalação. Falha de leitura, cifra ou dados interrompe a saída com motivo próprio. E-mails de sistema continuam no roteador da instalação. O diagnóstico parte do From conectado e dos registros oficiais da mesma conta, suporta Return-Path personalizado/TXT/MX/CNAME e distingue registro ausente de consulta inconclusiva. Estado verificado da Resend e DNS observado são apresentados separadamente; nenhum deles promete entrega na caixa.

## Banco real observado em 27/10/2026 UTC

Fonte medida: `86e09872c6eb0b744ff6a8ad644c8a73e811c817`. O baseline tem a main b887 inteira como prefixo byte exato, seguida somente pelo apêndice0795. Migrations9016/9017/9021 e catálogo frozen idênticos à main; a entrada+13 de `PROVA_PROPRIA` segue proposta não aplicada.

- PostgreSQL17.11 real, imagem `pgvector/pgvector:pg17`, amd64; container próprio limitado1Gi/CPU1, bind localhost e porta alocada pelo daemon.
- Prelude extraído mecanicamente de `scripts/test-db.sh`. ACLs de Supabase presentes antes do baseline. Vitest usa a configuração e o setupFile originais: banco novo por arquivo a partir de `inv_baseline`, sem substituir o reset.
- INSTALL estrito com `ON_ERROR_STOP=1`: PASS, **15/15 casos PASS**.
- Controle causal: `GRANT ALL` ao service_role no molde. Reprovaram exatamente o ACL CRUD restrito e a recusa de TRUNCATE: **2FAIL/13PASS**. Os12 callbacks originais do autor permanecem byte idênticos.
- UPDATE estrito sobre o banco existente com ACL excessivo: PASS, **15/15 casos PASS**. Marcador no banco confirma duas aplicações. Cleanup da fixture deixou zero contas e zero organizações próprias.
- A prova observada inclui zero grants diretos de qualquer privilégio para PUBLIC/anon/authenticated, inclusive os8 disponíveis noPG17. Depois dessa corrida foi preparada, no mesmo caso novo, a checagem de privilégio efetivo herdado:7 noPG15, mais MAINTAIN condicionado aoPG17. Essa assertiva adicional aguarda CI; não foi declarada executada no banco.
- A fixture de banco usa bytes artificiais; prova formato opaco/ACL/RLS, não AES. Unidades separadas cifram e decifram com a implementação real.

Hashes SHA256: baseline `bd8f5b12e3850dd8aa20d6260bbc71c8f10a03b6e4d593590fed3565496d5364`; migration0795 `4bb906e25241a93cc176533e0edebaf013d3fd3ac7ca8ae4cee0fbe548200cb5`; prelude `62afc1fa29248f8c5d9318b882489894aab92adb1d6716d7b2e39e4e06d3eb3c`. O invariante medido noPG tem SHA256 `6f4a5ce784abac93c256abf98bf81e165fffa76f140aaa0ff97a643d084e7892`.

A bancada foi removida às04:28:34Z. Porta33473 fechada, zero containers ativos, listeners alheios3480/53/22022 preservados; slot transferido explicitamente à frente9022. Não repetir banco por causa do instrumento textual que esperava nomes de propriedades sem aspas: esse erro pós-coleta foi preservado e resolvido por validação AST offline, sem modificar o artefato bruto.

## Tipos integrais

CLI Supabase **2.122.0**, schema public do banco combinado acima, duas gerações completas iguais,454936bytes cada. SHA256 bruto `6eaf8e4a280f44eba90a05521c9295570e5be68e47cead269e2d8fcde2c71912`. O arquivo inteiro foi formatado com a configuração Prettier do projeto e incorporado sem unir hunks: SHA256 `2adaec5a8f6bff1a90ab1a9107ef30ea368a28bfcc76f913206c4796697e4931`.

O parser TypeScript conferiu todas as tabelas/views/funções/enums/tipos compostos contra o canônico anterior, com a mesma formatação: só acrescenta `organization_resend_accounts`. Nenhum tipo anterior mudou ou desapareceu. `lead_field_proposals`, `conversation_participants`, retenção e `tags_do_contato` no retorno calculado da conversa e na função foram preservados.

## Provas leves e limites

No combinado b887:7arquivos/144casos de produto PASS;9arquivos/365casos de cercas, mapa e fragmento PASS; ESLint dos23arquivos tocados zero e diff-check zero. Dois casos novos reproduziram o retorno de erro bruto de banco antes da correção e agora passam. Os recortes são informados separadamente, sem somar sobreposições com corridas anteriores.

SDK real do cache6.33 enviou HTTP a receiver localhost próprio com chaves/destinatários sintéticos. Foram observados From/To/Reply-To/corpo e hashes Authorization distintos dos dois tenants; consulta de registros oficiais inclui Return-Path personalizado. Não é prova de entrega paga, caixa de correio, banco ou navegador. A versão canônica do candidato é a declarada no package/lock e precisa passar noCI com dependências instaladas por ele.

Permanecem pendentes: cinco checks finais do head publicado, assertiva efetiva7/8 noCI e prova visual real de descobrir o card pelo menu, conectar/recarregar sem chave, conferir diagnóstico, recusar erros, separar dois tenants e desconectar. Os PNGs devem ser produzidos somente após as assertivas do caso PASS. O transporte sintético precisa estar explícito, sem mock de DOM, sem alterar DNS/TLS globais e sem chave paga. Nenhum typecheck integral/build foi executado noMac. Nenhum Ready/auto/merge autorizado por este relatório.

## Jornada preparada na parte2 — execução visual ainda pendente

O harness aprovado no planoUIv2 usa a parte semeada2. Nas três últimas E2E verdes da main, os jobs custaram1059/1104/1004s:336s livres no pior caso até o orçamento1440s. O teste próprio tem teto120s e a configuração existente mantém retries:0; nenhum teto, margem, clock ou timezone foi alterado. Login aguarda a próxima janelaTOTP real para não reutilizar o código consumido por outra spec.

O receiver3997 existente fica vivo pelo job inteiro e atende tanto a SDK da plataforma quanto a da organização. Somente a parte2 publica RESEND_BASE_URL; a parte4 continua pristine, com os mesmos serviços, chave vazia e13smokes antigos. Domínios/registros/capacidades sintéticos são reconhecidos por conta; o envio legado da plataforma permanece compatível. Recibos guardam só SHA256 do Authorization. O boot verifica o PID do processo próprio e o cleanup não é responsabilidade da spec. Não há outro Next, job, dependência ou PG.

Validação local adicional: os13smokes antigos e13contratos novos passaram por HTTP real; SDK real do cache6.33 consultou os domínios/registros e enviou como empresa e plataforma ao mesmo receiver. Listener/PID/porta foram encerrados. Não é banco, browser, entrega paga ou caixa postal. Loader da ação real passou sem app/DB; três testes de processo real cobrem sucesso, prazo e término do caso, com SIGKILL/fechamento aguardados e sem publicar stderr bruto. O CI confere o loader/contrato da versão efetiva da SDK antes de abrir o navegador.

A nova spec prepara menu→Marca, admin/MFA, From inválido sem HTTP, quatro recusas próprias sem gravar, conexão/reload sem chave, DNS ausente separado de verified, ação send_email real com banco e receiver, cifra ilegível sem fallback, dois tenants do mesmo admin e desconexão que conserva a vizinha. O tenant ativo é confirmado pelo nome único na interface antes de qualquer escrita. A projeção segura da tela não decifra: o caso de cifra inválida exige conta ainda configurada e falha/zeroPOST da ação, sem inventar alerta visual. Todos os filhos encerram antes do cleanup e o reciboPASS só é escrito depois de remover ambas as organizações próprias.

Os PNGs e o recibo serão coletados pelo passo de sucesso já existente, somente após o casoPASS. Essa jornada ainda NÃO foi executada em browser/Supabase/Next reais; os cinco checks do novo head e a autorização do catálogo protegido continuam pendentes. Não inferir UX de smokes, sintaxe, lint ou unidade.

## Composição e tipagem dirigida antes do DRAFT

A main `271a327efe9d0f4532657f3007a6e751306986bd` foi integrada por merge normal. O único conflito foi o mapa de jornadas, resolvido preservando a página inteira da main e a seção de e-mail. Baseline e tipos mesclaram automaticamente: nenhum hunk gerado foi escrito à mão. AST confere todos os objetos e campos da main byte equivalentes em tokens; o único acréscimo é `organization_resend_accounts`. SHA256 do tipo combinado: `e02defc06df6e89d879001eb50cd5619fe33b3022383f01ab0cb5f32b275acbb`. O catálogo protegido segue exatamente a main (`2f37a6fde5b7790f7cad3615e60a51dcff7c445469844f453ed99dce26b7e4be`), sem o +13 pendente do doc223. Não houve nova geração ou bancada.

Tipagem sem emissão dirigida a todos os18TS/TSX novos, com os ambient reais do Next/Node e `types/public-env.d.ts`:125fontes próprias,1602fontes totais, zero diagnósticos. Nenhuma declaração auxiliar, next-env ou tipo gerado foi inventado. A primeira passagem detectou dois TS2345 numa tabela própria de casos DNS: arrays eram espalhadas pelo `it.each`. A tabela agora passa objetos `{ registros }`, preservando as três entradas e a mesma assertiva. Runner, ActionCtx/EventRow, crypto, ProcessEnv, fixtureJSON e helper de filhos foram conferidos com tipos reais. Isso não substitui o typecheck integral doCI nem afirma a versão canônica da SDK: o cache local é6.33.

O gerador real de credenciais grava `org_name`; ainda assim a jornada lê `display_name` atual do banco para confirmar a volta à organização original. Assim não depende de um nome de seed que outra spec possa ter alterado. As47assertivas da jornada continuam presentes. Browser/Next/Supabase desta jornada permanecem pendentes doCI.

Após a composição e o ajuste da tabela:7arquivos/71casos dirigidos PASS, inclusive as três entradas DNS, o ciclo de vida dos filhos e as guardas de parte4/env/orçamento/cobertura. ESLint dos29arquivos próprios:zero erros e um aviso herdado da main271a em `lib/email/resend.ts:33` (import `env` sem uso). O modo canônico aceita warnings; o resultado não é descrito como zero avisos.

## Primeiro CI da jornada e reparo de navegação

No head `9cca11411`, run40505780953/job122196483951, a parte2 teve89PASS/6SKIP/1FAIL. A jornada própria NÃO concluiu: após conexão/reload/DNS/envioA e controle de cifra ilegível, a troca A→B ficou88,66s tentando clicar num item fora do viewport e atingiu120s. Trace e captura mostram scrollTop1986, viewport1280×720 e portal em translate(264px,-1938px);176tentativas de ação não o alcançaram. Isso não é corte geral da parte nem prova completa de UI. Nenhum PNG/recibo desse caso foi contadoPASS.

O reparo conclui uma volta real ao topo antes de abrir o seletor, confirma scrollY0 e trigger/item no viewport, e limita o clique a5s para diagnóstico. Preserva as47expectativas anteriores byte a byte e adiciona três guardas;120s/retries/tetos permanecem iguais, sem forceclick ou sleep fixo. Se o portal continuar fora com trigger realmente visível, a próxima falha será tratada como defeito de produto, sem outro remendo de fixture.

A main `e79610a9d074be2f19304c075375ad279f23eb48` entrou por merge normal. O único conflito, dicionario.ts, une literalmente os textos do e-mail e a dica de texto de reserva da main. Mapa e workflow auto mesclaram; o mapa preserva todas as linhas da main. AST dos tipos confirma todos os objetos/campos da main mais a tabela Resend, sem geração/hunks/PG novos. Migration0795 e frozen permanecem íntegros; o +13doc223 ainda não foi aplicado. Tipagem dirigida com ambient reais do recorte afetado passou sem diagnósticos, lint sem erros/avisos. A jornada completa ainda depende do CI do novo head.
