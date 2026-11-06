# Integração AmigoAPI no Deskcomm

Estado: desenho para revisão; implementação ainda não iniciada.
Data: 06/11/2026. Base analisada: `3f16949cabb69222da9356b2a453d5eb67d9b0f1`.

## Objetivo e decisões confirmadas

O usuário pediu integração dos recursos documentados do AmigoAPI, com uma área própria na aplicação para cadastrar o token e configurar o uso. Confirmou expressamente: **Amigo como agenda principal** quando esse modo estiver ativo. A instalação continua sendo de uma única clínica, com credenciais e dados próprios; as APIs podem ser configuradas posteriormente.

O atendimento humano e a IA precisam consultar o mesmo catálogo, as mesmas vagas e os mesmos compromissos. Marcar, confirmar, cancelar ou remarcar deve produzir efeito no Amigo antes de o Deskcomm anunciar sucesso. Uma resposta incerta do provedor nunca vira confirmação ao paciente.

Fonte: [documentação oficial](https://amigobot-api.amigoapp.com.br/api-docs/), especificação OpenAPI 3.1.0, AmigoAPI 1.2.0, obtida do `swagger-ui-init.js` da mesma origem. São 22 operações em 20 caminhos. A cobertura e as particularidades estão em `docs/research/2026-11-06-amigo-api.md`.

## Abordagens

1. **Amigo como fonte da agenda, com projeção local controlada — escolhida pelo usuário.** A disponibilidade e as operações consultam o provedor; os identificadores externos são vinculados ao CRM. Uma projeção mínima permite manter histórico, funil e lembretes existentes sem criar outra marcação no provedor.
2. Importar horários e continuar marcando pela agenda local. Evita parte das mudanças no início, mas cria duas autoridades e pode oferecer vagas inexistentes. Incompatível com a escolha confirmada.
3. Painel isolado com chamadas ao Amigo. Facilita implementar apenas formulários, mas deixa a IA, o CRM e a agenda usando fontes diferentes. Não atende ao pedido de integração completa.

O produto permanece em Next.js/TypeScript/Supabase. Não haverá backend paralelo em outra linguagem.

## Área de configuração

Proposta de navegação: **Amigo API**, com entrada visível na navegação para administradores e caminho `/app/integrations/amigo`. O grupo será o de integrações/canais já existente, sem criar um segundo catálogo de navegação. A Agenda terá um vínculo para essa configuração.

O administrador poderá:

- Informar ou substituir o token em campo de senha; o valor completo não será devolvido depois de salvo.
- Testar o acesso por uma consulta somente de leitura a unidades, sem criar paciente ou consulta.
- Ver se há token cadastrado, quando foi validado, quais unidades estão disponíveis e o último erro traduzido.
- Escolher a unidade padrão entre as retornadas, conferir o fuso IANA da clínica e ativar o modo Amigo.
- Configurar a oferta no mesmo dia e o horizonte de 3 ou 6 meses, respeitando as capacidades documentadas. Quando não configuradas, essas opções são omitidas para preservar a regra da clínica no Amigo.
- Desativar a integração e remover a credencial local. Isso não cancela agendamentos nem revoga o token no Amigo.

Salvar credencial e ativar agenda são ações distintas. A integração só será ativada depois de token validado, unidade escolhida e fuso confirmado. Enquanto não configurada, a aplicação abre normalmente e explica o que falta. Não será exigida edição de `.env` para cadastrar o token.

A URL do provedor é fixa: `https://amigobot-api.amigoapp.com.br`. Não haverá campo para URLs arbitrárias. Uma ligação de teste é necessária para validar o token; o navegador fala somente com o backend do Deskcomm.

## Recursos na operação

### Pacientes e contatos

Busca por CPF ou telefone, consulta por ID, criação e atualização de pacientes, histórico de médicos e consulta de aniversariantes de hoje/amanhã ficarão disponíveis no painel Amigo. Na ficha do contato e no contexto de atendimento haverá vínculo com o paciente escolhido e acesso aos compromissos dele.

Um telefone não é identidade exclusiva de um paciente: responsáveis podem compartilhar número com dependentes. A busca que retornar mais de um exige escolha explícita, pelo humano ou em conversa com o paciente. Não selecionar o primeiro resultado automaticamente, não fundir pacientes pelo telefone e não criar outro contato para cada resultado.

Os vínculos são escopados por organização, conexão e paciente externo. A escolha de quem receberá o atendimento pertence à operação/conversa; não pode mudar silenciosamente o paciente de outro agendamento. Nenhuma criação automática só por abrir uma tela. Dados mascarados não substituem CPF/e-mail íntegros já existentes no CRM.

O formulário de cadastro cobre os campos realmente documentados. A data de nascimento não faz parte do schema de escrita de `Patient`, embora apareça como filtro de disponibilidade: não será enviada como campo de cadastro inventado.

### Catálogos

Unidades, médicos, especialidades, tipos de atendimento, grupos de convênios, convênios e produtos serão carregados do Amigo. Filtros preservam as relações entre unidade, profissional, atendimento e convênio. Produto deve corresponder ao convênio selecionado.

Médicos externos não precisam se tornar usuários autenticados do Deskcomm. Haverá identidade externa própria e vínculo opcional com um profissional do CRM. Não inventar duração a partir do catálogo de tipos: usar os horários efetivamente retornados e a duração do atendimento confirmado.

### Agenda

Em modo Amigo, a tela da Agenda apresenta consultas do Amigo com filtros de período, unidade e profissional. A disponibilidade vem de `/calendar` e das datas/horários por médico, conforme a consulta. O formulário permite selecionar paciente, unidade, atendimento, profissional e convênio/produto e depois uma vaga real.

Criar usa `POST /attendances`; remarcar usa `PUT /attendances/{id}/reschedule`, mantendo o ID. Cancelar e confirmar usam os endpoints específicos. Registrar chegada é ação humana, separada da confirmação de que a pessoa pretende comparecer.

Atendimento por ordem de chegada aparece como turno/intervalo, não como promessa de hora exata. Slots retornados são preservados com sua origem e filtros. Não recalcular vagas com a jornada local nem descontar manualmente a agenda Google nesse modo.

Ao alternar o modo, os compromissos locais existentes continuam consultáveis como histórico identificado por origem; não são migrados, cancelados nem reenviados ao Amigo. As marcações externas não disparam criação automática no Google. A vitrine pública da agenda e rotas legadas também precisam respeitar o modo: sem suporte equivalente para selecionar paciente/unidade, devem explicar o caminho de atendimento e não oferecer marcação local para um serviço do Amigo.

Proposta de transição: compromissos locais futuros já existentes mantêm suas operações e lembretes pela origem original, com identificação clara. A escolha do modo determina novas marcações; editar um compromisso existente resolve primeiro sua própria autoridade. Assim uma troca de configuração não abandona consultas que já estavam marcadas. Esta convivência de histórico não autoriza duas marcações para a mesma solicitação nem criação local como fallback de uma falha Amigo.

### Integração com CRM, lembretes e IA

As operações são serviços de domínio compartilhados pelo painel, pelas rotas e pelas ferramentas MCP. Preservar os nomes existentes de agenda quando sua semântica corresponder e adaptar seus inputs para seleção dos recursos externos; ferramentas adicionais cobrem pacientes, catálogos e histórico. Não oferecer uma ferramenta genérica de URL/HTTP à IA.

A IA recebe dados de negócio e resultados sanitizados, nunca o token, ciphertext ou cabeçalhos de autenticação. Ela só altera o paciente/agendamento resolvido no escopo daquela clínica e conversa; identificadores fornecidos pelo modelo são revalidados. Listas de aniversariantes e exploração global de pacientes são ações humanas com permissão de gestão, não ferramentas livres do atendente de um paciente.

A projeção local alimenta a timeline do contato, o estado de agendamento do lead e os lembretes existentes. A vinculação é única por conexão + ID externo; importação repetida atualiza a mesma projeção. Agenda, IA e lembretes respeitam cancelamentos e remarcações vindos do Amigo. Cancelado não vira perda comercial automática; atendimento com horário passado não vira comparecimento.

Preservar também os contratos de prova da IA: `lib/ai/runtime/recibos-de-agendamento.ts` relê o compromisso local e `escopo-das-escritas.ts` confere quem pode alterá-lo. O ID retornado para esses consumidores precisa apontar à projeção única do atendimento remoto, sem perder o `attendance_id` do provedor. Um sucesso somente em uma ferramenta nova não basta para o agente existente confirmar a marcação.

Guardar `remote_status` sem perda e exibi-lo como estado do Amigo. A adaptação aos cinco estados locais não pode confundir uma consulta agendada com uma reserva local que aguarda aprovação. Em especial, o cron `agenda-expira-pendentes` e qualquer limpeza equivalente devem excluir compromissos de autoridade Amigo: só uma resposta remota ou ação autorizada muda seu estado operacional.

Proposta para evitar lembretes duplicados entre os dois produtos: o envio pelo Deskcomm fica desativado inicialmente para consultas Amigo e tem opção explícita na configuração. Ao habilitar, o administrador recebe orientação para conferir a configuração de lembretes no Amigo; a API publicada não informa se o outro produto já enviou uma mensagem. Ainda assim, o Deskcomm deduplica seus próprios envios e verifica o estado remoto antes de enviar.

Propostas detalhadas para importação e automações, estabelecidas na revisão do desenho:

- Consulta criada fora do Deskcomm aparece na Agenda mesmo sem contato/negócio local, com identificação de origem. Não cria automaticamente um contato ou negócio. Até haver vínculo explícito, não envia lembrete nem atualiza funil; fica com a ação visível de vincular.
- O vínculo escolhe o paciente externo, o contato destinatário e, se houver mais de um negócio, o negócio correto. Dependente e responsável continuam separados. A IA só usa o vínculo confirmado no contexto do atendimento, sem resolver por um telefone compartilhado.
- A primeira importação apenas estabelece o estado inicial e registra a sincronização. Não reproduz eventos históricos de marcação, não envia avisos em massa e não executa automações retroativas. Um vínculo posterior não dispara automaticamente campanhas/avisos antigos.
- Lembretes usam associação explícita do atendimento externo com um tipo local para configurar antecedência, modelo e canal já existentes. A associação serve à apresentação e aos avisos, não cria reserva/jornada local. Sem associação e destinatário válidos, o lembrete é inelegível e a tela informa o que falta. Os padrões de duração local não substituem o slot retornado pelo Amigo.

O envio continua passando pelo canal de WhatsApp e suas regras já existentes; configurar o Amigo não conecta WhatsApp nem configura um provedor de IA. Nenhum envio real ou ação em paciente real será feito para testar sem autorização específica.

## Limites do contrato do Amigo

- Consulta de atendimentos lê estados que a API não permite escrever: a atualização documentada só aceita cancelamento, chegada e confirmação. Conclusão, falta e início de atendimento são apenas refletidos quando vierem do Amigo; não serão apresentados como graváveis por esta integração.
- Não há endpoints documentados de prontuário, prescrição, faturamento, preços, renovação/revogação do token, exportação geral de pacientes, webhook ou idempotência. A integração não inventará esses recursos.
- Listagem geral de atendimentos exige datas; o filtro de status será explicitamente `ALL` quando se pretender a agenda completa, pois omiti-lo não significa todos.
- Formatos diferem entre rotas: instantes UTC, datas civis, datas `DD/MM/YYYY` e data/hora sem offset. A conversão usa o fuso configurado e preserva o horário civil escolhido, sem confiar em exemplos contraditórios de exibição.
- O schema oficial tem trechos genéricos e campos opcionais; respostas precisam de validação e normalização próprias. Falha de contrato gera erro visível, não lista vazia ou sucesso presumido.

## Segurança e persistência

Destino arquitetural proposto: **ambos** — despacho genérico de autoridade da agenda no núcleo, com o Amigo como consumidor real, e integração Amigo opcional como capacidade de nicho. A operação normal continua útil sem ela; ativá-la é decisão da clínica. A implementação nativa deve respeitar os limites atuais do framework de extensões: não fingir que um pacote declarativo executa HTTP, nem criar um SDK/marketplace para viabilizar este pedido. Não adicionar dependência obrigatória ou infraestrutura externa nova. A classificação precisa constar no fragmento de mudança e no mapa da arquitetura.

Credencial cifrada no servidor, em tabela separada de metadados e sem `SELECT` para usuários comuns/anon. Reutilizar a infraestrutura de criptografia existente mediante validação da chave disponível; se não houver chave de instalação válida, recusar armazenamento e mostrar a correção necessária, sem fallback em texto puro. Metadados seguros não carregam o ciphertext.

Todo registro tem organização, escopo e controle no banco. Escrita da configuração é somente admin; operação de agenda respeita os papéis existentes de atendimento; leitura administrativa/global de pacientes é gestão. O token de MCP nunca concede configuração de credenciais. A autorização ocorre antes da leitura do segredo ou chamada externa. A service role fica confinada ao gateway de credenciais e aos processos explicitamente privilegiados, não substitui o guard de usuário.

Migração versionada idempotente, manifesto e apêndice no baseline, com testes de isolamento para duas clínicas. Estruturas previstas: conexão/metadados, credencial privada, vínculos de pacientes/catálogos/compromissos, recibos de operação e estado de sincronização. Dados específicos do módulo seguem a regra de provisionamento opcional da ADR-0002: o baseline entrega a função provisionadora fixa; a ativação/instalação autorizada prepara suas tabelas, em vez de criá-las para toda instalação sem uso. O estado sem módulo provisionado é tratado normalmente pela tela e pelo despacho. A escolha final de nomes e índices é de implementação. IDs externos numéricos não são confundidos com UUIDs locais.

Cada conexão tem identidade própria. Substituir um token exige nova validação; se for outra conta/empresa, iniciar uma conexão distinta e preservar os vínculos antigos como histórico. A documentação não oferece identificação confiável do titular do token por um endpoint próprio: não assumir que dois tokens pertencem à mesma conta. A confirmação da clínica/unidade na ativação é explícita.

Auditoria e atividades registram ator, tipo de ação, IDs técnicos necessários, horário, resultado e origem. Não registram token, CPF, corpo de paciente, telefone ou resposta clínica integral. Cache de dados pessoais e respostas autenticadas não é público. Mensagens de falha não refletem corpos externos sem sanitização.

## Consistência, falhas e sincronização

Chamadas possuem timeout, limite de resposta, controle de concorrência e erros diferenciados: não configurado, token inválido, permissão, validação, indisponibilidade, resposta inválida e resultado incerto. Respeitar `Retry-After` quando enviado. GETs podem ter retentativa limitada; mutações não serão repetidas automaticamente depois de timeout, desconexão ou resultado sem confirmação.

Uma operação mutante recebe ID persistente e reserva antes do efeito. Repetir a mesma solicitação devolve seu estado/recibo, sem nova chamada; chamadas concorrentes para o mesmo compromisso são serializadas. O helper genérico atual de idempotência não basta, pois libera reservas em falha e vence em 60 segundos: um resultado externo incerto precisa continuar bloqueado até reconciliação.

Estados de operação: preparada, enviada, confirmada, recusada e incerta. Não há promessa de transação distribuída ou garantia de execução única no Amigo. A aplicação só mostra sucesso após resposta válida com resultado esperado; em falha de persistência depois de sucesso remoto, mantém o caso para reconciliação e impede reenvio cego.

Uma marcação incerta será conferida na listagem por paciente, horário, unidade, profissional e evento. Correspondência insuficiente ou múltipla vai para revisão humana; não escolher arbitrariamente. Antes de mutações sobre um compromisso, confirmar também o vínculo de paciente e origem. Revalidar o slot não substitui a validação final feita pelo Amigo.

Sem webhook documentado, um worker consulta períodos delimitados. Proposta operacional: sincronização ao abrir/atualizar a Agenda e cron a cada cinco minutos, com janelas limitadas, pausa em token inválido e exibição do último sucesso. Janela proposta: últimos 7 dias até os próximos 90, consultados em lotes; agendas antigas são lidas sob demanda por período. Esses números são decisões propostas de implementação, não limites do fornecedor.

Antes de enviar um lembrete sobre compromisso externo, verificar que sua situação e horário continuam válidos no Amigo; indisponibilidade impede o envio daquele lembrete e cria pendência visível. Usar deduplicação e cancelamento dos avisos antigos ao remarcar. Não repetir lembretes por atualizar uma projeção.

Na tela, operações incertas e falhas de sincronização oferecem próximo passo: conferir novamente, corrigir token ou resolver manualmente com o ID e contexto necessários. Uma falha não troca silenciosamente para a agenda local. Desconectar para novas operações não apaga histórico nem executa cancelamentos externos.

## Encaixe técnico previsto

- `lib/amigo/`: contrato, schemas Zod, transporte, credencial, catálogos e serviços de pacientes/agendamentos, normalização e reconciliação.
- `app/api/v1/integrations/amigo/`: configuração e operações autenticadas, usando wrappers, RBAC e guarda de suporte do repositório. Não funciona como proxy HTTP livre.
- `app/app/integrations/amigo/`: configuração e recursos administrativos, acessíveis pelo catálogo real de navegação.
- `lib/agenda/consulta.ts`, handlers de agendamento e `app/app/agenda/`: despacho pelo provedor ativo e apresentação do Amigo, sem duas regras de disponibilidade.
- `lib/agenda/google/candidates.ts` e a função SQL `fn_google_appointment`: excluir a autoridade Amigo nos dois pontos de seleção/publicação, incluindo a projeção criada para CRM/IA. Os CHECKs atuais de provedor e seus consumidores precisam ser migrados onde necessário; acrescentar uma constante TypeScript não muda o contrato SQL.
- `lib/mcp/tools/` e seu catálogo: mesmas decisões de domínio da tela, contexto de paciente e permissões.
- `lib/contacts/` e ficha/inbox: vínculo explícito, contexto por paciente e histórico mínimo.
- Worker/cron e `event_log`: sincronização e reconciliação; consumidores de lembretes e atividades recebem a origem e os IDs estáveis.
- `supabase/migrations/`, `baseline.sql`, tipos de banco, testes de invariantes, mapa em `docs/architecture/` e fragmento `.changes/` acompanham a capacidade nova.

## Provas de aceite

1. Instalação sem token continua utilizável; a área Amigo tem entrada visível e estado não configurado.
2. Admin cadastra/testa/substitui/remove credencial pela tela; respostas, HTML e logs não expõem o segredo. Outro papel não consegue configurar; outra clínica não acessa nem reutiliza o token/vínculos.
3. Os 22 contratos têm testes de requests e respostas reais do formato documentado, com fixtures fictícias, incluindo erro de validação, token inválido, 403/404/429/500, timeout e resposta malformada.
4. Fluxo completo de seleção: unidade → atendimento/convênio → profissional → paciente → data/vaga, respeitando dependências dos filtros, paciente ambíguo e atendimento por turno.
5. Painel e ferramentas da IA produzem resultados compatíveis na mesma seleção. Teste direto da ferramenta e jornada de agente com o mesmo texto, quando houver credencial de IA para a homologação.
6. Criar, confirmar, cancelar, chegada e remarcar alteram o Amigo e refletem corretamente no CRM. Teste de concorrência e replay não repete envio. Falha incerta permanece visível e sem confirmação falsa.
7. Mudança feita fora do Deskcomm aparece após atualização/sincronização. Cancelamento e remarcação não deixam lembrete antigo ou marcação Google duplicada.
8. Comparecimento/falta permanecem distintos de horário passado, confirmação e chegada; estados não graváveis não oferecem botão/ferramenta de gravação no Amigo.
9. Interface verificada em desktop amplo e viewport menor, além dos testes relevantes, typecheck/lint e gates de banco/navegação/migrations exigidos pelo projeto.

Sem token real, validar o código e as jornadas contra um servidor de contrato controlado com dados fictícios. A aprovação dessa simulação não será descrita como homologação com uma conta Amigo real. A homologação real posterior precisa ocorrer em conta de teste ou com autorização para mutações específicas.

## O que fica para a implementação

Divisão final de componentes e nomes SQL, índices, distribuição dos testes e detalhes visuais dentro do sistema existente. Não fica para adivinhar: fonte oficial da agenda, limites do contrato externo, proteção da credencial, autorização por clínica, identidade do paciente e comportamento de falha incerta.

Este pedido não inclui implementar Google Sheets, reformular todo o design do CRM, criar papéis clínicos novos ou ligar números WhatsApp. Ele inclui adaptar os consumidores existentes necessários ao funcionamento consistente do Amigo, sem transformar o painel de configuração em uma integração isolada.

## Revisão do desenho

Um revisor independente leu este desenho antes de sua apresentação. Pediu explicitação de quatro pontos: consultas externas sem vínculo, compromissos locais futuros na transição, efeitos da importação inicial e regras dos lembretes por atendimento. As propostas acima respondem aos quatro. São decisões propostas pelo implementador para revisão do usuário, não escolhas atribuídas ao usuário.
