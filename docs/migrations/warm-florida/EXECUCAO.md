# Execução — 14/09/2026 UTC

**Carga definitiva concluída e validada em produção.**

## Confirmado por execução

- Origem Warm e destino acessíveis por SSH; credenciais não publicadas.
- Backup do destino: `/opt/deskcomm-crm/backups/db-20260914T001627Z.dump` e `storage-20260914T001627Z.tar.gz`.
- Restauração no laboratório `warm-migration-rehearsal-v3`, com `--network none`, sem app, worker, scheduler ou portas públicas.
- As linhas das **177 tabelas** restauradas conferem com o backup por contagem e SHA256 (ordenado por hashes de linha). Corrigida no laboratório a inicialização da função auxiliar `graphql_public.graphql`, obtida do destino; privilégios reaplicados. Isso ainda não é prova de login/UX da aplicação restaurada.
- Extrações A e B em `/opt/warm-migration/lote-20260914-{a,b}` na origem: **99 tabelas, 134.488 registros**, com escopo direto ou derivado de pais autorizados. Configurações secretas são omitidas e contabilizadas no manifesto; 18 tabelas globais/credenciais sem escopo aprovado não foram exportadas.
- Corte de inclusão por `created_at`, quando disponível: **2026-09-14T00:20:20.555Z**. **Não é snapshot transacional.** Entre A e B, uma conversa mudou `updated_at` e `last_customer_message_at`; demais hashes conferiram. Campos de último evento precisam ser reconciliados com mensagens do lote, e foram reconciliados na captura C descrita abaixo.
- Lote B copiado e carregado em schema privado do laboratório. **134.488 registros / 99 tabelas reconciliados**. A repetição depois da conclusão criou **zero registros**. `anon`, `authenticated` e `service_role` tiveram acesso negado ao staging. Isso não é teste da futura ACL das notas no inbox.
- Nenhum usuário de origem foi criado/ativado em Auth. Os 9 perfis foram preservados no arquivo histórico e no mapa de revisão, sem ativar acesso.

## Decisões durante o ensaio

- **Confirmado:** unificar os 13 pares de conversas de mesmo contato/canal, preservando mensagens e IDs de origem. O mapeamento deve admitir mais de um ID de origem por conversa destino.
- **Confirmado pelo proprietário após revisão:** os dois contatos ativos com o mesmo telefone são a mesma pessoa; unificar os cadastros preservando IDs e históricos. Comparação privada criada em `.local-validation/migration/execution/revisao-contatos.html`; não versionar esse arquivo.
- Os 5 negócios somam **1.300.000 centavos em USD** no lote (US$ 13.000).

## Atualização do lote e mídia

- Captura C concluída com corte **2026-09-14T13:38:43.149Z**. Foram acrescentadas 4 mensagens, 3 tarefas e registros auxiliares. Alterações de cadastro/status foram conciliadas por ID.
- A união preserva também 1.895 eventos de canal e 144 execuções de acompanhamento que estavam na captura inicial e não apareceram na final. Não se presume a causa da ausência; eles continuam como histórico, sem reexecução.
- Conversão final: **3.089 contatos, 3.239 conversas, 60.448 mensagens, 1.610 tarefas, 108 notas, 30 compromissos e 5 negócios (US$ 13.000)**. O arquivo contém **134.982 registros** e **92.026 vínculos de contato** para consulta/privacidade.
- **9.797 referências** de arquivos/anexos: **9.169 recuperadas, 628 indisponíveis**. As três mídias do delta foram recuperadas. Indisponibilidade é mostrada na interface; não há arquivo vazio substituindo o original.
- A cópia inicial e sua recuperação tiveram 7.394 binários únicos conferidos por SHA256 no destino, sem divergência; três referências novas foram copiadas separadamente para o lote final. A conferência de ponta a ponta no Storage é gate obrigatório do importador definitivo.

## Validação executada

- Ensaio nativo da captura inicial e do arquivo: FKs mantidas, contagens reconciliadas, rollback e ausência de novos eventos/jobs/usuários. Inclui tarefas, agenda, notas de gestores e mensagens com status desconhecido.
- Schema final: **65 testes de banco aprovados**, incluindo INSTALL/UPDATE, isolamento, vocabulário e acesso restrito ao arquivo. Baseline consolidado com uma única reconstrução dos CHECKs de canal e varredura de funções ao final.
- Unificação/extrator: testes integrados ao Vitest; controle negativo com a unificação desativada reprovou como esperado.
- Node 22: 792 arquivos passaram na rodada completa; os problemas nos 5 restantes foram corrigidos e os 10 arquivos afetados passaram na repetição (**75 testes**). A rodada inicial com Node 26 e sandbox restrito não é tratada como evidência válida da versão suportada.
- Tipos e lint sem erros. Validação visual local aprovada: Inbox, anexo disponível/indisponível, download autenticado, tarefa ligada à conversa e tentativa direta de envio recusada com 409, sem criar mensagem. Screenshots privados em `test-results/importacao-historica-*/`.
- Build de produção local aprovado com Webpack; Turbopack encontrou restrição de portas no ambiente local. As três imagens amd64 da VPS foram construídas no escape de validação já adotado para esta instalação.

## Execução definitiva

- Publicada a versão `20260914-imports-59e55266` em `https://crm.dealercrm.io`, com app, worker e scheduler saudáveis.
- Backup imediatamente anterior: `/opt/deskcomm-crm/backups/db-20260914T140547Z.dump`.
- Migrations 0242–0244 aplicadas antes da carga; aplicativo e consumidores parados durante a transação. Origem mantida em funcionamento.
- Artefato final SHA256: `63fdbb8e99d356261ad91314d886f29edce93889b581d915b0968b468a4a705a`. Ensaio e produção utilizaram o mesmo artefato.
- **7.927 objetos** no Storage privado conferidos por download, tamanho e SHA256; zero divergências. Os caminhos separados por contato permitem exclusão conforme o titular.
- Transação confirmada com contagens, FKs, USD e ausência de novos eventos/jobs/usuários. Repetição definitiva criou **zero registros**.
- Consulta após a publicação confirmou um único cadastro com ambos os IDs aprovados, 3.089 contatos, 3.239 conversas, 60.448 mensagens, 1.610 tarefas, 30 compromissos, 108 notas, 5 negócios e apenas 1 membro ativo da instalação.
- Os 7 canais importados estão `historical/STOPPED`; os contatos têm atendimento humano obrigatório. Não houve conexão/cutover dos canais nem disparo de respostas históricas.
- Login, detalhe do contato, histórico individual, arquivo importado e tarefas abriram em produção. Downloads de anexo e arquivo retornaram 200; requisição anônima foi recusada com 401.
- A primeira conferência visual revelou timeout na lista/contadores. Estatísticas atualizadas com ANALYZE e migration 0245 aplicada: o wrapper do comando mantém a regra canônica e RLS invoker, consulta os dois flags do contato juntos e dispensa essa consulta quando o estado da conversa já decide. No mesmo lote, a contagem caiu de 8.133 ms para 407 ms no ensaio SQL. Mais 61 testes de banco e 20 testes de governança aprovados. JIT desativado para as conexões PostgREST (`authenticator`); timeout autenticado preservado em 8 s. A validação final também exige o contador de 3.239 conversas e ausência de avisos de erro, além de respostas HTTP corretas.

A captura não é um snapshot transacional. O corte final é 14/09/2026 às 13:38:43 UTC (09:38:43 em Nova York). Mudanças posteriores permanecem no Warm; sincronização contínua/cutover é uma etapa separada. As 628 referências sem binário recuperável continuam identificadas como indisponíveis.

A release de aplicação mantém o snapshot `59e55266`; o pacote SQL recebeu o complemento versionado 0245 (migration, baseline e MANIFEST). Nenhuma imagem de runtime precisou mudar para essa otimização de consulta.

## Resultado final da navegação

Validação real com administrador aprovada após 0245 e JIT desativado na API: Inbox com contador **3.239** e sem aviso de erro, contato unificado, arquivo histórico e tarefas. Todas as páginas retornaram 200; downloads autenticados de anexo e arquivo retornaram 200; acesso anônimo ao arquivo retornou 401. Nenhuma requisição de API falhou nessa rodada. Screenshots privados inspecionados. Typecheck, lint do teste alterado e `git diff --check` sem erros.
