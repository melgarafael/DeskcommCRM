# Defeitos achados ao escrever as aulas de "Ver tudo em CRM" e "Ver tudo em IA"

**Data:** 31/10/2026 · **Código conferido:** `f13d26f6b` (topo da `main` em 28/10/2026, 1.94.0 + 16 commits)

## Contexto

Estes achados saíram da produção das 23 aulas novas do curso, uma por tela dos hubs "Ver tudo em CRM" e "Ver tudo em IA". Cada tela teve dois agentes: um autor, que leu o código, explorou a tela numa instalação fresca (baseline + bootstrap-owner + base da Clínica Bem Viver, worker parado) e escreveu a aula; e um revisor independente, que tentou refutar cada frase contra o código. Os dois anotaram o que viram de errado no produto, sem consertar o produto. A lista abaixo é a do revisor, que confirmou ou descartou as anotações do autor e somou as próprias.

"Tela" quer dizer que o defeito apareceu na bancada (foto ou navegação). "Código" quer dizer que a causa foi lida no código e não foi reproduzida. Nenhum item foi consertado nesta rodada. As aulas foram escritas para não afirmar nada falso e não depender dos defeitos; quando um conserto mudar a tela, a aula correspondente precisa de recaptura, e o item avisa quando a aula cita o comportamento atual.

## Resumo por tela

| Tela | Alta | Média | Baixa |
|---|---:|---:|---:|
| Prospecção | 0 | 4 | 8 |
| Campanhas | 0 | 7 | 6 |
| Empresas | 0 | 7 | 7 |
| Pessoas | 0 | 2 | 6 |
| Planos de tarefa | 0 | 3 | 6 |
| Chamadas | 1 | 6 | 8 |
| Produtos | 1 | 3 | 3 |
| Importações | 0 | 6 | 9 |
| Propostas (CRM) | 0 | 3 | 9 |
| Comandas | 1 | 3 | 7 |
| Etapas do funil | 0 | 2 | 7 |
| Fluxos de atendimento | 0 | 2 | 7 |
| Roteadores | 0 | 2 | 6 |
| Credenciais | 0 | 1 | 5 |
| Provedores | 0 | 2 | 7 |
| Conhecimento | 0 | 4 | 3 |
| Memória | 0 | 1 | 7 |
| Skills | 0 | 1 | 5 |
| Alertas | 0 | 2 | 4 |
| Aviso no WhatsApp | 0 | 1 | 2 |
| Propostas (IA) | 0 | 2 | 5 |
| Execuções | 0 | 2 | 7 |
| Uso e orçamento | 0 | 2 | 7 |
| **Total** | **3** | **68** | **141** |

## Gravidade alta

**A1. Chamadas.** Quando a organização tem pelo menos um contato marcado como pessoal, toda chamada sem contato some do histórico. O filtro é `contact_id not in (...)`, e em SQL NULL NOT IN dá NULL, então a linha sai do resultado. O discador da tela só envia toNumber, nunca contactId, então toda ligação feita por "Nova ligação" fica com contact_id nulo e desaparece da lista. O mesmo filtro está no histórico de voz do WhatsApp.
- Onde: `app/api/v1/calls/route.ts:106-109; app/api/v1/voice/calls/history/route.ts:44-47; app/app/calls/_client.tsx:84-86; hooks/calls/useCallsQuery.ts:78-83`
- Evidência: lida no código, não reproduzida

**A2. Produtos.** Toda edição pela tela zera o estoque e liga o controle de estoque. O PATCH /api/v1/products/:id usa produtoCreateSchema.partial(), e no Zod 4 (4.6.7) o .partial() mantém os .default(). Conferido de novo nesta revisão: produtoPatchSchema.parse({preco_cents:2790, quantidade:50}) devolve {preco_cents, controla_estoque:true, quantidade:50, ativo:true}, e parse({ativo:false}) devolve {controla_estoque:true, quantidade:0, ativo:false}. Efeitos: 1) 'Desativar' e 'Reativar' zeram o estoque; 2) trocar só o preço de um serviço 'sem controle de estoque' o deixa '0 em estoque', e o atendente de IA passa a tratá-lo como em falta; 3) editar um produto desativado sem mexer em ativo o reativa sem aviso. O diff do formulário (lib/catalogo/edicao-do-produto.ts) não adianta, porque o servidor completa os campos que faltam.
- Onde: `lib/schemas/produtos.ts:122 (produtoPatchSchema = produtoCreateSchema.partial()), consumido em app/api/v1/products/[id]/route.ts:36`
- Evidência: vista na tela

**A3. Comandas.** Item lançado pela tela nunca gera comissão. O formulário da comanda não envia attendant_user_id, a rota grava null e fn_finalizar_comanda só cria comissão para itens com attendant_user_id não nulo. O faturar em lote também insere o item sem atendente. Com uma regra por serviço, o item mostra 'comissão X%', mas nenhuma comissão nasce ao finalizar; regras por pessoa nunca casam a partir da tela. Não há trigger que preencha o atendente (conferido em pg_trigger).
- Onde: `app/app/comandas/_client.tsx:352-357; app/api/v1/financeiro/comandas/[id]/itens/route.ts:93; fn_finalizar_comanda passo (2) (supabase/baseline.sql, corpo instalado pela provisionadora); app/api/v1/financeiro/comandas/faturar-lote/route.ts:137`
- Evidência: lida no código, não reproduzida

## Gravidade média

**M1. Prospecção.** Na largura de 1440 px, a tabela de '3. Acompanhar resultados' rola na horizontal. Medido de novo: scrollWidth 860 contra clientWidth 742. A coluna 'Conversa', que traz o link 'Abrir no Inbox', começa em x=1417, além da borda do cartão (1383), e fica escondida. Quando uma célula da coluna 'Auditoria' é rolada para a vista, a tabela inteira desloca ~16px e corta a coluna das caixas.
- Onde: `app/app/prospecting/_client.tsx:1593 (div overflow-x-auto) e :1620 (cabeçalho 'Conversa')`
- Evidência: vista na tela

**M2. Prospecção.** Os motivos que o servidor grava no candidato e na campanha são texto PT cru, exibido sem tradução: 'Sem telefone brasileiro válido.', 'Contato já existe no CRM; atendimento preservado.', 'Não selecionada pelo operador.' e campaign.error. O dicionário não tem entrada ES para eles, e a tela renderiza {c.error} e {campaign.error} direto. Na interface em espanhol, o motivo de 'No contactado' aparece em português. RAZAO_NAO_SELECIONADA também é comparada byte a byte, então não basta traduzir na gravação.
- Onde: `app/app/prospecting/_client.tsx:1670 e :858; lib/prospecting/store.ts:434, :448; lib/prospecting/schema.ts:136`
- Evidência: lida no código, não reproduzida

**M3. Prospecção.** A Prospecção só conhece três ofertas fixas ('Site profissional', 'Automação do atendimento (CRM)', 'Automações e integrações (N8N)'). O Score, a 'Estratégia de abordagem' e as objeções do modal sempre falam de venda de site ou automação. No modo 'Na primeira mensagem (recomendado)', o padrão de campanha nova, esse ângulo entra na instrução da IA (instrucaoDeAbordagemFria soma blocoDeEstrategiaParaAgente quando soCumprimenta é falso). Um negócio com outra oferta (clínica, imobiliária) recebe uma primeira mensagem com argumento de venda de site, e não há como declarar outra oferta.
- Onde: `app/app/prospecting/_client.tsx:1255-1260; lib/prospecting/estrategia-site.ts:467-523; lib/prospecting/worker.ts:327-349; lib/prospecting/previa-gerar.ts:96-108`
- Evidência: lida no código, não reproduzida

**M4. Prospecção.** No modo 'Atrasar para a 2ª mensagem', o preparo automático continua gerando uma prévia pela IA para cada empresa marcada, e isso consome crédito. Mas o envio descarta a prévia guardada nesse modo (montarDadosDeAbordagem recebe previa null). Quem escolhe esse modo paga por prévias que nunca são usadas no envio; preparo.ts não olha exit_offer.
- Onde: `lib/prospecting/preparo.ts:203-232; lib/prospecting/worker.ts:350-352`
- Evidência: lida no código, não reproduzida

**M5. Campanhas.** O cartão "Campanhas" aparece no hub do CRM para atendente e para leitura, mas a tela só mostra "Erro ao carregar as campanhas.". A entrada do catálogo não tem minRole, e todas as rotas /api/v1/campaigns, campaign-templates e campaign-suppressions exigem manager. Falta minRole: "manager" na entrada.
- Onde: `lib/navigation/catalogo.ts:244 (entrada sem minRole) x app/api/v1/campaigns/route.ts:42 (requireRole manager)`
- Evidência: vista na tela

**M6. Campanhas.** Em Configuração › "Padrões desta organização", os campos de ritmo (intervalo, máximo por dia e por hora, janela) são gravados em organizations.settings.campanhas, mas nada os lê. A tela promete "Toda campanha nova nasce com estes valores", porém o formulário Nova campanha começa com os campos vazios e o POST grava null. Só atribuicao_horas tem consumidor (lib/campanhas/resposta.ts).
- Onde: `app/app/campaigns/settings/_client.tsx:101; app/app/campaigns/new/_client.tsx:58-61; app/api/v1/campaigns/route.ts:156-160; lib/campanhas/configuracao.ts (lerConfiguracao só usado em resposta.ts)`
- Evidência: lida no código, não reproduzida

**M7. Campanhas.** A tela "Editar campanha" não tem os campos "Com negócio no funil" e "Na etapa" e regrava audience_filter inteiro só com etiquetas, dias sem falar e limite (o PATCH substitui, não mescla). Quem criou o rascunho com o critério de funil e etapa perde esse critério em silêncio ao salvar a edição. Se o funil era o único critério, o botão Salvar fica desabilitado. Também se perdem com_todas_tags, incluir_contatos, excluir_contatos e os demais.
- Onde: `app/app/campaigns/[id]/edit/_client.tsx:103-111 e :450 (audience_filter: filtro); app/api/v1/campaigns/[id]/route.ts (loop de campos substitui audience_filter)`
- Evidência: lida no código, não reproduzida

**M8. Campanhas.** {{saudacao}} sempre vira "Bom dia", "Boa tarde" ou "Boa noite" em português, sem olhar o idioma da organização. Numa instalação em espanhol, a mensagem da campanha chega com a saudação em português.
- Onde: `lib/campanhas/renderizador.ts:269-274 (saudacaoDaHora) e :63 (DESCRICAO_DA_VARIAVEL)`
- Evidência: lida no código, não reproduzida

**M9. Campanhas.** Uma campanha "Pronta para iniciar" não volta a rascunho pela tela. A página de edição manda "volte a campanha para rascunho", mas nenhum botão nem ação da API faz isso: no estado ready o detalhe só oferece Enviar teste, Iniciar envio, Cancelar campanha e Duplicar, embora a máquina de estados permita ready→draft. Para corrigir, a pessoa precisa cancelar e duplicar.
- Onde: `app/app/campaigns/[id]/edit/_client.tsx:149; app/app/campaigns/[id]/_client.tsx:90; lib/campanhas/maquina-de-estados.ts (ready: ["draft", ...])`
- Evidência: lida no código, não reproduzida

**M10. Campanhas.** "Textos salvos" diz "Copy que você reusa entre campanhas", mas nenhuma tela usa os textos: Nova campanha e Editar campanha não oferecem escolher um texto salvo. O único consumidor de /api/v1/campaign-templates é a própria tela de configuração.
- Onde: `app/app/campaigns/settings/_client.tsx:175; hooks/campanhas/useConfiguracao.ts:50 (useTextosSalvos só usado em settings)`
- Evidência: lida no código, não reproduzida

**M11. Campanhas.** Os selos "Pronta para iniciar" e "Montando a lista", que também são opções do filtro Situação, não têm entrada em espanhol no dicionário. A tela em ES mostra esses textos em português.
- Onde: `components/campanhas/EstadoDaCampanha.tsx:23-24; app/app/campaigns/_client.tsx (rotulo()); ausentes em lib/i18n/dicionario.ts`
- Evidência: lida no código, não reproduzida

**M12. Empresas.** Editar uma empresa e pôr nela o CNPJ de outra empresa da organização devolve 500 com a mensagem crua do Postgres ("duplicate key value violates unique constraint companies_org_normalized_cnpj_uidx"), e a janela "Editar empresa" mostra isso em vermelho. O PATCH não confere duplicidade como o POST confere (409 "Já existe empresa com este CNPJ."), e handleRouteError repassa error.message.
- Onde: `lib/crm-b2b/companies-handler.ts:176-190; lib/crm-b2b/route-helpers.ts:49-50; supabase/baseline.sql:41489 (índice único)`
- Evidência: lida no código, não reproduzida

**M13. Empresas.** O enriquecimento grava por cima de tudo o que a pessoa digitou ou corrigiu, sem aviso na tela: razão social, nome fantasia, endereço, e-mail e telefone. Quando a Receita não tem e-mail ou telefone, apaga os que existiam (vira null). Ao criar com CNPJ ele roda sozinho, então a revisão que a tela pede depois de "Consultar CNPJ" ("Revise antes de criar") é desfeita logo em seguida.
- Onde: `lib/crm-b2b/enrich.ts:90-101; lib/brasil-api/client.ts:166-186; lib/crm-b2b/companies-handler.ts:152-158`
- Evidência: lida no código, não reproduzida

**M14. Empresas.** A coluna "Situação" da lista mostra o valor cru e em inglês do estado da consulta ("pending", "processing", "failed", "completed") quando ainda não há situação da Receita. A linha "Enriquecimento" da ficha faz o mesmo. Nenhum dos dois passa por t(), então a tela em espanhol também mostra o termo em inglês.
- Onde: `app/app/companies/_client.tsx:234; app/app/companies/[id]/_client.tsx:215`
- Evidência: vista na tela

**M15. Empresas.** Uma exclusão recusada diz "Remova os vínculos antes", mas nenhuma tela nem rota remove o vínculo pessoa↔empresa. company-people/[id] só tem PATCH, people/[id] só tem GET e PATCH, e nenhuma tela chama company-people. Uma empresa com pessoas ligadas não pode mais ser excluída pelo produto.
- Onde: `lib/crm-b2b/companies-handler.ts:307; app/api/v1/company-people/[id]/route.ts:19; app/api/v1/people/[id]/route.ts:19,36`
- Evidência: vista na tela

**M16. Empresas.** O botão "Nova empresa" aparece para todos os papéis, mas criar exige gerente. Para atendente ou somente leitura, clicar em "Criar" mostra a mensagem técnica "Permissão insuficiente. Requer role >= manager.", que não é traduzida.
- Onde: `app/app/companies/_client.tsx:178; app/api/v1/companies/route.ts:45; lib/auth/require-role.ts:302`
- Evidência: vista na tela

**M17. Empresas.** O botão "Enriquecer CNPJ" aparece para todos os papéis, mas a rota exige gerente. enrich() ignora a resposta 403, então para atendente ou somente leitura o clique não faz nada e não diz por quê.
- Onde: `app/app/companies/[id]/_client.tsx:90-95 (botão em :171); app/api/v1/companies/[id]/enrich/route.ts:26`
- Evidência: lida no código, não reproduzida

**M18. Empresas.** Uma busca com vírgula (ex.: "Ribeiro, Matos") quebra o filtro or() do PostgREST, que é montado por interpolação, e a API responde 500. A tela não confere res.ok e mostra "Nenhuma empresa ainda.", o mesmo texto de um cadastro vazio. Uma busca sem resultado também mostra "Nenhuma empresa ainda.".
- Onde: `lib/crm-b2b/companies-handler.ts:53; app/app/companies/_client.tsx:73 e :218`
- Evidência: vista na tela

**M19. Pessoas.** Quando o cadastro de uma pessoa falha, nada avisa. Acontece com os papéis Atendente e Somente leitura (o POST exige gerente e responde 403) e com e-mail inválido (o zod recusa). create() só trata res.ok: a janela 'Nova pessoa' continua aberta, sem mensagem e sem gravar nada. O botão 'Nova pessoa' aparece para todos os papéis.
- Onde: `app/app/people/_client.tsx:63-79 (create, só trata res.ok na linha 71) + app/api/v1/people/route.ts:48 (requireRole manager)`
- Evidência: lida no código, não reproduzida

**M20. Pessoas.** Nenhuma tela mantém uma pessoa: não há botão para editar ou excluir, nem para ligá-la a uma empresa ou a um telefone. As rotas PATCH /api/v1/people/[id], /api/v1/company-people e /api/v1/contacts/[id]/person existem, mas nenhuma tela as chama (grep em app/components/hooks). A importação de planilha é o único caminho pela tela que cria vínculos, e ela sempre insere uma pessoa nova (o cache vale só dentro do lote). Importar alguém já cadastrado duplica a pessoa. O cartão do hub promete 'Decisores e contatos ligados a empresas, com vários telefones', o que a criação pela tela não entrega.
- Onde: `app/app/people/[id]/_client.tsx (sem ações); lib/crm-b2b/import-process.ts:279-306 (insert em people sem deduplicar no banco)`
- Evidência: lida no código, não reproduzida

**M21. Planos de tarefa.** A tela mostra "Novo plano", "Editar" e "Excluir" para todos os papéis, mas o PATCH exige gerente. O atendente preenche o formulário inteiro e só ao salvar recebe "Permissão insuficiente. Requer role >= manager.". A mensagem é jargão técnico, traz o papel em inglês e não passa por traduzir(), então sai igual em espanhol. Visto na tela com a conta da Ana (agent). A tela devia esconder ou desativar os botões abaixo de gerente, e a recusa devia vir em linguagem de usuário.
- Onde: `app/app/tasks/planos/_client.tsx:175-184 (Novo plano) e :237-249 (Editar/Excluir), sem checagem de papel; app/api/v1/settings/task-plans/route.ts:58 (requireRole manager); lib/auth/require-role.ts:302 (texto literal da recusa)`
- Evidência: vista na tela

**M22. Planos de tarefa.** O aviso de validação ("Escreva o título de todos os passos.", "Dê um nome ao plano.", prazo inválido) aparece acima do formulário, sem rolar a tela nem mover o foco. Num plano com 2 ou mais passos, o "Salvar plano" fica embaixo e o aviso fica fora da vista: parece que o botão não fez nada. Visto na tela com 3 passos: o alert está no DOM e fora do viewport.
- Onde: `app/app/tasks/planos/_client.tsx:114-138 (guardar só faz setErro) e :187-191 (alert acima do Editor)`
- Evidência: vista na tela

**M23. Planos de tarefa.** "Excluir" apaga o plano na hora, sem confirmação e sem desfazer. A aba Automações usa AlertDialog para excluir uma regra. As automações que usam o plano passam a pular a ação (plano_nao_encontrado) e nada avisa disso no momento da exclusão.
- Onde: `app/app/tasks/planos/_client.tsx:149-152 e :247; comparar com app/app/webhooks/_components/RulesTab.tsx:187`
- Evidência: vista na tela

**M24. Chamadas.** O atendente (papel agent) que abre /app/calls pelo endereço vê "Nenhuma chamada ainda." mesmo com ligações gravadas. O GET responde 403 e a tela trata o erro como lista vazia, sem nenhum aviso de falta de permissão. A página não tem guarda de papel, embora o cartão do hub seja minRole manager, e o botão "Nova ligação" aparece para ele, mas o POST também é recusado. Reconferi na tela com 6 linhas no banco.
- Onde: `app/app/calls/_client.tsx:137 e 188-194; app/api/v1/calls/route.ts:82; app/app/calls/page.tsx:5-7`
- Evidência: vista na tela

**M25. Chamadas.** A coluna "Quem é" e o título "Chamada com ..." mostram sempre o número cru (+5511987650003), nunca o nome do contato, mesmo quando a ligação está ligada a um contato cadastrado. O cliente espera um campo `contact` (identificador de ligações), mas o GET não seleciona nem devolve esse campo.
- Onde: `app/api/v1/calls/route.ts:40-41 e 116-133; app/app/calls/_client.tsx:66-72; hooks/calls/useCallsQuery.ts:33-34`
- Evidência: vista na tela

**M26. Chamadas.** O modo de atendimento e o agente de voz escolhidos para cada número em Conexões › Telefone não têm efeito. O worker de voz lê routing_mode, default_ai_agent_id e fallback_user_id do número e nunca os usa: toda ligação vai para a IA, com o primeiro agente de voz ativo da organização (limit 1, sem ordem). A opção "humano" e a troca de agente na tela não mudam nada.
- Onde: `components/connections/TelefoniaClient.tsx:164-201; workers/voice-agent/index.ts:234-268 e 375; lib/ai/agents.ts:68-77`
- Evidência: lida no código, não reproduzida

**M27. Chamadas.** O painel de chamada de voz do WhatsApp escuta todos os eventos de voice_calls da organização sem filtrar provider, e o histórico que ele consulta ao abrir a tela também não filtra. Uma ligação SIP de entrada em 'ringing' sem dono abre o IncomingCallBanner do WhatsApp (toque e botões de atender/recusar, que chamam as rotas do WhatsApp) para todo mundo. Com o defeito da linha 'Chamando' eterna, abaixo, o banner pode reaparecer a cada carregamento de página.
- Onde: `hooks/voice/useVoiceCallSession.ts:212-214, 365-375 e 442-450; components/voice/VoiceCallContext.tsx:40-41; app/api/v1/voice/calls/history/route.ts:36-40`
- Evidência: lida no código, não reproduzida

**M28. Chamadas.** Uma ligação SIP de entrada que cai antes de a IA conectar fica em "Chamando" para sempre. handleChannelDestroyed procura asterisk_channel_id = channel.id, mas na entrada a linha grava um UUID separado (audioSocketUuid), então o 'timeout' nunca é aplicado a ela. O mesmo vale quando não há agente de voz ativo ou a organização está parada: a entrada também fica em 'Chamando'.
- Onde: `workers/voice-agent/index.ts:501-511 (busca por channel.id) vs 182 e 193 (UUID separado na entrada); 369-380`
- Evidência: lida no código, não reproduzida

**M29. Chamadas.** Sem agente de voz ativo (ou com a organização parada), uma ligação de saída é atendida pela pessoa e desligada na hora sem ninguém falar, e o histórico a registra como "Não atendida". O worker encerra o socket antes de marcar 'connected', e o ChannelDestroyed, que acha a linha ainda 'ringing', grava timeout. O discador não confere o agente antes de ligar.
- Onde: `workers/voice-agent/index.ts:369-380 e 501-511; app/api/v1/calls/route.ts:202-218 (só confere o trunk)`
- Evidência: lida no código, não reproduzida

**M30. Produtos.** Reimportar uma planilha SEM coluna de estoque desliga o controle de estoque e zera a quantidade dos produtos que JÁ existiam. A comparação só com o preço é exatamente o gesto que a própria rota descreve como o uso real. O cabeçalho da rota promete 'O upsert grava só as colunas que a planilha carrega', mas base() sempre manda controla_estoque e quantidade. lerPlanilha('codigo,nome,preco\nNUT-WHEY,Whey,199') devolve controla_estoque:false e quantidade:0 para o NUT-WHEY, que tem 12 unidades. O agente passa a oferecer como sempre disponível um item que a loja contava.
- Onde: `lib/catalogo/planilha.ts:227 e :281 (controla_estoque: temColunaEstoque); app/api/v1/products/import/route.ts:215-216 (base() grava controla_estoque e quantidade também no grupo 'existentes')`
- Evidência: lida no código, não reproduzida

**M31. Produtos.** Na importação, uma coluna 'Descrição' vira o NOME do produto, porque 'descricao' e 'descrição' estão entre os apelidos de nome. Com as colunas 'nome' e 'descrição' juntas, vale a que vem primeiro: a outra é descartada em silêncio e não aparece em 'Não usei estas colunas:'. lerPlanilha('descricao,nome,preco\n...') gravou o texto da descrição como nome e como código. Uma planilha de loja com 'Descrição' antes de 'Nome' entra com todos os nomes errados.
- Onde: `lib/catalogo/planilha.ts:31 (COLUNAS.nome inclui 'descricao','descrição'); lib/catalogo/planilha.ts:195 (valor() devolve a primeira coluna mapeada para o campo)`
- Evidência: lida no código, não reproduzida

**M32. Produtos.** O texto de ajuda do campo 'Custo' promete um comportamento que não existe: 'Serve para o atendente saber até onde pode negociar.' Nenhum consumidor lê catalog_products.custo_cents: a busca do agente (crm_search_products) não seleciona o custo, o contexto do atendimento e as propostas também não. O comentário da coluna no baseline repete a promessa ('Existe para a regra de desconto do agente ter piso'). A frase aparece nas fotos da L2.
- Onde: `app/app/products/_client.tsx:483; lib/mcp/tools/comercio.ts:253; lib/agent-engine/agent/contexto-do-atendimento.ts:241-242; supabase/baseline.sql:17568 e 17681`
- Evidência: vista na tela

**M33. Importações.** Importar a mesma planilha de novo duplica as pessoas sem avisar, e também as empresas sem CNPJ. A pessoa é sempre inserida: o cache por nome só vale dentro do lote, e não há busca no banco. Na segunda vez, os telefones dessas pessoas viram conflito ('Telefone já vinculado a outra pessoa.'), porque o contato aponta para a pessoa criada da primeira vez.
- Onde: `lib/crm-b2b/import-process.ts:257-273 (empresa sem CNPJ, 'não dedupa no banco por nome') e lib/crm-b2b/import-process.ts:286-296 (insert em people sem procurar a existente)`
- Evidência: lida no código, não reproduzida

**M34. Importações.** A importação roda na hora, com o mapeamento de colunas adivinhado pelos apelidos exatos, sem prévia e sem desfazer. A API devolve suggested_mapping e headers, mas a tela ignora os dois e só mostra 'N ok'. Uma coluna com nome fora da lista (ex.: 'Telefone celular') é descartada em silêncio, e as pessoas entram sem telefone, contando como sucesso. Não há rota nem botão para desfazer um lote.
- Onde: `app/app/imports/_client.tsx:47-66 (ignora suggested_mapping/headers); app/api/v1/imports/route.ts:97-99 e :141-147; app/api/v1/imports/[id]/route.ts (só GET)`
- Evidência: lida no código, não reproduzida

**M35. Importações.** O detalhe do lote mostra no máximo 500 linhas, sem paginação, mas um lote pode ter 2.000. Numa planilha grande, as falhas e conflitos depois da linha 501 não aparecem em lugar nenhum da tela.
- Onde: `app/api/v1/imports/[id]/route.ts:45 (.limit(500)); lib/crm-b2b/spreadsheet.ts:24 (IMPORT_MAX_DATA_ROWS = 2_000)`
- Evidência: lida no código, não reproduzida

**M36. Importações.** O CNPJ alfanumérico da Receita é recusado como 'CNPJ inválido.' e a linha inteira falha. O próprio código registra a limitação: o check de companies.normalized_cnpj só aceita 14 dígitos.
- Onde: `lib/crm-b2b/normalize.ts:19-28; lib/crm-b2b/import-process.ts:195-197`
- Evidência: lida no código, não reproduzida

**M37. Importações.** O conflito não tem como ser resolvido pela tela. O detalhe do lote só lista o conflito. A ficha da pessoa mostra os telefones só para leitura, e nenhuma tela chama a rota PATCH /api/v1/contacts/:id/person, que já existe. A pessoa criada na linha em conflito fica sem o número.
- Onde: `app/app/imports/[id]/_client.tsx (sem ação por linha); app/app/people/[id]/_client.tsx:68-82 (telefones só leitura); app/api/v1/contacts/[id]/person/route.ts (sem consumidor na UI)`
- Evidência: vista na tela

**M38. Importações.** O detalhe do lote mostra valores internos em inglês, em PT e em ES: o status do lote ('completed'), o das linhas ('success', 'conflict', 'failed') e os cabeçalhos fixos 'Company', 'Person', 'Contact', que não passam por t(). Essas três colunas mostram os 8 primeiros caracteres do UUID, sem link nem nome.
- Onde: `app/app/imports/[id]/_client.tsx:46, :67-69, :76, :78-80`
- Evidência: vista na tela

**M39. Propostas (CRM).** No editor de uma proposta sem modelo confirmado, o quadro mostra "Usar este modelo" e a lista "Ou escolha outro modelo" para qualquer papel, sem olhar `podeRevisar` nem `emRascunho`. Uma Atendente vê e clica nos dois, mas PATCH /api/v1/proposals/[id]/modelo exige gerente e responde com erro. Na tela da Ana (atendente), os dois aparecem no rascunho da IA.
- Onde: `app/app/proposals/[id]/_components/DocumentoCanvas.tsx:273`
- Evidência: vista na tela

**M40. Propostas (CRM).** "Marcar como recusada" pede o motivo com window.prompt, e Cancelar não desiste da ação: o prompt devolve null, que vira undefined, e decidir("recusada") roda mesmo assim. Quem clica por engano e cancela registra a recusa do mesmo jeito. A lição avisa disso (registrar-a-resposta-do-paciente/p2); quem corrigir o defeito precisa ajustar esse texto.
- Onde: `app/app/proposals/[id]/_client.tsx:732`
- Evidência: lida no código, não reproduzida

**M41. Propostas (CRM).** Os botões de ação não olham o papel. "Enviar ao cliente" e "Descartar rascunho" aparecem em todo rascunho, e "Marcar como aceita/recusada" e "Revisar esta proposta" em toda proposta enviada; podeEditar só vale para os campos. As rotas send, DELETE e revise exigem gerente, e decide exige atendente. Resultado: Atendente e Somente leitura veem botões que dão erro depois do clique. Na tela da Ana (atendente) aparecem Enviar e Descartar.
- Onde: `app/app/proposals/[id]/_client.tsx:707`
- Evidência: vista na tela

**M42. Comandas.** Comanda aberta em 'Nova comanda' nunca se liga a um atendimento, e a linha de 'Atendimentos sem comanda' não oferece abrir comanda a partir dela. O atendimento sem preço só sai da lista se o serviço ganhar preço (o que vale para todos) ou se o compromisso mudar de status. Quem segue o caminho que o próprio comentário do componente sugere ('abrir a comanda à mão') cobra o atendimento, mas a linha continua na lista e pode ser faturada de novo depois que o serviço ganhar preço: cobrança em dobro.
- Onde: `app/app/comandas/_pendentes.tsx:13-16; app/app/comandas/_client.tsx:110; app/api/v1/financeiro/comandas/pendentes/route.ts:237-243`
- Evidência: lida no código, não reproduzida

**M43. Comandas.** A classe text-danger não tem token em app/globals.css (os tokens são error/destructive). Por isso o aviso 'Esta forma de pagamento ainda não tem conta de destino...' e o 'sem preço no serviço' aparecem na cor normal do texto, e não em vermelho. O mesmo vale para honorarios/_client.tsx:83 e faturamento/_client.tsx:220.
- Onde: `app/app/comandas/_client.tsx:502; app/app/comandas/_pendentes.tsx:125; app/app/comandas/_pendentes.tsx:173`
- Evidência: vista na tela

**M44. Comandas.** Faturar em lote não dá retorno: onSuccess só recarrega e ignora a resposta {faturados, pulados}. Com uma forma de pagamento sem conta, cada atendimento marcado vira uma comanda ABERTA (a finalização é recusada com forma_sem_conta e o lote só 'pula') e some da lista 'Atendimentos sem comanda' sem nenhum aviso.
- Onde: `app/app/comandas/_client.tsx:160-165; app/api/v1/financeiro/comandas/faturar-lote/route.ts:169-183`
- Evidência: vista na tela

**M45. Etapas do funil.** A contagem 'N negócios nesta etapa agora' fica velha depois de qualquer mudança na tela de etapas. useReler só invalida chaveDoFunil (o agent-mapping) e nunca invalida chaveDasTaxas (['stage-win-rates', id]). Além disso, o QueryClient usa staleTime de 30 s e refetchOnWindowFocus desligado. Visto na tela: depois de arquivar 'Lista de espera' e mandar os 2 negócios para 'Novo', a linha de 'Novo' continua dizendo '2 negócios nesta etapa agora' em vez de 4, até a página ser recarregada. O gestor vê um número errado logo depois da própria ação.
- Onde: `hooks/pipelines/useStages.ts:55-58 (useReler invalida só chaveDoFunil); hooks/pipelines/useWinRates.ts:72 (chaveDasTaxas, nunca invalidada); app/app/settings/tenant/pipelines/_stages.tsx:342; lib/query/client.ts:9`
- Evidência: vista na tela

**M46. Etapas do funil.** O menu lateral e a barra do topo somem enquanto um seletor (Radix Select) fica aberto numa página rolada. Reconfirmado nesta revisão com uma sonda Playwright: com html.scrollTop = 4200, o <aside> está em top = 0; com o seletor 'O que acontece nesta coluna' aberto, o body ganha 'pointer-events: none' e o <aside> vai para top = -4200, e os elementos sticky deixam de grudar. Já constava como suspeita em curso/achados-revisao-2026-10-26.json. Nesta tela acontece em todo seletor das etapas.
- Onde: `components/shell/Sidebar.tsx:501 e components/shell/TopBar.tsx:11 (position sticky), com a trava de rolagem do Radix em components/ui/select.tsx:71-84`
- Evidência: vista na tela

**M47. Fluxos de atendimento.** Em Fluxos de atendimento, 'Duplicar' cria a cópia no banco e mostra 'Fluxo duplicado.', mas a cópia não aparece na lista até recarregar a página. useDuplicateFollowupFlow faz setQueryData só na chave da lista de Follow-ups (['followup','flows','list']), e esta tela usa [...chave, 'atendimento']. Além disso, a cópia do roteiro entra no cache da lista de Follow-ups. O autor viu na tela; confirmei no código.
- Onde: `hooks/followup/useFollowupFlows.ts:93`
- Evidência: vista na tela

**M48. Fluxos de atendimento.** 'Importar fluxo' na tela de Fluxos de atendimento aceita um arquivo de Follow-up. A superfície vem do arquivo, então o fluxo criado é um Follow-up, que não aparece nesta lista. O link 'Abrir o fluxo' do diálogo usa o baseHref da tela (/app/ai/atendimento/<id>), que responde 404 (notFound quando surface !== 'atendimento'). O caso inverso, roteiro importado em Follow-ups, leva a /app/ai/followups/<id>, que também é 404.
- Onde: `app/app/ai/followups/_components/ImportFlowDialog.tsx:209 + app/api/v1/ai/followup-flows/import/route.ts:113`
- Evidência: lida no código, não reproduzida

**M49. Roteadores.** O quadro de intenções vazio diz 'Sem intenções, toda conversa cai direto no agente de fallback (ou fica sem resposta automática, se você não escolher um)'. O trecho entre parênteses é falso. Pela regra 5 de lib/agent-engine/agent/resolve-turn-agent.ts (resolveFallback), sem agente de fallback quem responde é o agente publicado no número e, se não houver um, o agente genérico. O próprio cabeçalho do resolvedor diz que 'não é silêncio'.
- Onde: `app/app/ai/routers/[id]/_client.tsx:467`
- Evidência: vista na tela

**M50. Roteadores.** Para testar a classificação, o roteador precisa estar ativo: a tela mostra 'Ative o roteador para poder testar a classificação.', e a rota /test recusa com 409 qualquer roteador que loadActiveRouter não ache ativo. Só que ativo ele já decide as conversas reais do número, então não há como testar as intenções antes de pô-las no ar. O teste também lê só o que está salvo, sem nenhum aviso de que mudanças não salvas ficam de fora.
- Onde: `app/app/ai/routers/[id]/_client.tsx:847 e app/api/v1/ai/routers/[id]/test/route.ts:114`
- Evidência: vista na tela

**M51. Credenciais.** O módulo 'Login do Codex por assinatura' vem desligado de fábrica, e mesmo assim o diálogo 'Adicionar credencial' oferece 'OpenAI pela assinatura (ChatGPT)'. Quem escolhe essa opção lê que a conta 'se conecta pelo botão de login em IA › Credenciais', mas esse painel não existe na tela. O cabeçalho da página também lista esse provedor. A pessoa chega a um beco sem saída.
- Onde: `app/app/ai/credentials/_components/AddCredentialDialog.tsx:46 (MENSAGEM_DA_ASSINATURA), :252 (lista sem filtro pelo módulo), :337; app/app/ai/credentials/page.tsx:232 (cabeçalho)`
- Evidência: vista na tela

**M52. Provedores.** O cartão 'Modelo padrão' diz '3 pontos precisam de um modelo especialista (embedding ou áudio) e não seguem este padrão — configure cada um abaixo: Indexar o seu material, Buscar no seu material, Ouvir o áudio do cliente'. Os três pontos têm selo 'fixo' e nenhum seletor, e o PUT os recusa (validar-binding.ts, codigo ponto_fixo). Não há como 'configurar cada um abaixo'.
- Onde: `app/app/ai/providers/_components/PainelDeProvedores.tsx:400 (pontos fixos em lib/ai/pontos/registro.ts:531, 551, 568; recusa em lib/ai/pontos/validar-binding.ts:62)`
- Evidência: vista na tela

**M53. Provedores.** Os pontos fixos sem 'usa' nem 'escada' caem na cadeia normal e aparecem como 'claude-sonnet-5 · Usando o padrão da organização.': Indexar o seu material, Buscar no seu material, Ensaiar o agente antes de publicar e Medir o tamanho do contexto. Isso contradiz a razão impressa no próprio cartão (embedding não usa o modelo de conversa; o ensaio usa a versão do agente; a contagem usa o provedor do modelo em uso). Também infla a contagem 'hoje, 19 de 33' e torna falsa a frase 'Trocar aqui muda todos eles de uma vez.' do Modelo padrão.
- Onde: `lib/ai/pontos/resolver.ts:393-426 (só trata fixo.escada e fixo.usa); registro.ts:531, 551, 653, 671; contagem em app/app/ai/providers/_components/PainelDeProvedores.tsx:271 e frase em :313`
- Evidência: vista na tela

**M54. Conhecimento.** Em espanhol, o campo "Preparado" de cada cartão continua em português. formatRelative monta "há N min", "há N h" e "há N d" sem passar por t(); só "nunca" e "agora há pouco" são traduzidos.
- Onde: `components/ai/KnowledgeSourceCard.tsx:85-89`
- Evidência: lida no código, não reproduzida

**M55. Conhecimento.** O motivo em "Por que não entrou" é o last_index_error cru, sem t(). O indexador o grava em português fixo: "embedding falhou no lote …" e a frase de falta de chave. Quem usa a tela em espanhol lê português. Além disso, a frase de falta de chave manda cadastrar "uma chave OpenAI ou OpenRouter em IA › Credenciais" mesmo quando a base é preparada pelo Google, e não cita o atalho "Cadastrar a chave aqui" da própria tela.
- Onde: `components/ai/KnowledgeSourceCard.tsx:174; workers/rag-indexer.ts:534, :724-725 e :780`
- Evidência: lida no código, não reproduzida

**M56. Conhecimento.** "Arquivar" age no primeiro clique, sem confirmação, e usa o ícone de lixeira (Trash2), que sugere apagar. A tela não tem como desarquivar: a lista de arquivados só mostra os nomes, e o PATCH da fonte não aceita status. Para voltar, só cadastrando o material de novo.
- Onde: `components/ai/KnowledgeSourceCard.tsx:258-262; app/app/ai/knowledge/sources/_client.tsx:136; app/api/v1/ai/knowledge/sources/[id]/route.ts:33 (patchSourceSchema)`
- Evidência: vista na tela

**M57. Conhecimento.** A tela de Conhecimento abre para gerente e mostra a ele "Cadastrar a chave aqui" e o formulário inteiro. Mas "Salvar chave" chama POST /api/v1/ai/credentials, que exige papel admin. O gerente preenche tudo e recebe recusa, sem a tela ter avisado que aquilo é só do administrador.
- Onde: `components/ai/ChaveDeConhecimento.tsx:101 e :309-318; app/api/v1/ai/credentials/route.ts:73; app/app/ai/knowledge/sources/page.tsx:39`
- Evidência: lida no código, não reproduzida

**M58. Memória.** O cartão 'Propostas' do hub de IA promete 'Melhorias que a IA sugere para si mesma, esperando sua decisão.', mas a tela que ele abre (/app/ai/proposals) lista só os próximos passos sugeridos para negócios (/api/v1/leads/proposals). As propostas de melhoria do sistema automático, entre elas as do tipo 'Memória da organização', ficam só na aba 'Propostas' da tela de cada agente. Quem procura onde aprovar um aprendizado automático segue o cartão e não o encontra.
- Onde: `lib/navigation/catalogo.ts:715 (descrição do cartão) x app/app/ai/proposals/page.tsx:22-40 + hooks/leads/useProposals.ts:39`
- Evidência: vista na tela

**M59. Skills.** Uma skill do catálogo já vale para todos os agentes de qualquer organização antes de ser instalada: loadSkills carrega os ponteiros de plataforma (organization_id NULL) para todo tenant, e o comentário do GET /api/v1/ai/skills admite isso. A tela trata o catálogo como opcional: diz "disponíveis para instalar com um clique", e o aviso de instalação diz "instalada — já vale para os agentes desta organização". Além disso, "Desinstalar" uma cópia do catálogo não desliga a skill, porque a versão da plataforma volta a valer, e nenhuma tela permite desligar uma skill do catálogo numa organização. O curso ensina o comportamento real; o texto da tela induz ao erro.
- Onde: `lib/agent-engine/agent/skills.ts:194 (where p.organization_id is null or p.organization_id = $1); app/app/ai/skills/_client.tsx:56, :70 e :279; app/api/v1/ai/skills/route.ts:10-12`
- Evidência: lida no código, não reproduzida

**M60. Alertas.** Vários produtores gravam título e corpo do aviso em português fixo, sem usar o idioma da organização. A Central mostra título e corpo como foram gravados, sem passar por t() (AgentInboxList.tsx:171-185). Por isso uma empresa em espanhol lê esses avisos em português. Casos: 'Uma resposta não chegou ao cliente' (recover-stuck-messages/route.ts:187-194), 'Lead não respondeu no prazo' (snooze-watcher/route.ts:97), qr_rescan e channel_number_alert (lib/channels/health.ts:115-151), contact_proposal_expired (lib/contacts/proposta-de-dado.ts:483-496), case_stale (case-stale-watcher/route.ts:187, dívida declarada no próprio arquivo, linhas 121-124) e canal_mudo (canal-mudo-watcher/route.ts:154). Já o handoff sai traduzido (lib/ai/handoff/orchestrator.ts:504 usa traduzir(..., idiomaDaOrg)).
- Onde: `app/api/v1/cron/recover-stuck-messages/route.ts:189; app/api/v1/cron/snooze-watcher/route.ts:97; lib/channels/health.ts:143; lib/contacts/proposta-de-dado.ts:487; app/api/v1/cron/case-stale-watcher/route.ts:187`
- Evidência: lida no código, não reproduzida

**M61. Alertas.** A aba 'Resolvidos' ordena pela CHEGADA do aviso (created_at desc) e mostra no máximo 50. Um aviso antigo resolvido agora, por engano ou pelo 'Marcar todos resolvidos', que fecha todos os abertos de uma vez, aparece abaixo de avisos mais novos. Se houver 50 resolvidos mais novos que ele, ele nem aparece, e não dá para reabri-lo pela tela. O PATCH diz que 'resolver por engano não pode esconder alerta', mas a lista pode escondê-lo. Ordenar os resolvidos por resolved_at, que hoje nem é gravado nesses caminhos (ver achado abaixo), resolveria.
- Onde: `app/api/v1/ai/inbox/route.ts:57-59; app/api/v1/ai/inbox/[id]/route.ts:5`
- Evidência: lida no código, não reproduzida

**M62. Aviso no WhatsApp.** O bloco 'O aviso está adiantando o atendimento?' nunca mostra a comparação. A leitura filtra agent_case_events com actor_kind = 'user', mas o CHECK da coluna só aceita 'agent','human','system','lead' (supabase/baseline.sql:7714). Quando uma pessoa age no caso, o motor grava 'human' (lib/agent-engine/agent/human-cases.ts:373). Resultado: respondidos fica sempre 0, e a tela diz para sempre 'Ainda não há casos suficientes nos últimos 30 dias para comparar'. Visto na bancada com 5 casos dos últimos 30 dias encerrados pela Helena (eventos com actor_kind='human'), 2 deles com aviso 'Entregue'.
- Onde: `lib/escalacao/tela-do-aviso.ts:426`
- Evidência: vista na tela

**M63. Propostas (IA).** O cartão do hub 'Ver tudo em IA' descreve a tela como 'Melhorias que a IA sugere para si mesma, esperando sua decisão.', e o comentário fala do flywheel. Mas /app/ai/proposals (ProposalsList + GET /api/v1/leads/proposals) mostra as próximas ações que a IA anotou para os negócios (lead_state.next_action), e o próprio subtítulo da página diz 'Próximos passos que o assistente sugeriu'. As melhorias do agente (flywheel) ficam na aba 'Propostas' do detalhe do agente (app/app/ai/agents/[id]/_components/ProposalsPanel.tsx). A tradução em lib/i18n/dicionario.ts:1963 herda o mesmo erro.
- Onde: `lib/navigation/catalogo.ts:715 (comentário em :711-712)`
- Evidência: vista na tela

**M64. Propostas (IA).** O onboarding apresenta /app/ai/proposals como 'As ideias dele' ('Com o tempo ele sugere as próprias melhorias', 'Escreve a sugestão aqui... só entra em vigor quando VOCÊ aprovar', citando apply-proposal.ts). Mas essa rota mostra as sugestões de próximo passo dos negócios, e aprovar ali não aplica nada ao agente.
- Onde: `lib/onboarding/o-que-mais-existe.ts:121-131`
- Evidência: lida no código, não reproduzida

**M65. Execuções.** O código de erro 'conteudo_bloqueado' (gerado quando o provedor bloqueia o conteúdo) não tem entrada no mapa O_QUE_FAZER da rota de Execuções. O resumo mostra o código cru 'conteudo_bloqueado' no lugar de uma frase, e o cartão da falha fica sem 'O que fazer:'. O código também não tem tradução no dicionário.
- Onde: `app/api/v1/ai/runs/route.ts:40-75 (mapa O_QUE_FAZER); quem gera: lib/agent-engine/edge/llm/run-model-call.ts:1284; quem mostra o código cru: app/app/ai/runs/_components/ExecucoesDeIa.tsx:172`
- Evidência: lida no código, não reproduzida

**M66. Execuções.** A recusa pelo teto de IA do PLANO (MOTIVO_TETO_DO_PLANO, revenda SaaS) grava o mesmo error_code 'orcamento_esgotado' da recusa pelo limite da organização, porque normalizarErro decide pela classe LlmBudgetExceededError. Com isso, Execuções mostra 'Ajuste o limite (ou desligue a parada) em Uso de IA › Orçamento', que é a orientação errada nesse caso: o cliente não definiu esse teto, e a saída é trocar de plano ou cadastrar chave própria. A orientação certa só aparece na mensagem técnica, que fica escondida.
- Onde: `lib/agent-engine/edge/llm/run-model-call.ts:442 + normalizarErro em run-model-call.ts:1296-1297; texto em app/api/v1/ai/runs/route.ts:55-56`
- Evidência: lida no código, não reproduzida

**M67. Uso e orçamento.** O cartão "Passaram para uma pessoa" e o gráfico "Quanto foi para uma pessoa (%)" contam só os eventos event_log 'ai.handoff_triggered'. O agent-engine, que é o motor canônico, registra a passagem em agent_inbox_items(kind='handoff') e não grava event_log. Isso vale para o pedido "quero falar com uma pessoa", para a ferramenta request_human_handoff e para a passagem quando a IA para por gasto (lib/agent-engine/agent/human-handoff.ts; inbound-turn.ts:865). O painel de Evolução já soma as duas fontes de propósito (app/api/v1/ai/evolution/route.ts:187-199). Para quem só usa o motor, a tela de Uso conta menos passagens do que houve, até 0%.
- Onde: `supabase/baseline.sql:47140 (CTE handoffs da definição de fn_uso_de_ia que vale, iniciada em :47065); supabase/migrations/20261007131331_0586_uso_de_ia_agregado_no_banco.sql:115-118`
- Evidência: lida no código, não reproduzida

**M68. Uso e orçamento.** A primeira chamada de IA de uma organização sem linha em ai_budgets cria a linha pelo gatilho fn_update_budget_consumption, e monthly_limit_cents pega o DEFAULT 5000 da coluna. A partir daí o cartão mostra "gastos de US$ 50,00 · N% do limite", a barra fica amarela aos 80% desse valor, o selo "Passou do limite" pode aparecer e a janela já abre com 50.00. É um limite que ninguém escolheu: a própria rota PATCH chama 5000 de "o valor que ninguém escolheu".
- Onde: `supabase/baseline.sql:770 (fn_update_budget_consumption, única definição) e :1055 (monthly_limit_cents DEFAULT 5000); components/ai/BudgetCard.tsx:196 e :240; app/api/v1/ai/budget/route.ts:142`
- Evidência: lida no código, não reproduzida

## Gravidade baixa

**B1. Prospecção.** O 'Próximo passo' da estratégia, mostrado no modal 'Auditoria do site' da Prospecção, manda 'Gere a prévia da abordagem, revise com seu tom e envie pelo WhatsApp; … Depois marque como contatado.'. Na Prospecção o envio é automático pela fila, e não existe ação de 'marcar como contatado'. O texto ensina um fluxo manual que a tela não tem; vale também para a tradução ES.
- Onde: `lib/prospecting/estrategia-site.ts:311 (e lib/i18n/dicionario.ts:17877)`
- Evidência: vista na tela

**B2. Prospecção.** Plural não tratado: com skipped_count = 1, a tela mostra '1 resultados repetidos ou indisponíveis foram desconsiderados.'.
- Onde: `app/app/prospecting/_client.tsx:880-884`
- Evidência: lida no código, não reproduzida

**B3. Prospecção.** O contador 'Prévias: N de M' conta como marcada uma empresa já 'Não abordado' (por exemplo, sem telefone) que nunca vai ganhar prévia, porque previaPorGerar exige new/queued. Na campanha pausada a tela mostra 'Prévias: 4 de 5', e o contador nunca fecha.
- Onde: `app/app/prospecting/_client.tsx:476-479 e :1462`
- Evidência: vista na tela

**B4. Prospecção.** Tradução ES ambígua: 'Configurar por conversa' (escolha do modo, etapa 2) e 'Configurar conversando' (aba do assistente) viram os dois 'Configurar conversando'. Em espanhol aparecem dois botões com o mesmo nome na mesma área.
- Onde: `lib/i18n/dicionario.ts:742 e :762`
- Evidência: lida no código, não reproduzida

**B5. Prospecção.** Tradução ES incoerente: 'Seleção da fila atualizada.' virou 'Selección de la fila actualizada.' (fila = linha em espanhol), enquanto 'Na fila' é traduzido como 'En cola'.
- Onde: `lib/i18n/dicionario.ts:896 (comparar com :843)`
- Evidência: lida no código, não reproduzida

**B6. Prospecção.** O comentário e o espelho SQL dizem 'Score 0–100', mas com oferta de automação o teto passa de 100: nota até 40, mais avaliações até 150 × 0,4 = 60, mais site até 20, total 120.
- Onde: `lib/prospecting/estrategia-site.ts:366-397 (comentário em :379) e ORDENACAO_POR_SCORE em app/api/v1/prospecting/route.ts:41-52`
- Evidência: lida no código, não reproduzida

**B7. Prospecção.** O PATCH da personalização lê organizations.settings, monta o objeto e grava o jsonb inteiro, sem operação atômica. Uma gravação concorrente de outra chave de settings (propostas, planos de tarefa, régua) pode ser apagada.
- Onde: `app/api/v1/settings/prospeccao/route.ts:62-76`
- Evidência: lida no código, não reproduzida

**B8. Prospecção.** Sem chave salva (configured=false), os quadros de configuração ficam sempre abertos, e o botão 'Configurar busca' só alterna um estado sem efeito visível: clicar não muda nada.
- Onde: `app/app/prospecting/_client.tsx:525-527 e :546`
- Evidência: lida no código, não reproduzida

**B9. Campanhas.** "Duplicar" não copia o que foi escolhido em "Quem responder" (pipeline_id, stage_id, agent_id) nem os números extras do rodízio ("Falar também por estes números"). A cópia volta em silêncio para o funil e o agente do número e fala só pelo número principal.
- Onde: `lib/campanhas/acoes.ts:415-445 (duplicarAcao: insert sem pipeline_id/stage_id/agent_id e sem gravarPool)`
- Evidência: lida no código, não reproduzida

**B10. Campanhas.** "Duplicar" cria a cópia em silêncio: a tela continua na campanha original, sem aviso e sem levar à cópia. A pessoa só descobre a cópia voltando à lista.
- Onde: `app/app/campaigns/[id]/_client.tsx:141; hooks/campanhas/useCampanhas.ts:185 (onSuccess só invalida as consultas)`
- Evidência: vista na tela

**B11. Campanhas.** O estado "Agendada" aparece no filtro Situação e a API aceita a ação agendar, mas a tela nunca oferece o botão "Agendar". O rótulo existe em ROTULO_DA_ACAO e não é usado, então o estado só é alcançável pela API.
- Onde: `app/app/campaigns/[id]/_client.tsx:89-94 e :594`
- Evidência: lida no código, não reproduzida

**B12. Campanhas.** O sufixo do nome da cópia, " (cópia)", é fixo em português no servidor. Quem usa em espanhol recebe "... (cópia)".
- Onde: `lib/campanhas/acoes.ts:424`
- Evidência: lida no código, não reproduzida

**B13. Campanhas.** contatosJaEmCampanha conta TODO destinatário das campanhas vivas, inclusive os excluídos (eligibility_status='excluded'). Um contato que ficou de fora da campanha A por "Está na lista de exclusão" ou "Falta um dado que a mensagem usa" aparece na campanha B como "Já está em outra campanha ainda não concluída", embora não vá receber A.
- Onde: `lib/campanhas/consulta-de-audiencia.ts:444-448`
- Evidência: lida no código, não reproduzida

**B14. Campanhas.** A prévia do público não trata o singular: aparece "1 podem receber · 1 ficam de fora".
- Onde: `app/app/campaigns/new/_client.tsx:389-390; app/app/campaigns/[id]/edit/_client.tsx:315-316`
- Evidência: vista na tela

**B15. Empresas.** "Enriquecer CNPJ" aparece também em empresa sem CNPJ. O clique marca o "Enriquecimento" como "failed — CNPJ inválido para enriquecimento": a mensagem diz "inválido" quando o CNPJ simplesmente não existe, e a falha fica registrada sem ter havido consulta.
- Onde: `app/app/companies/[id]/_client.tsx:171; lib/crm-b2b/enrich.ts:44-55`
- Evidência: lida no código, não reproduzida

**B16. Empresas.** Uma empresa criada sem CNPJ recebe enrichment_status "pending" e fica assim para sempre: a coluna "Situação" mostra "pending" mesmo sem nada a consultar.
- Onde: `lib/crm-b2b/companies-handler.ts:133`
- Evidência: vista na tela

**B17. Empresas.** A lista ignora meta.has_more: mostra só as 50 empresas atualizadas mais recentemente, sem paginação nem "carregar mais".
- Onde: `app/app/companies/_client.tsx:69-76; lib/crm-b2b/companies-handler.ts:42`
- Evidência: lida no código, não reproduzida

**B18. Empresas.** O e-mail, o telefone e o complemento da empresa não aparecem em lugar nenhum fora da janela "Editar empresa". A ficha ("Dados cadastrais") e a lista não os mostram, e o "Endereço" omite o complemento.
- Onde: `app/app/companies/[id]/_client.tsx:194-217`
- Evidência: vista na tela

**B19. Empresas.** Os rótulos das janelas "Nova empresa" e "Editar empresa" não estão associados aos campos (Label sem htmlFor, Input sem id). Na árvore acessível os campos aparecem como textbox sem nome; o leitor de tela não diz qual campo é qual.
- Onde: `app/app/companies/_client.tsx:260-355; app/app/companies/[id]/_client.tsx:284-389`
- Evidência: vista na tela

**B20. Empresas.** A coluna "Atualizado" usa toLocaleString() sem idioma nem fuso da conta, então o formato segue o navegador, e não a língua escolhida na conta.
- Onde: `app/app/companies/_client.tsx:236`
- Evidência: lida no código, não reproduzida

**B21. Empresas.** As mensagens de erro do servidor deste módulo saem fixas em PT, porque fail() não traduz e a tela mostra json.error.message direto. Exemplos: "Não é possível excluir: N pessoa(s) vinculada(s)…", "CNPJ inválido.", "Já existe empresa com este CNPJ.". A tela em espanhol mostra esses avisos em português.
- Onde: `lib/crm-b2b/companies-handler.ts:106,115,307; app/app/companies/[id]/_client.tsx:120,136`
- Evidência: lida no código, não reproduzida

**B22. Pessoas.** O título do quadro na ficha da pessoa mistura inglês com a tela em PT: 'Telefones (contacts)'. Em ES o dicionário já traduz para 'Teléfonos (contactos)'.
- Onde: `app/app/people/[id]/_client.tsx:69`
- Evidência: vista na tela

**B23. Pessoas.** A busca monta o filtro or() do PostgREST com o texto cru. Uma vírgula no termo quebra o filtro (medido de novo nesta revisão: 'Figueiredo, Renata' → 'failed to parse logic tree'). A rota responde 500 e a tela mostra 'Nenhuma pessoa ainda.'. A busca também diferencia acento no nome, porque usa full_name.ilike em vez de normalized_name.
- Onde: `lib/crm-b2b/people-handler.ts:44`
- Evidência: lida no código, não reproduzida

**B24. Pessoas.** Quando a busca não acha ninguém, ou quando a API dá erro, a tabela mostra 'Nenhuma pessoa ainda.'. A frase dá a entender que não existe nenhuma pessoa cadastrada.
- Onde: `app/app/people/_client.tsx:118-125`
- Evidência: lida no código, não reproduzida

**B25. Pessoas.** Na ficha da pessoa, se o GET falhar (404 de pessoa inexistente, 500 de id inválido), a tela fica em 'Carregando…' para sempre, sem mensagem de erro: o load só grava os dados quando res.ok.
- Onde: `app/app/people/[id]/_client.tsx:19 e :26`
- Evidência: lida no código, não reproduzida

**B26. Pessoas.** O cabeçalho 'E-mail' da tabela e o rótulo 'E-mail' da janela 'Nova pessoa' não passam por t(). Em espanhol a tela mostra 'E-mail', enquanto o dicionário traduz para 'Correo'. Por isso a lição usa literal: true nesses alvos.
- Onde: `app/app/people/_client.tsx:110 e :156`
- Evidência: lida no código, não reproduzida

**B27. Pessoas.** Na janela 'Nova pessoa', os rótulos 'Nome completo' e 'E-mail' não estão ligados aos campos: o <Label> não tem htmlFor, o <Input> não tem id, e o rótulo não envolve o campo. Um leitor de tela anuncia os dois campos sem nome, e getByLabel não os encontra (a lição precisa de css :has).
- Onde: `app/app/people/_client.tsx:152-157`
- Evidência: lida no código, não reproduzida

**B28. Planos de tarefa.** O seletor da ação no editor de automações, quando não há plano, diz "Cadastre em Tarefas › Planos.". Esse caminho não existe: a tela Tarefas não tem link nenhum para Planos (só Planos tem um link de volta para Tarefas). A porta real é CRM › Ver tudo em CRM › Planos de tarefa.
- Onde: `app/app/webhooks/_components/ActionConfigForm.tsx:1129; app/app/tasks/ (nenhuma referência a /tasks/planos fora da própria pasta)`
- Evidência: lida no código, não reproduzida

**B29. Planos de tarefa.** O subtítulo e o rodapé do formulário falam em "a ação Aplicar um plano de tarefas" e em "o editor de regras", sem link e sem dizer que isso fica em Canais › Webhooks › Automações. No editor, a ação se chama "Aplicar um plano de tarefas ao negócio". O leigo não acha onde aplicar o plano.
- Onde: `app/app/tasks/planos/_client.tsx:171 e :419`
- Evidência: vista na tela

**B30. Planos de tarefa.** Os seletores "Prioridade" e "Atribuir a" de cada passo, e o "Plano de tarefa" da ação de automação, usam <Label> sem htmlFor e SelectTrigger sem aria-label. Na árvore acessível o combobox não tem nome (aparece só "combobox: Média" / "combobox: Dono do negócio"), e o leitor de tela não diz de que campo se trata.
- Onde: `app/app/tasks/planos/_client.tsx:360 e :379; app/app/webhooks/_components/ActionConfigForm.tsx:1107`
- Evidência: vista na tela

**B31. Planos de tarefa.** Quando a descrição do plano passa de uma linha, "Editar" e "Excluir" quebram para baixo da descrição, alinhados à esquerda, em vez de ficarem à direita do cartão. A causa é o flex-wrap com justify-between no cabeçalho do cartão: o bloco do texto não tem flex-1 e cresce até o tamanho do parágrafo. Reproduzido na tela com uma descrição de 2 linhas.
- Onde: `app/app/tasks/planos/_client.tsx:229-236`
- Evidência: vista na tela

**B32. Planos de tarefa.** O cartão do plano reaproveita o rótulo do formulário como frase: cada passo aparece como "1. Ligar para … — Vence em (dias) 1" e "— Vence em (dias) 0". Para quem lê, o parêntese e o número solto não explicam o prazo; o certo seria algo como "vence 1 dia depois" ou "vence na hora".
- Onde: `app/app/tasks/planos/_client.tsx:255`
- Evidência: vista na tela

**B33. Planos de tarefa.** O comentário de interpolarTitulo diz "Placeholder sem dado NÃO é apagado", mas o código troca {{lead.title}}/{{contact.name}} vazios por string vazia. Uma tarefa de plano pode nascer truncada ("Ligar para e marcar o retorno"); só o título inteiramente vazio é recusado (titulo_vazio).
- Onde: `lib/tarefas/criar-tarefa.ts:81-94`
- Evidência: lida no código, não reproduzida

**B34. Chamadas.** Na transcrição, todo balão da IA tem o nome fixo "Iara", qualquer que seja o nome do agente de voz. Na base do curso o agente se chama Bia.
- Onde: `app/app/calls/_client.tsx:228`
- Evidência: vista na tela

**B35. Chamadas.** "Atendido por" mostra "Humano" sempre que handled_by não é 'ai', inclusive com handled_by nulo: na ligação recusada de contato bloqueado e na de entrada antes de a IA conectar. A tela diz "Humano" para ligações que ninguém atendeu.
- Onde: `app/app/calls/_client.tsx:184`
- Evidência: vista na tela

**B36. Chamadas.** A ligação recusada de contato pessoal grava end_reason 'contato_pessoal', que mapStatusParaApi não conhece e cai no default 'completed'. Enquanto o contato é pessoal ela fica escondida. Ao desmarcar, ela volta ao histórico como "Concluída", com traço na duração e 'Humano', em vez de recusada/"Cancelada".
- Onde: `app/api/v1/calls/route.ts:52-72; workers/voice-agent/recusa-bloqueado.ts:18; workers/voice-agent/index.ts:148-170`
- Evidência: lida no código, não reproduzida

**B37. Chamadas.** O rótulo "Ocupado" (busy) existe na tela e no mapeamento, mas nenhum caminho grava end_reason 'busy'. handleChannelDestroyed marca toda ligação de saída não atendida como 'timeout', seja qual for a causa (ocupado, recusada pela operadora), e tudo aparece como "Não atendida".
- Onde: `workers/voice-agent/index.ts:501-511; app/app/calls/_client.tsx:55; app/api/v1/calls/route.ts:58-59`
- Evidência: lida no código, não reproduzida

**B38. Chamadas.** A transcrição da fala do cliente é forçada em português (whisper-1, language 'pt'), mesmo em organização configurada em espanhol ou inglês. Ali a fala do cliente sai transcrita como se fosse português.
- Onde: `workers/voice-agent/audioSocketBridge.ts:279-283`
- Evidência: lida no código, não reproduzida

**B39. Chamadas.** Enquanto liga, o botão do discador mostra t("Ligando…"), que o dicionário traduz como "Activando…" em ES ("Turning on…" em EN). A tradução é do sentido de 'ligar um recurso', não de 'telefonar'.
- Onde: `app/app/calls/_client.tsx:123; lib/i18n/dicionario.ts:7838`
- Evidência: lida no código, não reproduzida

**B40. Chamadas.** A mensagem "Nenhum trunk SIP configurado para esta organização (Configurações > Trunk SIP)." não tem entrada no dicionário: em espanhol o aviso aparece em português (conferido com traduzir). Na falha de originate, o aviso mostra a mensagem técnica crua do erro (err.message), porque ApiErrorToast não tem entrada para originate_failed.
- Onde: `app/api/v1/calls/route.ts:212-217 e 271; components/feedback/ApiErrorToast.tsx:27-136 e 164`
- Evidência: lida no código, não reproduzida

**B41. Chamadas.** A lista de chamadas não se atualiza ao vivo: não há assinatura realtime nem refetch, e refetchOnWindowFocus está desligado globalmente. Uma ligação feita pela tela fica em "Chamando" até alguém recarregar a página, embora o worker atualize o status durante a ligação. Na falha de originate, o 'Falhou' também só aparece depois de recarregar (onError não invalida a lista).
- Onde: `hooks/calls/useCallsQuery.ts:46-56 e 84-87; lib/query/client.ts:11`
- Evidência: lida no código, não reproduzida

**B42. Produtos.** O custo do produto chega a todo papel. A página e o GET /api/v1/products (requireRole viewer) leem COLUNAS_DO_PRODUTO, que inclui custo_cents. Assim, 'Atendente' e 'Somente leitura' recebem o custo no payload da página e da API, embora a tela só mostre esse campo no formulário de quem edita.
- Onde: `app/app/products/page.tsx:67; app/api/v1/products/route.ts:60; lib/schemas/produtos.ts:148-150`
- Evidência: lida no código, não reproduzida

**B43. Produtos.** O placeholder da busca diz 'Buscar por nome, código ou marca', mas a busca também procura na categoria (filtroDaBuscaDoCatalogo filtra nome, codigo, marca e categoria).
- Onde: `app/app/products/_client.tsx:347; lib/catalogo/busca-da-tela.ts:52`
- Evidência: vista na tela

**B44. Produtos.** Comentário desatualizado: o cabeçalho de busca-da-tela.ts diz que, com termo abaixo do piso, 'a tela mostra a lista sem filtro'. A página faz o contrário: não consulta e mostra 'Nenhum produto encontrado para essa busca'.
- Onde: `lib/catalogo/busca-da-tela.ts:32 vs app/app/products/page.tsx:74-77`
- Evidência: lida no código, não reproduzida

**B45. Importações.** A lista de Importações mostra o status do lote cru, em inglês ('completed'), sem tradução nem rótulo amigável.
- Onde: `app/app/imports/_client.tsx:120`
- Evidência: vista na tela

**B46. Importações.** O resumo depois de importar junta t('Lote processado') com o resto da frase fixo em português (': N ok, N conflitos, N falhas.'). Em espanhol sai 'Lote procesado: 3 ok, 1 conflitos, 2 falhas.'.
- Onde: `app/app/imports/_client.tsx:60-63`
- Evidência: lida no código, não reproduzida

**B47. Importações.** Mensagens gravadas e devolvidas em português fixo, sem tradução para a conta em espanhol. Os erros de linha da coluna 'Erro' ('CNPJ inválido.', 'Telefone inválido.', 'Linha vazia — sem empresa, pessoa ou telefone.', 'Telefone já vinculado a outra pessoa.') e os erros de upload ('Formato não suportado — envie .csv ou .xlsx.', 'Preciso de cabeçalho e ao menos uma linha de dados.', 'Arquivo grande demais.'). A tela mostra r.error cru, embora o dicionário tenha 'Telefone inválido.' → 'Teléfono inválido.'.
- Onde: `lib/crm-b2b/import-process.ts:196, :208, :213, :346; app/api/v1/imports/route.ts:70, :76, :82; lib/crm-b2b/spreadsheet.ts:48, :54; app/app/imports/[id]/_client.tsx:77`
- Evidência: lida no código, não reproduzida

**B48. Importações.** A tela /app/imports não tem porta de papel: o layout só confere o módulo. O cartão do hub some para atendente e somente leitura (minRole manager), mas quem digita o endereço vê o formulário de upload completo. Ao importar, recebe o 403 técnico e sem tradução 'Permissão insuficiente. Requer role >= manager.'.
- Onde: `app/app/imports/layout.tsx (reexporta app/app/companies/layout.tsx, só moduloLigado); lib/auth/require-role.ts:302`
- Evidência: vista na tela

**B49. Importações.** O número '#' do detalhe é a posição entre as linhas não vazias, não a linha da planilha. O CSV descarta linhas em branco e o XLSX descarta linhas sem célula preenchida, e depois rowNumber = i + 2. Com linhas em branco no meio, o '#' não bate com a planilha que o usuário vai corrigir.
- Onde: `lib/contacts/csv.ts:216; lib/crm-b2b/spreadsheet.ts:168; lib/crm-b2b/import-process.ts:64`
- Evidência: lida no código, não reproduzida

**B50. Importações.** O upload não trata resposta que não seja JSON nem erro de rede. Se o fetch falhar, ou se um proxy devolver HTML (ex.: corpo grande demais), res.json() lança antes de setUploading(false), e o botão fica em 'Importando…' para sempre, sem mensagem.
- Onde: `app/app/imports/_client.tsx:53-55`
- Evidência: lida no código, não reproduzida

**B51. Importações.** O detalhe de um lote inexistente ou de outra organização fica em 'Carregando…' para sempre. A tela ignora o 404 da API (só trata res.ok) e não mostra 'não encontrado'.
- Onde: `app/app/imports/[id]/_client.tsx:26 e :36`
- Evidência: lida no código, não reproduzida

**B52. Importações.** O rótulo 'Arquivo' não está associado ao campo de arquivo (label sem htmlFor e sem envolver o input). Na árvore acessível, o controle aparece só como o botão nativo, sem nome.
- Onde: `app/app/imports/_client.tsx:79-84`
- Evidência: vista na tela

**B53. Importações.** Toda empresa sem CNPJ criada pela importação nasce com enrichment_status 'pending' e nunca sai desse estado, porque só as de CNPJ entram na fila de enriquecimento. A lista de Empresas mostra esse 'pending' cru quando não há situação cadastral, sugerindo uma consulta que nunca vai acontecer.
- Onde: `lib/crm-b2b/import-process.ts:264; app/app/companies/_client.tsx:234`
- Evidência: lida no código, não reproduzida

**B54. Propostas (CRM).** "Ver como o cliente recebe" aparece para qualquer papel e em qualquer status, inclusive para Somente leitura, mas GET /api/v1/proposals/[id]/previa exige atendente. Quem só lê clica e recebe erro.
- Onde: `app/app/proposals/[id]/_client.tsx:719`
- Evidência: lida no código, não reproduzida

**B55. Propostas (CRM).** Depois que o modelo é confirmado, "Enviar ao cliente" acende mesmo com o quadro "Não é possível enviar" aberto ou com item "A definir", porque o botão só olha template_slug. O envio só é recusado no servidor, com 422. O próprio quadro conta só os campos do documento: com um item sem preço, ele mostrou "1 pendência(s)" e escondeu o segundo motivo de bloqueio.
- Onde: `app/app/proposals/[id]/_client.tsx:709`
- Evidência: vista na tela

**B56. Propostas (CRM).** A seção "Investimento" do documento (e da prévia em PDF) diz "Valor total: R$ 540,00" enquanto o item "Plano alimentar personalizado" ainda está "A definir". investment.total_formatted usa total_cents sem olhar pricing_status, e o documento apresenta um total parcial como se fosse o total.
- Onde: `lib/propostas/documento/montar-dados.ts:69`
- Evidência: vista na tela

**B57. Propostas (CRM).** O editor não mostra o status nem o número da proposta: o cabeçalho é só o campo de título. Depois de "Marcar como aceita", os botões somem sem nenhuma confirmação, e para saber o status é preciso voltar à lista.
- Onde: `app/app/proposals/[id]/_client.tsx:427`
- Evidência: vista na tela

**B58. Propostas (CRM).** Os rótulos "Condições" e "Válido até" do editor não têm htmlFor. O campo de data fica sem nome acessível, e as condições ficam nomeadas só pelo placeholder. Os campos Qtd e Desconto dos itens também não têm nome.
- Onde: `app/app/proposals/[id]/_client.tsx:452`
- Evidência: lida no código, não reproduzida

**B59. Propostas (CRM).** Em espanhol, o documento da proposta e o PDF saem com o texto dos modelos em português. titleEs e bodyEs das seções são gravados sempre null (catálogo-base, importação, rotas de settings), e renderizarDocumento nunca os lê.
- Onde: `lib/propostas/documento/renderer.ts:26`
- Evidência: lida no código, não reproduzida

**B60. Propostas (CRM).** Quando a IA não sugeriu modelo, como numa proposta criada à mão, a lista de modelos começa com "Ou escolha outro modelo". O "Ou" não faz sentido quando não há uma primeira opção.
- Onde: `app/app/proposals/[id]/_components/DocumentoCanvas.tsx:302`
- Evidência: vista na tela

**B61. Propostas (CRM).** O atalho "Nova proposta" da ficha do negócio exige gerente, mas o botão "Nova proposta" da lista e a rota POST aceitam atendente. Uma Atendente cria proposta pela lista e não vê o atalho na ficha.
- Onde: `components/kanban/LeadDossier.tsx:128`
- Evidência: lida no código, não reproduzida

**B62. Propostas (CRM).** No dicionário, "Enviada" vira "Enviado" em ES. A coluna Status da lista mostra "Enviado" para uma propuesta (palavra feminina), enquanto "Aceita" e "Recusada" saem no feminino (Aceptada, Rechazada).
- Onde: `lib/i18n/dicionario.ts:8166`
- Evidência: lida no código, não reproduzida

**B63. Comandas.** A tela não deixa escolher o cliente da comanda: 'Nova comanda' envia {} (contact_id null), embora a API aceite contact_id. Comanda aberta no balcão nunca mostra 'Pontos de fidelidade', então a fidelidade só funciona para comandas que vêm do faturar da Agenda (com contato) ou do ganho no funil.
- Onde: `app/app/comandas/_client.tsx:110 e :465; lib/financeiro/comanda.ts:103`
- Evidência: lida no código, não reproduzida

**B64. Comandas.** Depois de faturar, o conjunto 'marcados' (e a forma escolhida) não é limpo. Se ainda sobra algum atendimento com preço, o botão 'Faturar' fica habilitado sem nenhuma linha marcada e reenviaria ids já faturados, que a rota só pula como ja_faturado.
- Onde: `app/app/comandas/_pendentes.tsx:68-69 e :153`
- Evidência: lida no código, não reproduzida

**B65. Comandas.** A lista de comandas não mostra que uma comanda foi estornada: a linha só diz 'Finalizada'. O '· estornada' aparece apenas no detalhe.
- Onde: `app/app/comandas/_client.tsx:206 (comparar com :243)`
- Evidência: vista na tela

**B66. Comandas.** A comanda não mostra o nome do cliente nem quem atendeu, embora o subtítulo diga 'O que foi feito, por quem, e quanto o cliente paga.'. Só o saldo de pontos indica que a comanda tem cliente.
- Onde: `app/app/comandas/_client.tsx:232-245; app/app/comandas/page.tsx:43`
- Evidência: vista na tela

**B67. Comandas.** A lista 'Atendimentos sem comanda' mostra service_name ?? title. Com serviço cadastrado, o nome do paciente (que fica no título do compromisso) não aparece, e dois atendimentos do mesmo serviço no mesmo dia ficam iguais.
- Onde: `app/app/comandas/_pendentes.tsx:118`
- Evidência: vista na tela

**B68. Comandas.** Ao escolher um serviço, o preço padrão entra como '130.00' (ponto, toFixed(2)), num campo pt-BR cujo placeholder é '0,00'. O parser aceita, mas a tela mistura os dois formatos.
- Onde: `app/app/comandas/_client.tsx:379`
- Evidência: vista na tela

**B69. Comandas.** O seletor 'Serviço' da comanda usa /api/v1/agenda/tipos, que devolve também os tipos desativados (incluirInativos: true). Assim dá para lançar na comanda um serviço desativado.
- Onde: `app/app/comandas/_client.tsx:95; app/api/v1/agenda/tipos/route.ts:258-260`
- Evidência: lida no código, não reproduzida

**B70. Etapas do funil.** Em /app/settings/tenant/pipelines, o menu lateral destaca 'Configurações' como tela atual, e não 'Ver tudo em CRM'. Isso contradiz o catálogo, segundo o qual o caminho é 'CRM › Ver tudo em CRM' e nunca mais 'Configurações'. A causa: o rodapé usa pathname.startsWith(rodape.href), enquanto o hub só acende com pathname === hub.href.
- Onde: `components/shell/Sidebar.tsx:391 e :395 (rodapé); :365 e :369 (hub); comentário em lib/navigation/catalogo.ts:515-535`
- Evidência: vista na tela

**B71. Etapas do funil.** Em pt-BR, o editor 'Vocabulário e campos' mostra os rótulos em inglês 'Lead', 'Deal', 'Won' e 'Lost'. Só a versão em espanhol traduz ('Negocio', 'Ganado', 'Perdido').
- Onde: `app/app/settings/tenant/pipelines/_client.tsx:906-918`
- Evidência: vista na tela

**B72. Etapas do funil.** A frase do tempo na etapa mostra o nome de uma coluna do banco: '2 negócios nesta etapa agora — mediana de 17.5 h desde a entrada (stage_changed_at)'.
- Onde: `app/app/settings/tenant/pipelines/_stages.tsx:277`
- Evidência: vista na tela

**B73. Etapas do funil.** Em pt-BR, a mediana de horas aparece com ponto decimal ('17.5 h'), porque o número entra cru com String() em vez de usar o formato do idioma.
- Onde: `app/app/settings/tenant/pipelines/_stages.tsx:279`
- Evidência: vista na tela

**B74. Etapas do funil.** Com a 'Janela de esfriando' vazia, os campos de dias e horas mostram o placeholder '0'. O leigo lê 'zero horas', mas vazio vale o padrão de 24 h, como diz o rótulo ao lado.
- Onde: `app/app/settings/tenant/pipelines/_stages.tsx:1006 e :1026`
- Evidência: vista na tela

**B75. Etapas do funil.** As categorias de perda ('Cliente', 'Concorrência', 'Mérito', 'Nós', 'Ausência') aparecem cruas, sem t(), e o dicionário não tem versão ES delas (traduzir devolve o mesmo texto). Na tela em espanhol continuam em português, tanto no seletor do editor do funil quanto no filtro 'Categoria' do quadro.
- Onde: `app/app/settings/tenant/pipelines/_client.tsx:960-961; components/kanban/FilterBar.tsx:307`
- Evidência: lida no código, não reproduzida

**B76. Etapas do funil.** O subtítulo da tela (só para admin) usa o jargão em inglês 'custom fields': 'Para onde o agente leva o card em cada passo do atendimento, vocabulário, custom fields e motivos de perda.' Já está em curso/ACHADOS.md:285, com o número de linha antigo.
- Onde: `app/app/settings/tenant/pipelines/page.tsx:76`
- Evidência: vista na tela

**B77. Fluxos de atendimento.** Com o painel de uma caixa aberto, o painel docado (lg:w-96) estreita o desenho, mas a vista não reenquadra (fitView só roda ao abrir). A coluna da direita do roteiro, onde fica o Fim, some sem nenhum aviso. Para alcançá-la, o usuário precisa achar o botão de enquadrar (só ícone) ou fechar o painel clicando no fundo. O curso ensina o contorno.
- Onde: `app/app/ai/followups/[id]/_components/FlowCanvas.tsx:384 (fitView só no carregamento) e :410-411 (aside lg:static lg:w-96)`
- Evidência: vista na tela

**B78. Fluxos de atendimento.** O cartão de um fluxo de atendimento mostra 'Handoff: Pausar', herdado do Follow-up. Para o roteiro esse valor não tem efeito: o gatilho 0397 encerra o roteiro quando um humano assume, e a PublishBar já esconde a política de handoff para roteiros. O cartão anuncia uma configuração que não existe para ele.
- Onde: `app/app/ai/followups/_components/FlowsList.tsx:176`
- Evidência: vista na tela

**B79. Fluxos de atendimento.** No construtor do roteiro, a caixa 'Fim' mostra como subtítulo o resultado do Follow-up: 'Esgotado' num Fim novo e 'Convertido' no semeado. O EndForm esconde o campo 'Resultado' para roteiros, e o motor decide o desfecho pelas perguntas esgotadas. Para quem monta um roteiro, um Fim novo dizendo 'Esgotado' confunde.
- Onde: `app/app/ai/followups/[id]/_components/nodes/nodeVisuals.ts:296-298`
- Evidência: vista na tela

**B80. Fluxos de atendimento.** Caixas adicionadas pelo clique na paleta nascem a 220 px uma da outra, mas o cartão do nó tem 224 px de largura (w-56). Caixas lado a lado se sobrepõem 4 px; visto ao adicionar Gatilho, Pergunta e Fim num fluxo novo.
- Onde: `app/app/ai/followups/[id]/_components/FlowCanvas.tsx:265 (NodeCard.tsx:83)`
- Evidência: vista na tela

**B81. Fluxos de atendimento.** Para atendente (agent), /app/ai/atendimento abre pelo endereço e mostra cada cartão como link para o construtor. O construtor redireciona papel abaixo de manager para /403, então o cartão leva a uma página proibida.
- Onde: `app/app/ai/followups/_components/FlowsList.tsx:163 + app/app/ai/atendimento/[id]/page.tsx:28`
- Evidência: vista na tela

**B82. Fluxos de atendimento.** Os controles do desenho (React Flow) ficam com dica e aria-label em inglês: 'Zoom In', 'Zoom Out', 'Fit View', 'Toggle Interactivity'. O <Controls /> é usado sem ariaLabelConfig, e quem usa pt-BR ou es ouve e vê esses nomes.
- Onde: `app/app/ai/followups/[id]/_components/FlowCanvas.tsx:387`
- Evidência: lida no código, não reproduzida

**B83. Fluxos de atendimento.** A janela 'Novo fluxo de atendimento' usa o mesmo exemplo do Follow-up no campo Nome: 'Ex: Recuperação de carrinho abandonado'. Isso é exemplo de retomada de loja, não de roteiro de perguntas.
- Onde: `app/app/ai/followups/_components/NewFlowDialog.tsx:89`
- Evidência: lida no código, não reproduzida

**B84. Roteadores.** A dica do agente de fallback diz que ele é chamado 'em vez de travar a conversa'. Isso dá a entender que, sem ele, a conversa trava. Não trava: sem fallback responde quem responderia sem o roteador. É a mesma confusão do quadro de intenções vazio.
- Onde: `app/app/ai/routers/[id]/_client.tsx:429`
- Evidência: vista na tela

**B85. Roteadores.** A dica do modelo do classificador manda cadastrar a chave em 'Agentes IA › Credenciais', caminho que não existe no menu atual. O certo é Agente de IA › Ver tudo em IA › Credenciais.
- Onde: `app/app/ai/routers/[id]/_client.tsx:387`
- Evidência: vista na tela

**B86. Roteadores.** A descrição do cartão no hub de IA ('Qual agente pega qual conversa, e quando o humano assume.') promete algo que a tela não tem. O roteador só escolhe o agente da intenção ou o de fallback. A passagem para humano se configura no agente.
- Onde: `lib/navigation/catalogo.ts:579`
- Evidência: vista na tela

**B87. Roteadores.** Ao clicar na chave, o rótulo muda na hora para 'Ativo — está roteando as conversas deste número', antes de salvar. O selo do topo continua 'inativo' e nada foi gravado, então a frase afirma um estado que ainda não existe.
- Onde: `app/app/ai/routers/[id]/_client.tsx:355-357`
- Evidência: vista na tela

**B88. Roteadores.** Acessibilidade: os rótulos 'Nome da intenção', 'Agente que atende', 'Quando escolher esta intenção' e 'Frases de exemplo (opcional)' não estão ligados aos campos (Label sem htmlFor/id). O seletor 'Agente que atende' fica sem nome acessível, e os campos de texto são anunciados só pelo placeholder. No editor, 'Número de WhatsApp' é um Label sobre um <p>, sem controle associado.
- Onde: `app/app/ai/routers/[id]/_client.tsx:335,621,632,659,743`
- Evidência: vista na tela

**B89. Roteadores.** O texto da lista vazia mistura número com agente: 'um número de vendas fala com quem quer comprar, um de suporte com quem já é cliente, tudo no mesmo WhatsApp'. O roteador separa AGENTES dentro de um mesmo número. Números não se separam por roteador.
- Onde: `app/app/ai/routers/_client.tsx:72`
- Evidência: vista na tela

**B90. Credenciais.** Depois de trocar a chave de uma credencial criada há mais de 2 minutos, o cartão mostra 'Não validada' e a frase 'A validação não terminou. Clique em revalidar...' enquanto a conferência roda em segundo plano, em vez de 'Validando…'. O status 'validando' sai só de created_at, e a troca não mexe nesse campo. Além disso, o diálogo promete 'no próximo atendimento eles já usam a chave nova', mas o runtime recusa chave sem validated_at, e a troca zera esse campo. Até a conferência terminar, ou se a chave nova for recusada, os agentes ligados ficam sem chave.
- Onde: `hooks/ai/useCredentials.ts:74; lib/ai/credenciais/guardar.ts:266; lib/ai/credentials.ts:98; app/app/ai/credentials/_components/RotateCredentialDialog.tsx:176`
- Evidência: lida no código, não reproduzida

**B91. Credenciais.** O gerente só consulta esta tela, e o cartão 'Não validada' mostra para ele 'A validação não terminou. Clique em revalidar para testar a chave agora.' sem o botão de revalidar (canWrite é falso).
- Onde: `app/app/ai/credentials/_components/CredentialCard.tsx:171`
- Evidência: vista na tela

**B92. Credenciais.** Ao editar uma credencial do 'Provedor personalizado (compatível com OpenAI)', aparece o link 'Onde pegar a chave', que aponta para o endereço provisório https://docs.example/provedor-personalizado. O diálogo de cadastro esconde esse link, e provedores.ts diz que ele fica escondido. O cartão repete o problema quando uma chave personalizada é recusada (erro com chaveErrada).
- Onde: `app/app/ai/credentials/_components/RotateCredentialDialog.tsx:199; app/app/ai/credentials/_components/CredentialCard.tsx:153-158`
- Evidência: vista na tela

**B93. Credenciais.** O estado vazio afirma 'Seus agentes só conseguem pensar depois que você cola aqui uma chave da Anthropic, da OpenAI ou do Google'. O componente recebe instalacaoTemIa (a chave no .env, o caso mais comum do kit), mas não a considera aqui. A frase também cita só 3 dos 8 provedores que conversam.
- Onde: `app/app/ai/credentials/_components/CredentialsList.tsx:102`
- Evidência: lida no código, não reproduzida

**B94. Credenciais.** Os nomes dos provedores aparecem sem passar por t() no cabeçalho, no título de cada grupo e nas opções do seletor. 'Provedor personalizado (compatível com OpenAI)' e 'OpenAI pela assinatura (ChatGPT)' não têm entrada ES no dicionário, então ficam em português na tela em espanhol.
- Onde: `app/app/ai/credentials/page.tsx:232; app/app/ai/credentials/_components/CredentialsList.tsx:141; app/app/ai/credentials/_components/AddCredentialDialog.tsx:252; lib/i18n/dicionario.ts (sem entrada)`
- Evidência: lida no código, não reproduzida

**B95. Provedores.** O cartão 'Mapas (Google)' não confere o papel. O gerente vê o campo 'Chave da Geocoding API' editável, e 'Salvar chave'/'Testar' acendem ao digitar, mas PUT e testar exigem admin e o clique termina em recusa. Os outros cartões escondem ou desligam as ações de quem não é admin (podeEditar / pode_editar), e o GET de mapas nem devolve essa informação.
- Onde: `app/app/ai/providers/_components/CartaoDeMapas.tsx:173-199; app/api/v1/ai/mapas/route.ts:52, 107; app/api/v1/ai/mapas/testar/route.ts:33`
- Evidência: vista na tela

**B96. Provedores.** Para o gerente, os seletores 'Provedor' e 'Modelo' do 'Modelo padrão' ficam ativos (a árvore acessível mostra combobox sem disabled), mas não há 'Salvar padrão'. Ele muda a escolha e nada acontece. O seletor do Jev, ao lado, fica disabled para o gerente.
- Onde: `app/app/ai/providers/_components/PainelDeProvedores.tsx:319-381 (Select sem disabled quando !dados.podeEditar)`
- Evidência: vista na tela

**B97. Provedores.** Depois de salvar o modelo de um ponto, a tela não oferece como desfazer e voltar a herdar o Modelo padrão. A rota não tem DELETE (só GET/PUT/PATCH), e a tela nunca envia is_enabled:false. O ponto fica preso numa escolha fixa, e a cada salvamento a herança do agente e o econômico automático deixam de valer para ele.
- Onde: `app/app/ai/providers/_components/PainelDeProvedores.tsx:464-500; app/api/v1/ai/providers/route.ts:73, 340, 502`
- Evidência: lida no código, não reproduzida

**B98. Provedores.** Os placeholders estão fixos num idioma só, sem t(). O endereço próprio usa 'https://mi-gateway.ejemplo.com/v1' (espanhol, aparece na tela em PT), e o modelo livre usa 'ex.: meta-llama/...' (português, aparece na tela em ES).
- Onde: `app/app/ai/providers/_components/PainelDeProvedores.tsx:656, 359, 608`
- Evidência: lida no código, não reproduzida

**B99. Provedores.** Em ES, 'Provedor personalizado (compatível com OpenAI)' fica em português nos dois seletores de provedor. O dicionário não tem entrada para esse rótulo (traduzir devolve o PT), e o seletor do cartão de cada ponto nem passa o rótulo por t(): sai {p.rotulo}, enquanto o do Modelo padrão usa t(p.rotulo).
- Onde: `app/app/ai/providers/_components/PainelDeProvedores.tsx:584 (sem t()) e :335; rótulo em lib/ai/pontos/provedores.ts:145; falta entrada em lib/i18n/dicionario.ts`
- Evidência: lida no código, não reproduzida

**B100. Provedores.** O cartão 'Ouvir o áudio do cliente' mostra jargão técnico a leigo: nomes de variáveis de ambiente (TRANSCRIPTION_API_KEY, TRANSCRIPTION_MODEL, whisper-1) e 'capacidade audio', com a palavra em inglês no meio do português (em ES fica 'capacidad audio').
- Onde: `lib/ai/pontos/registro.ts:570; lib/messaging/media/escada-de-transcricao.ts:99, 102, 106, 107`
- Evidência: vista na tela

**B101. Provedores.** No cartão de ponto, a coluna da direita (modelo + porquê) não tem largura máxima. Com a explicação longa do 'Modelo mais econômico do mesmo provedor…', o título 'Barrar tentativa de manipulação' fica espremido numa coluna de ~100px e quebra em 3 linhas. O mesmo acontece com a descrição de 'Ouvir o áudio do cliente' quando o motivo da escada é longo.
- Onde: `app/app/ai/providers/_components/PainelDeProvedores.tsx:530`
- Evidência: vista na tela

**B102. Conhecimento.** No aviso de falta de chave, a linha "Quem prepara a base: OpenAI. Para usar o Google, cadastre a chave dele em IA › Credenciais." sai em letra maior que o título e o texto do próprio aviso. TrocaDeProvedor foi feito para o estado "pronto", que usa text-xs; dentro do Card do aviso, o span não tem classe de tamanho e herda o tamanho padrão.
- Onde: `components/ai/ChaveDeConhecimento.tsx:207 (uso dentro do Card) e :383 (span sem text-xs)`
- Evidência: vista na tela

**B103. Conhecimento.** O "Preparar de novo" de cada cartão fica ativo mesmo sem chave utilizável, enquanto "Preparar tudo de novo" fica apagado. O clique responde que vai preparar, e a rota apaga o last_index_error antes de o indexador rodar. Até o worker processar o evento, o quadro "Por que não entrou" some e o selo continua "Não entrou", sem motivo. Com o worker de pé, o material volta logo depois para "Esperando a chave".
- Onde: `components/ai/KnowledgeSourceCard.tsx:183; app/api/v1/ai/knowledge/sources/[id]/reindex/route.ts:93`
- Evidência: lida no código, não reproduzida

**B104. Conhecimento.** O quadro "Estado da base de conhecimento" usa sempre o plural: com um só material, mostra "1 materiais". A linha logo abaixo, no _client, já escolhe entre singular e plural.
- Onde: `components/ai/StatusDaBase.tsx:55`
- Evidência: lida no código, não reproduzida

**B105. Memória.** O estado vazio de 'Aprendizados' diz para 'aguarde o sistema sugerir aprendizados automaticamente a partir do atendimento real'. A sugestão nunca chega a esta tela: ela espera na aba 'Propostas' de um agente e só vira aprendizado quando um administrador clica em 'Aplicar como memória da org'. Um leigo espera nesta tela sem saber que precisa aprovar em outro lugar.
- Onde: `app/app/ai/memory/_client.tsx:287`
- Evidência: vista na tela

**B106. Memória.** A descrição do quadro 'Aprendizados' cita só duas origens ('adicionados à mão ou aprendidos automaticamente pelo sistema'). Falta a terceira, que a própria lista rotula: 'anotado pelo agente' (source 'agent', gravada pela ferramenta crm_save_org_memory).
- Onde: `app/app/ai/memory/_client.tsx:224`
- Evidência: vista na tela

**B107. Memória.** O cartão 'Memória' no hub descreve só 'O que o agente já aprendeu sobre a sua operação e reaproveita.'. A peça principal da tela, o 'Documento da organização' com as regras da casa que a equipe escreve e publica, fica de fora. Quem procura 'onde escrevo as regras para todos os agentes' não reconhece o cartão.
- Onde: `lib/navigation/catalogo.ts:634`
- Evidência: vista na tela

**B108. Memória.** Sair da tela com o texto do documento editado e não publicado descarta a edição sem nenhum aviso. O texto fica só no estado do componente, e não há rascunho nem confirmação de saída.
- Onde: `app/app/ai/memory/_client.tsx:66 (useState do conteúdo) e :176-187 (botão Publicar)`
- Evidência: lida no código, não reproduzida

**B109. Memória.** A ferramenta 'Consultar as regras da empresa' (crm_get_org_memory) promete ler 'as políticas e combinados que valem para todo atendimento', mas consulta só org_memory_entries, ou seja, os aprendizados. O 'Documento da organização' (org_memory_versions + ponteiro), onde ficam as regras da casa, nunca é devolvido. O agente interno não perde nada, porque já recebe o documento no prompt. Um assistente externo ligado por MCP não vê as regras da casa.
- Onde: `lib/mcp/tools/evolucao.ts:162-182 x lib/mcp/tools/catalogo/evolucao.ts:57-60`
- Evidência: lida no código, não reproduzida

**B110. Memória.** Os portões de papel não batem. A tela e a permissão 'ai.memory.view' exigem gerente (o atendente cai em /403), mas o GET /api/v1/ai/memory e o GET /api/v1/ai/memory/versions/[id] aceitam o papel 'agent' e entregam ao atendente o documento, o histórico, o texto de cada versão e os aprendizados.
- Onde: `app/api/v1/ai/memory/route.ts:28 e app/api/v1/ai/memory/versions/[id]/route.ts:26 x app/app/ai/memory/page.tsx:19-21 e hooks/auth/AuthProvider.tsx:164`
- Evidência: lida no código, não reproduzida

**B111. Memória.** A mensagem de erro 'id inválido.' sai sem passar por traduzir(): com a conta em espanhol, o erro chega em português.
- Onde: `app/api/v1/ai/memory/entries/[id]/route.ts:31 e app/api/v1/ai/memory/versions/[id]/route.ts:23`
- Evidência: lida no código, não reproduzida

**B112. Skills.** A descrição do cartão "Skills" no hub "Ver tudo em IA" diz "As ações que o agente pode executar sozinho durante o atendimento.". Uma skill não é ação: é um texto de procedimento que entra no prompt quando uma palavra-chave ou etiqueta casa (as ações são as ferramentas do agente). A frase contradiz o subtítulo da própria tela ("Habilidades especializadas que seus agentes carregam só quando a conversa pede") e engana o leigo.
- Onde: `lib/navigation/catalogo.ts:643`
- Evidência: vista na tela

**B113. Skills.** O conteúdo das skills do catálogo da plataforma (objecao-preco e as três versões de agendamento) só existe em português. Numa organização em espanhol, o "Catálogo", as cópias instaladas e o editor mostram descrição e corpo em PT, e a skill injeta procedimento em PT num agente que atende em ES. Não existe variante por idioma.
- Onde: `supabase/baseline.sql:7875-8070, :16430-16560 e :63700-63845 (seeds de plataforma); supabase/migrations/20260724130000_0069_seed_platform_skills.sql; supabase/migrations/20260827050000_0191_o_playbook_de_agendamento_nao_conhecia_as_ferramentas.sql`
- Evidência: lida no código, não reproduzida

**B114. Skills.** As listas "Skills instaladas" e "Catálogo" não têm ordem definida: a página e o GET leem skill_pointers sem ORDER BY. Como Adotar, Salvar e Restaurar regravam a linha do ponteiro (upsert), a skill pode trocar de lugar na lista depois de cada uma dessas ações. Visto na captura: depois de "Adotar versão nova", a "agendamento" passou do 1º para o 2º lugar nesta rodada, e na rodada anterior tinha ficado em 1º.
- Onde: `app/app/ai/skills/page.tsx:27-28; app/api/v1/ai/skills/route.ts:53-65`
- Evidência: vista na tela

**B115. Skills.** O texto do editor promete mais do que o motor faz. Ele diz que o corpo "só entra na conversa quando uma das palavras-chave aparece na mensagem do cliente, ou quando a conversa ou o contato tem uma das etiquetas", e que "a skill é carregada quando o cliente escreve uma destas palavras". O cartão diz "cada skill só entra em ação quando o assunto pede". Na prática, o matcher lê as 6 últimas mensagens que chegaram (não só a última), e um passo de Fluxo de atendimento puxa a skill sem palavra-chave nem etiqueta.
- Onde: `app/app/ai/skills/_components/EditorDeSkill.tsx:124 e :181; app/app/ai/skills/_client.tsx:119; contra lib/agent-engine/agent/inbound-turn.ts:3501 (recentInboundSignal, janela 6) e :3513 (skillsDoRoteiro)`
- Evidência: lida no código, não reproduzida

**B116. Skills.** No teste de uma versão do agente (rota de teste, preview do tipo sandbox), a skill por etiqueta nunca entra: etiquetasParaOMatcher devolve lista vazia quando há preview. O editor de skill promete "a skill entra mesmo sem a palavra-chave" sem avisar que isso não vale no teste. Quem testa uma skill de etiqueta vê o agente ignorá-la.
- Onde: `lib/agent-engine/agent/etiquetas-do-matcher.ts:24; app/api/v1/ai/agents/[id]/versions/[vid]/test/route.ts (sandbox); app/app/ai/skills/_components/EditorDeSkill.tsx:195`
- Evidência: lida no código, não reproduzida

**B117. Alertas.** O resolver manual (PATCH) e o 'Marcar todos resolvidos' gravam só status='resolved' e deixam resolved_at nulo. O reabrir também não limpa um resolved_at antigo. Já os caminhos automáticos (gatilhos e funções do banco, lib/channels/*, lib/agenda/aviso-de-remetente.ts etc.) gravam resolved_at=now(). A coluna fica inconsistente conforme quem fechou o aviso.
- Onde: `app/api/v1/ai/inbox/[id]/route.ts:57; app/api/v1/ai/inbox/resolve-all/route.ts:64`
- Evidência: lida no código, não reproduzida

**B118. Alertas.** A mesma tela tem dois nomes. O menu e o cartão do hub dizem 'Alertas', mas o título da página e o rótulo do sino dizem 'Central de avisos'. Um leigo que chega pelo sino não acha 'Central de avisos' no hub, e quem chega pelo hub não reconhece o título.
- Onde: `lib/navigation/catalogo.ts:665; app/app/ai/inbox/page.tsx:43; components/shell/AlertsBell.tsx:39`
- Evidência: vista na tela

**B119. Alertas.** O corpo do aviso message_send_stuck usa um termo técnico com quem opera: 'Verifique se ... o worker de envio está rodando'. O leigo não sabe o que é worker nem onde conferir isso.
- Onde: `app/api/v1/cron/recover-stuck-messages/route.ts:193`
- Evidência: vista na tela

**B120. Alertas.** O subtítulo da Central usa jargão e atribui tudo ao assistente: 'O que o assistente precisou escalar para o time: conexões caídas...'. 'Escalar' é termo de suporte técnico, e boa parte dos avisos (conexão caída, mensagem presa, cobrança) vem do sistema, não do assistente.
- Onde: `app/app/ai/inbox/page.tsx:45-48`
- Evidência: vista na tela

**B121. Aviso no WhatsApp.** A chave 'Receber avisos no WhatsApp' fica travada (disabled={!podeLigar}) também para DESLIGAR. Com a configuração salva como ligada e um estado bloqueante ativo (sem endereço público, por exemplo), a tela mostra a chave ligada e apagada: a pessoa não consegue pausar o aviso, e o único jeito de parar é 'Remover destinatário'. Além disso, 'Salvar' reenvia ligado=true sem que a pessoa possa mudar. Visto na tela (L1 p5 e L4 p3).
- Onde: `app/app/ai/cases/avisos/_components/AvisoNoWhatsApp.tsx:340`
- Evidência: vista na tela

**B122. Aviso no WhatsApp.** A data é formatada com o literal português 'às' dentro do padrão do date-fns ("dd/MM 'às' HH:mm"). Em espanhol, a lista de entregas e o quadro de mensagens ignoradas mostram, por exemplo, '27/10 às 16:58' no meio de uma frase em espanhol.
- Onde: `app/app/ai/cases/avisos/_components/EntregasDoAviso.tsx:106 e app/app/ai/cases/avisos/_components/AlertasDoAviso.tsx:158`
- Evidência: lida no código, não reproduzida

**B123. Propostas (IA).** A lista de Propostas chama roteiaProximasAcoes SEM defaultPipelineId, e o quadro do funil passa { defaultPipelineId }, apesar de o cabeçalho da rota dizer que as duas usam a mesma regra de propósito. Exemplo: um contato com um negócio aberto no funil padrão e outro num funil não padrão, este com movimento mais recente. A lista põe a sugestão no negócio do funil não padrão e o cartão do funil padrão também a mostra, ou o quadro resolve pelo funil padrão um empate que a lista descarta sem aviso.
- Onde: `app/api/v1/leads/proposals/route.ts:95 vs app/api/v1/pipelines/[id]/board/route.ts:419-423`
- Evidência: lida no código, não reproduzida

**B124. Propostas (IA).** O 'proposta há X' e a ordem da lista (mais antiga primeiro) usam lead_state.updated_at. Esse campo muda em toda escrita de estágio/BANT da ferramenta de estado (lead-state.ts:295, updated_at = now()), não só quando a sugestão é escrita, como a própria interface ProximaAcao avisa. Resultado: uma sugestão antiga pode aparecer como recente e descer na lista.
- Onde: `lib/leads/next-action.ts:112`
- Evidência: lida no código, não reproduzida

**B125. Propostas (IA).** Decidir no cartão do quadro invalida só o cache ['board', pipelineId], e não ['proposals']. Com o staleTime padrão de 30s (lib/query/client.ts:9), quem volta para Propostas pela navegação do app logo depois de decidir no cartão ainda vê a sugestão como pendente. Clicar nela dá 409 'Não há proposta pendente para este negócio.' O caminho inverso (decidir na lista) invalida os dois caches.
- Onde: `hooks/kanban/useNextAction.ts:26 e :48 (comparar com hooks/leads/useProposals.ts:73-81)`
- Evidência: lida no código, não reproduzida

**B126. Propostas (IA).** A rota de decisão grava reason em português fixo ('Aprovou: …' / 'Descartou: …'), e a linha do tempo faz t(item.reason), que não traduz frase composta. Quem usa o sistema em espanhol vê 'Aprovou:'/'Descartou:' na linha do tempo do negócio.
- Onde: `app/api/v1/leads/[id]/next-action/route.ts:128 + components/kanban/LeadTimeline.tsx:79`
- Evidência: lida no código, não reproduzida

**B127. Propostas (IA).** POST /api/v1/leads/{id}/next-action é uma mutação que não grava api_audit_log: não importa audit, ao contrário de move/clone/retomar. O CLAUDE.md exige uma entrada de auditoria por mutação POST bem-sucedida. win e lose parecem ter a mesma lacuna.
- Onde: `app/api/v1/leads/[id]/next-action/route.ts:121-145`
- Evidência: lida no código, não reproduzida

**B128. Execuções.** Na aba Roteamento, toda decisão de roteador com o Jev DESLIGADO é gravada com modo 'tradicional_comparacao' (estadoLido 'desligada' não é 'decidindo'), e a tela rotula esse modo como 'IA de sempre decide; Jev observa'. Para quem nunca ligou o Jev, a tela afirma que ele observa.
- Onde: `lib/agent-engine/agent/resolve-turn-agent.ts:430 (modo) e :438 (jevSolicitado); rótulo em app/app/ai/runs/_components/RoteamentoResultados.tsx:40`
- Evidência: lida no código, não reproduzida

**B129. Execuções.** Sem nenhuma execução, o resumo diz 'Nenhuma falha nas últimas 0 execuções.', uma frase sem sentido logo acima do estado vazio 'Nenhuma execução ainda...'.
- Onde: `app/app/ai/runs/_components/ExecucoesDeIa.tsx:154-160`
- Evidência: vista na tela

**B130. Execuções.** O 'O que fazer' de 'endereco_exige_chave_da_empresa' manda cadastrar a chave da empresa em 'Agente de IA › Provedores', mas chaves se cadastram em Credenciais. A própria tela Provedores manda para /app/ai/credentials no link 'Cadastrar uma chave'.
- Onde: `app/api/v1/ai/runs/route.ts:59-60 (comparar com app/app/ai/providers/_components/PainelDeProvedores.tsx:202)`
- Evidência: lida no código, não reproduzida

**B131. Execuções.** O 'O que fazer' do veto de orçamento, visível no resumo e no cartão, manda para 'Uso de IA › Orçamento', mas o cartão do hub se chama 'Uso e orçamento' e a seção da tela se chama 'Orçamento mensal de IA'. O leigo não acha um menu com esse nome.
- Onde: `app/api/v1/ai/runs/route.ts:55-56`
- Evidência: vista na tela

**B132. Execuções.** A mensagem técnica do veto de orçamento, que o leigo abre em 'Mensagem técnica do provedor', traz jargão interno ('agent_inbox_items kind=budget_exceeded', 'sair byte para o provedor'). É uma constante em PT que continua em português numa instalação em espanhol (não passa pelo dicionário).
- Onde: `lib/agent-engine/edge/llm/run-model-call.ts:95; lib/agent-engine/edge/llm/orcamento.ts:447-448 (MOTIVO_TETO_DO_PLANO, mesmo problema)`
- Evidência: lida no código, não reproduzida

**B133. Execuções.** Na página Roteamento sem decisões, os cartões mostram '— ms' e 'p95: — ms' (unidade depois do traço), e 'Acerto revisado por pessoa: Sem pares', um rótulo de comparação aplicado a revisão humana, que não forma par nenhum.
- Onde: `app/app/ai/runs/_components/RoteamentoResultados.tsx:143 e :147 (texto 'Sem pares' em :102)`
- Evidência: vista na tela

**B134. Execuções.** Os valores em dólar das duas abas usam Intl.NumberFormat com locale fixo 'pt-BR', enquanto as datas da mesma tela seguem o idioma do usuário (useTagDeIdioma). Numa conta em espanhol o custo sai no formato brasileiro.
- Onde: `app/app/ai/runs/_components/ExecucoesDeIa.tsx:32; app/app/ai/runs/_components/RoteamentoResultados.tsx:38`
- Evidência: lida no código, não reproduzida

**B135. Uso e orçamento.** O valor de "Passaram para uma pessoa" é formatado com toFixed(2) e sai com ponto decimal ("11.76%"), enquanto os cartões vizinhos usam vírgula pt-BR ("32,4%").
- Onde: `app/app/ai/usage/_client.tsx:145`
- Evidência: vista na tela

**B136. Uso e orçamento.** "Passaram para uma pessoa" e o gráfico de passagens ignoram os filtros "Agente" e "Tipo de uso": as CTEs inbounds/handoffs de fn_uso_de_ia não aplicam p_agent_id nem p_purpose. Com "Bia" e "Responder o cliente" filtrados, o cartão segue em 11.76%, o mesmo da empresa toda, sem aviso na tela.
- Onde: `supabase/baseline.sql:47130-47146 (CTEs inbounds e handoffs de fn_uso_de_ia); app/app/ai/usage/_client.tsx:143-147`
- Evidência: vista na tela

**B137. Uso e orçamento.** O cartão divide o total de passagens pelo total de mensagens de clientes no período, mas o gráfico divide as de cada dia pelas mensagens do MESMO dia (UTC). Uma passagem num dia sem mensagem de cliente vale 0 no gráfico. Visto na bancada: o cartão mostrava 11.76% e o gráfico "Quanto foi para uma pessoa (%)", "Sem dados no período". Como o dia vira às 21h de Brasília, uma passagem logo depois de uma mensagem do fim da noite cai no dia seguinte.
- Onde: `lib/ai/usage/aggregate.ts:118 (total) vs :128 (série por dia); components/ai/UsageChart.tsx:86`
- Evidência: vista na tela

**B138. Uso e orçamento.** Dias, gráficos e filtros "De"/"Até" contam o dia em UTC e não no fuso da organização. No Brasil o dia da tela vira às 21h: o uso das 21h à meia-noite entra no dia seguinte, e "Até" escolhido como hoje corta às 20:59 de Brasília. A tela não diz isso. A lição agora explica numa dica.
- Onde: `app/api/v1/ai/usage/route.ts:32-59 (startOfUtcDay/parseDayUtc/resolveRange); supabase/baseline.sql:47079, :47131, :47140 (at time zone 'UTC')`
- Evidência: lida no código, não reproduzida

**B139. Uso e orçamento.** O tooltip do gráfico "Quanto foi para uma pessoa (%)" chama a série de "Handoff", jargão em inglês, e formata com toFixed(2), com ponto decimal.
- Onde: `components/ai/UsageChart.tsx:262`
- Evidência: lida no código, não reproduzida

**B140. Uso e orçamento.** A descrição sob o título é fixa e termina em "— nos últimos 30 dias.", mesmo quando "De"/"Até" escolhem outro período. A lição explica isso numa dica.
- Onde: `app/app/ai/usage/page.tsx:63`
- Evidência: lida no código, não reproduzida

**B141. Uso e orçamento.** O título da página é "Uso de IA", mas o cartão do hub e o catálogo chamam a tela de "Uso e orçamento". Quem chega pelo cartão encontra outro nome.
- Onde: `app/app/ai/usage/page.tsx:60; lib/navigation/catalogo.ts:737`
- Evidência: vista na tela

