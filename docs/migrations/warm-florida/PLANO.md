# Migração da FLORIDA AUTO CENTER — Warm → CRM

**Estado: validação e execução do ensaio em andamento. Carga operacional em produção ainda não realizada.**

## Escopo e decisões confirmadas

- Origem: `warm.dealercrm.io`, aplicação Warm Connect. Workspace `68e16519-dac1-4e28-8762-615528a71180`, projeto Supabase `vfmkwbrwnubbuffqlhal`.
- Destino: `crm.dealercrm.io`, organização `4939e89d-2f77-465e-97c5-5236cf07b57b`.
- **USD** para os valores dos negócios, confirmado pelo proprietário nesta sessão.
- **Unificar os 13 pares de conversas** do mesmo contato/canal, preservando mensagens e IDs de origem, confirmado pelo proprietário durante a execução.
- **Unificar os dois contatos com telefone compartilhado**, confirmado pelo proprietário após revisar a comparação privada; preservar ambos os IDs e históricos de origem.
- Preparar os **9 membros**, **sem ativar acesso**, confirmado pelo proprietário. Preservar o administrador já existente no destino.
- Migrar somente a empresa autorizada. Não restaurar o banco global do Warm sobre o banco do CRM.
- Acesso à origem somente por consultas GET/SELECT. Não desligar canais, alterar webhooks ou reenviar mensagens durante a preparação.
- O banco `nutrition-db-1`, na mesma VPS, NÃO é a origem desta empresa.

## Evidência já coletada

O [relatório de auditoria](audit.json) tem a data exata da medição, contagens, distribuições de estados e verificações de referências. A origem continua em operação: **estas contagens não são um snapshot transacional**.

| Conteúdo | Medido |
|---|---:|
| Contatos | 3.113 |
| Conversas | 3.254 (2.500 WhatsApp; 754 Instagram) |
| Mensagens | 60.444 (30.290 recebidas; 30.154 enviadas) |
| Tarefas | 1.606 (1.287 abertas; 319 concluídas) |
| Notas | 108, sendo 3 restritas a gestores |
| Registros de arquivos | 1.084, somando 1.238.966.803 bytes declarados |
| Mensagens com anexos | 8.491 |
| Funis / etapas / negócios | 1 / 6 / 5 |
| Agenda | 30 compromissos |
| Membros / canais | 9 / 6 |
| Identidades de contatos | 2.476 |
| Evidências de consentimento | 83 |

Os arquivos vinculados a mensagens podem se sobrepor aos 1.084 registros: não somar essas quantidades como se fossem arquivos distintos. O tamanho total dos binários ainda não foi medido por download.

Destino consultado nesta preparação: uma organização, **0 contatos, 0 conversas, 0 mensagens e 0 negócios**. Recontar imediatamente antes do ensaio/corte: não presumir que continuará vazio.

### Achados que precisam ser tratados

1. Nenhuma referência quebrada nas relações verificadas pelo auditor (ver lista exata no JSON). Isso não prova todas as relações do sistema.
2. 23 contatos mesclados e 23 excluídos logicamente. Esses totais podem se sobrepor; preservar os registros e os vínculos de mesclagem sem reativá-los.
3. Um grupo de contatos ativos compartilha telefone normalizado. Não mesclar por nome ou telefone automaticamente; produzir relatório privado desse grupo no ensaio e decidir sua identidade.
4. Uma conversa não tem `channel_id`; 9 mensagens também não. Nas mensagens, herdar o canal da conversa somente quando a relação for inequívoca. A conversa sem canal fica bloqueada para conversão até ser identificada.
5. 27.645 mensagens têm `delivery_status` nulo. Não inventar confirmação de envio/leitura. O destino exige um status: definir a representação histórica antes do importador final.
6. As 3 notas `managers_only` não podem virar notas comuns. Comprovar ACL equivalente pela UI/RLS ou manter essa parte fora da carga operacional, com arquivo restrito e pendência visível. Isso impede declarar migração integral concluída.
7. Os 83 consentimentos usam base `art7_v_contract`. Isso não significa consentimento de marketing. Preservar base, datas, evidência, revogação e expiração; não marcar marketing como autorizado.
8. Os canais usam `waha` e `meta` na origem. O Instagram não pode ser tratado como uma subconta do HUB já conectada apenas por existir na origem. Credenciais e autorizações têm fluxo separado.
9. Membros: 6 ativos, 1 suspenso, 2 inativos. Nenhum foi automaticamente associado ao administrador do destino pela comparação de e-mail disponível. Não inferir identidade por nome, nem reativar suspensos/inativos.
10. Tarefas da origem também apontam para conversas; a tabela destino tem vínculo com contato/negócio, mas não essa coluna. Preservar essa aresta requer adaptação e teste da navegação.
11. Há históricos de IA, eventos de canal, atribuições e outros registros além do núcleo. O [mapa completo](table-map.csv) identifica tabelas sem adaptador confirmado; mantê-las como pendência, nunca descartá-las silenciosamente.

## Mapeamento proposto

**PROPOSTO** significa que exige implementação e ensaio; nomes semelhantes não provam equivalência.

| Origem | Destino proposto / regra |
|---|---|
| workspaces | organização existente; não criar outra empresa em produção |
| contacts | contacts; preservar identificação, origem e datas; dados inválidos vão para relatório de exceção |
| contact_identities | metadados de origem + identidade de destinatário na conversa social; adaptar sem transformar identificador opaco em telefone |
| pipelines / pipeline_stages | crm_pipelines / crm_stages, mantendo ordem; 6 etapas estão marcadas `open` na origem, portanto não inferir ganho/perda pelo nome |
| deals | crm_leads; `value` → centavos exatos em USD; ligações em crm_lead_links; manter campos sem equivalente no registro de origem |
| crm_conversations | conversations; responsáveis mapeados, datas históricas, canal real identificado; bot pausado e sem RAG |
| crm_messages | messages; preservar ordem, IDs externos, direção, conteúdo, traduções e anexos; não inserir pelo endpoint de envio |
| crm_tasks | crm_tasks; proposta `open` → `pending`, `done` → `done`; preservar vencimento original, inclusive atrasado; adaptar vínculo com conversa |
| crm_notes | timeline/notas, preservando autoria e visibilidade; ACL de gestores é gate obrigatório |
| crm_files + attachments | Storage privado e referências reescritas; manter nome/MIME/tamanho/hash; não depender de URL assinada que vai expirar |
| appointments | calendar_appointments; manter horário absoluto e status; não gerar lembretes antigos |
| crm_contact_consents | evidências legais e revogações; contrato não se converte em marketing |
| workspace_members / roles | mapa de identidade e matriz de permissões; sem senha copiada, sem convite enviado e sem acesso ativado |
| crm_channels / whatsapp_sessions | cadastro histórico com canais parados; sem QR, token, proxy_password ou sessão ativa reaproveitados |
| históricos de estágio, atribuição, estados e eventos | timeline histórica ou arquivo consultável segregado; adaptadores e ACL ainda a implementar |
| configurações de IA, automação e modelos | rascunhos revisados; sem publicação, agendamento ou execução automática |
| faturamento, tokens, sessões e permissões globais | não ativar/copiar como credencial do destino; revisar preservação de evidências separadamente |

As tabelas sem `workspace_id` exigem seleção por pais comprovadamente pertencentes à empresa: por exemplo, tags de conversa pelos IDs de conversa; perfis pelos membros; lembretes pelos compromissos. Seguir a cadeia completa para mensagens internas e seus anexos. **Não fazer `select *` global nem unir por um identificador vindo de outra organização.**

## Kit preparado

Em `scripts/migrations/warm/`:

- `audit.mjs`: auditoria executada no banco real, apenas GET, saída agregada sem conteúdo pessoal.
- `core.mjs`: paginação restrita ao projeto/workspace; IDs determinísticos por organização destino+tabela+ID de origem; conversão monetária exata.
- `export-core.mjs`: **exportador parcial de preparação**, com projeções explícitas, arquivos privados, hashes SHA256 e manifesto. Não escreve no CRM. Configurações/JSON livres/anexos e demais tabelas não são exportados por ele; estão declarados no manifesto.
- `core.test.mjs`: testes de isolamento, paginação, mudança de contagem, duplicidades, dinheiro, erros e IDs estáveis.

O exportador foi conferido contra o catálogo real e testado nas primitivas de leitura com dados sintéticos. **Ainda não houve exportação integral, importador de escrita, cópia de anexos nem ensaio de UI.** Uma saída do exportador parcial não pode ser usada como backup completo ou como declaração de migração concluída.

Exemplo de uso no ambiente de origem, com arquivos do kit já disponíveis e diretório de saída novo, privado e fora do repositório:

```sh
node --env-file=/etc/warm-connect/api.env audit.mjs > audit.json
node --env-file=/etc/warm-connect/api.env export-core.mjs /opt/warm-migration/lote-preparacao-01
```

As chaves ficam no ambiente do processo e nunca no relatório. Não colocar exportações em Git, pasta pública do servidor, logs ou screenshots de suporte.

## Execução planejada, em ordem

1. **Completar o contrato.** Resolver os achados acima, campos sem equivalente e tabelas dependentes. Registrar cada campo como convertido, preservado ou excluído com motivo revisado. Toda extensão de schema precisa de migration + baseline + MANIFEST.
2. **Preparar ambiente de ensaio isolado.** Supabase separado, mesma versão da aplicação do destino, armazenamento próprio e sem acesso de saída aos provedores. Não reutilizar banco, volumes ou credenciais de canais de produção. Worker/scheduler e crons externos desligados. Só a equipe de validação acessa a cópia.
3. **Extrair o lote completo.** Preferir conexão Postgres de leitura e snapshot `REPEATABLE READ`, incluindo relações dependentes e objetos de Storage. O acesso atual usa PostgREST e não oferece snapshot entre tabelas. Na ausência da conexão SQL, combinar janela de estabilização da origem e verificação de duas extrações completas com hashes; não chamar uma paginação comum de snapshot consistente.
4. **Validar e transformar offline.** Recusar registros de outro tenant, IDs duplicados, FKs não resolvidas, moedas desconhecidas e perda de precisão. Preservar fonte integral autorizada em arquivo restrito; relatórios operacionais só contagens e IDs de exceção. Criar mapa persistido origem→destino e journal do lote.
5. **Importar no ensaio.** Ordem: identidades sem acesso → contatos/mesclagens → funil/etapas → canais históricos parados → conversas → mensagens/mídias → negócios/ligações → notas/tarefas/agenda/consentimentos → históricos. Dados brutos ficam em staging privado, não exposto por PostgREST. Transformações transacionais e retomáveis por lote.
6. **Neutralizar efeitos históricos explicitamente.** `trg_messages_emit_event` e outros triggers de mensagens do destino podem gerar filas, revisões e ações. Canal STOPPED, sozinho, não garante silêncio. Implementar caminho de importação histórica que preserve FKs/RLS, sem replays de webhook/dispatcher. Não usar `session_replication_role=replica` nem desligar triggers globalmente. Validar que não ficaram jobs pendentes para executar quando os workers forem ligados.
7. **Conferir banco e tela.** Matriz de aceite abaixo, testes de acesso por papel e segunda execução idempotente. Registrar exceções visíveis. Uma migração só é integral quando também inclui o histórico e os anexos autorizados, não apenas o núcleo.
8. **Preparar o corte revisável.** Apresentar contagens reconciliadas, exceções, mapa de canais/usuários e procedimento de volta. Só então agendar a janela, capturar o delta final, pausar a escrita/automação de origem no escopo da empresa e transferir os canais autorizados. Não operar os mesmos canais ativamente nos dois CRMs.
9. **Ativar gradualmente.** Primeiro consulta histórica; depois atendimento humano; IA apenas após revisão dos prompts, credenciais, consentimentos e roteamento. Os 9 acessos permanecem desativados até revisão explícita.

Não há duração prometida nesta fase: 1,24 GB é apenas o tamanho declarado em uma tabela de arquivos. Download dos anexos, limites da origem e compatibilidade ainda não foram medidos.

## Critérios de aceite e reconciliação

- Para cada tabela: `origem = convertidos + preservados em arquivo consultável + exceções documentadas`; nenhuma diferença sem explicação. Exceção pendente impede dizer “todos os dados migrados”.
- Contagens por canal/direção/estado e intervalo temporal; hashes de conteúdo por lote; somas em USD e etapas dos 5 negócios.
- Todas as arestas contato↔conversa↔mensagem, contato↔negócio, tarefa↔conversa, agenda↔contato e responsável↔identidade preservadas.
- Anexos: download real, hash SHA256, tamanho, MIME, objeto privado, renderização e teste cross-tenant. URLs inválidas ficam em relatório; não trocar por anexo vazio.
- Notas restritas: gestor autorizado enxerga; atendente e outro tenant não enxergam. Membros suspensos/inativos não passam a entrar.
- Reexecutar o lote: zero duplicidades e nenhuma alteração em registros criados pelo usuário após a migração.
- Antes de ativar: zero envios externos, zero follow-ups/lembretes históricos habilitados, zero credenciais reaproveitadas sem validação.
- Navegação real: contatos, funil, inbox, mídia, notas, tarefas e agenda. Não basta consulta SQL ou HTTP 200.

## Reversão

- Backup do destino imediatamente antes do corte: banco, Storage, configuração e mapa de versão, protegido conforme procedimento da instalação. Fazer teste de restauração em ambiente isolado antes de depender dele.
- Journal inclui IDs criados, IDs preexistentes reutilizados, hashes, horários e valores anteriores de qualquer atualização. Evitar sobrescritas; não fazer `upsert` indiscriminado sobre contatos existentes.
- Antes de uso real: excluir somente artefatos do lote identificado e objetos correspondentes, na ordem reversa das dependências, ou restaurar snapshot validado.
- Depois de atendimento real no destino: não restaurar o banco inteiro sobre dados novos. Interromper novos envios, reconciliar o delta produzido no destino e planejar retorno dos canais, sem replays.
- Origem preservada para consulta; desativação/eliminação definitiva exige decisão posterior e política de retenção.

## Living System Checklist — preparação

Entrada: workspace confirmado e API de leitura da origem. Saída: auditoria, mapa de campos/tabelas e contrato de extração que alimentam o futuro importador. Registro: manifesto/hash e relatório sem PII. Superfície final prevista: inbox, funil, timeline, tarefas e agenda; arquivo histórico ainda precisa de superfície com ACL. Próximo passo: resolver os gates de compatibilidade antes do ensaio. Configuração: projeto/workspace fixados no kit e decisões neste plano. Continuidade IA/humano: somente histórica nesta fase; ativação separada. Laço de retorno: diferenças na reconciliação bloqueiam o lote e viram correção do mapeamento, não reenvio de mensagens. Nenhuma peça de runtime foi adicionada ao produto nesta preparação.
