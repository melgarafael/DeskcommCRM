# Assinaturas escreve.ai

Estado: interface e catálogo publicados em 20/09/2026; contratação e cobrança permanecem indisponíveis.

## Oferta mensal

| Plano     | Mensalidade | Pessoas | Canais | Agentes | Franquia de IA |
| --------- | ----------: | ------: | -----: | ------: | -------------: |
| Essencial |      R$ 197 |       2 |      1 |       2 |          R$ 30 |
| Crescer   |      R$ 397 |       5 |      3 |       5 |          R$ 80 |
| Escala    |      R$ 797 |      15 |      8 |      15 |         R$ 180 |

Preços em reais por empresa. A franquia de IA representa consumo, não um número garantido de mensagens. Tarifas Meta e de outros canais são separadas. Não oferecer consumo ilimitado, teste gratuito ou desconto anual antes da implementação correspondente. Contas existentes não são convertidas nem cobradas automaticamente.

A oferta mantém os recursos centrais nos três planos; a diferença é capacidade operacional. A franquia de IA ocupa aproximadamente 15%, 20% e 23% da receita bruta. Isso é uma hipótese inicial de preço, não margem líquida comprovada: impostos, meios de pagamento, infraestrutura e atendimento ainda precisam ser medidos na operação.

Referências de posicionamento consultadas em 20/09/2026: [Zaia](https://www.zaia.app/plans-team/) e [respond.io](https://respond.io/pricing). Preços e unidades desses produtos não são equivalentes e não foram copiados.

## Invariantes da implementação

- O servidor resolve organização e permissão; o navegador nunca define preço, beneficiário ou organização de cobrança.
- Somente uma confirmação verificada do provedor altera a assinatura. Redirecionamento de sucesso não prova pagamento.
- Eventos duplicados devem ser idempotentes; eventos atrasados não podem regredir uma assinatura mais recente.
- Cancelamento, renovação, falha de pagamento e gestão de faturas precisam do estado real do provedor.
- Valores comerciais em BRL não podem ser gravados diretamente no orçamento atual de IA: a contabilidade existente usa centavos de USD. Conversão e teto precisam de regra explícita e teste antes de ativar a venda.
- A migration 0315 aplica limites de agentes, canais e pessoas no banco para assinaturas confirmadas. Está validada localmente, ainda não aplicada em produção. Não remove recursos preexistentes; tratamento amigável dos erros nas rotas e franquia comercial de IA continuam pendentes.
- Sem provedor configurado, a interface mostra contratação indisponível, sem fabricar checkout ou assinatura ativa.

## Deploy

Produção confirmada em `crm.escreve.ai`, host Azure, app Docker. O checkout de produção contém alterações próprias não commitadas; não executar reset, clean ou atualização in-place sem reconciliação. Preservar imagens atuais para rollback. Código de produção foi solicitado para cópia de auditoria fora do repositório; conclusão da transferência deve ser verificada.

## Evidência da preparação — 20/09/2026

- Catálogo comercial: 3 testes passaram; adaptador Stripe e assinatura HMAC: 3 testes passaram.
- Migration 0265: baseline aplicado em instalação e atualização pelo harness; 4 invariantes passaram (isolamento entre empresas, leitura restrita, bloqueio de escrita pelo tenant e idempotência).
- TypeScript e lint focado passaram nesta revisão intermediária. Rotas de checkout/webhook ainda precisam de testes de ciclo completo, cancelamento e concorrência; esses checks não provam cobrança funcional.
- Cópia filtrada de produção concluída em `work/production-audit/source-filtered.tar.gz`, fora do repo. Comparação: 61 arquivos diferentes e uma migration exclusiva de produção, `20260915230000_0252_redes_sociais_nativas.sql`. Reconciliar antes do deploy; não remover a migration de produção.
- Produção: app `deskcomm-app:saraiva-voice-048e55ed`; imagem anterior deve ser mantida. Disco tinha apenas 1,4 GB livres; build exige liberar cache dispensável ou construir em outro ambiente.
- `BILLING_ENABLED` permanece desativado. Ativação depende da conta recebedora, webhook real, limites aplicados no backend e QA de pagamentos em teste. Nenhum pagamento foi cobrado e nenhum plano de cliente foi alterado. A publicação posterior da interface está registrada abaixo.

## Revalidação antes da publicação

- Suíte unitária completa: 927 arquivos passaram; 9.412 testes passaram e um caso está marcado como falha esperada pelo próprio teste. Log local: `work/release-final-unit.log`, fora do repositório.
- Dez casos adicionais provaram recusa de checkout sem permissão, em acompanhamento administrativo, com origem externa, campos de preço/empresa enviados pelo cliente, plano desconhecido ou cobrança desativada. Webhooks sem assinatura, de ambiente incompatível ou sem efeito também foram verificados. Isso prova as guardas, não um pagamento real.
- TypeScript, lint dos arquivos revisados e seis casos de configuração passaram. A suíte de shell falhou no caso legado de nome com apóstrofo (`Sant'Ana Odontologia`); os arquivos do kit e dos testes de shell são idênticos aos da branch `versao-atual`. O deploy desta edição usa a imagem Docker, sem executar esse instalador.
- Bloqueios de ativação permanecem: conta recebedora, fluxo de cancelamento/faturas, vínculo inequívoco entre tentativa de checkout e eventos de assinaturas substituídas, auditoria das mutações e aplicação dos limites. A interface de planos permanece informativa.

## Publicação da interface — 20/09/2026

- Imagem `escreve-app:e698f004`, Linux amd64, compilada a partir de `e698f004`. Os commits `28e7f608` e `4f199c74` acrescentam testes e documentação, sem mudar o código da imagem. As alterações de cobrança posteriores ainda não estão nessa imagem.
- Candidato validado antes da troca: health saudável e login, logo e ilustrações respondendo 200. A primeira tentativa foi descartada porque `docker run --env-file` preservava as aspas do `.env`; o candidato validado usou as variáveis já interpretadas do container anterior. O aplicativo anterior permaneceu saudável durante essa correção.
- Apenas o serviço `app` foi substituído. Health público confirmou `escreve-e698f004`, Supabase, Redis e WAHA saudáveis. Imagem anterior preservada: `deskcomm-app:saraiva-voice-048e55ed`; configuração anterior em `.env.before-escreve-e698f004` no diretório de produção.
- Banco conferido após a troca: 4 empresas, 6 agentes e 5 canais, sem alteração. Hashes das linhas completas dos agentes permaneceram iguais.
- Marca da instalação atualizada para escreve.ai com auditoria e cópia dos valores anteriores; personalizações das empresas preservadas. Login e favicon confirmados no endereço público.
- Lista de agentes, criação ilustrada em desktop/mobile e planos conferidos na sessão real do navegador. Cartão de tarefa preenche a ideia, sem criar nem publicar agente. Nenhum erro de console observado na revisão. Evidências visuais em `outputs/remake-frontend/`, fora do repositório.
- `BILLING_ENABLED=false`; migration 0265 ainda não aplicada em produção. Publicação do catálogo não significa contratação operacional: os bloqueios da seção anterior continuam pendentes.

## Endurecimento da cobrança após o deploy

Ainda não publicado nem habilitado: o checkout passa a gravar `checkout_attempt_id` também nos metadados da assinatura. O webhook compara esse vínculo e o plano com a tentativa persistida, consulta o estado atual do provedor e ignora eventos de tentativas substituídas, inclusive após cancelamento. A consulta valida também o identificador retornado. O envio explícito por `subscription_data.metadata` segue o [contrato de metadados da Stripe](https://docs.stripe.com/metadata).

Retentativas recentes reutilizam a mesma tentativa. Uma tentativa sem resposta confirmada há 23 horas é bloqueada para reconciliação, pois a Stripe pode remover chaves de idempotência após 24 horas ([contrato do provedor](https://docs.stripe.com/api/idempotent_requests)). A atualização da tentativa não renova esse relógio a cada repetição. Uma assinatura já cancelada recebe uma tentativa nova mesmo quando a gravação da sessão anterior falhou.

Confirmações de assinatura e novas sessões de checkout emitem auditoria pelo mecanismo existente. Falhas de conexão com o banco retornam erro recuperável. Validação: 34 testes relevantes passaram, incluindo cinco falhas reproduzidas antes da correção; TypeScript, lint focado e diff-check passaram. Cobrança permanece desativada em produção; cancelamento/faturas, limites, reconciliação tardia e QA com a conta real continuam pendentes. A verificação do navegador encontrou a Stripe na tela de login, sem sessão disponível.

## Portal de gestão preparado

Código ainda não habilitado em produção: a página de planos oferece **Gerenciar assinatura** quando a cobrança está configurada e existe um cliente Stripe vinculado à empresa autenticada. A rota POST `/api/v1/billing/portal` exige administrador, recusa acompanhamento administrativo e origem externa e não aceita identificadores ou URLs enviados pelo cliente. Falhas retornam uma tentativa recuperável; a abertura bem-sucedida é auditada.

O adaptador cria uma [sessão do portal da Stripe](https://docs.stripe.com/api/customer_portal/sessions/create) com cliente e retorno definidos no servidor. Valida cliente, ambiente e domínio da resposta antes de encaminhar o navegador. `STRIPE_PORTAL_CONFIGURATION` é obrigatória para habilitar a cobrança. Essa configuração precisa permitir faturas, atualização de pagamento e cancelamento ao fim do período; troca de plano pelo portal deve permanecer desativada até existir sincronização correspondente no produto. Configuração e cancelamento reais ainda precisam ser conferidos na conta recebedora.

Validação local: 76 testes passaram (rotas, adaptador, interface, navegação, tradução e configuração), além de TypeScript, lint focado e diff-check. Os testes cobrem progresso, falha e nova tentativa na interface e recusam respostas com outro cliente, ambiente ou domínio. Não foi aberta sessão real de cobrança nem realizado cancelamento financeiro. A conta do provedor continua sem autenticação disponível.

## Escolha de plano e limites de recursos preparados

A página de planos consulta a assinatura da empresa autenticada e oferece checkout somente quando não há assinatura vigente. Uma tentativa pendente mantém a escolha no mesmo plano; uma assinatura vigente oferece gestão, sem segundo checkout. O estado ativo exige identificador de assinatura, status confirmado e período ainda válido. Parâmetros de retorno do navegador não concedem acesso nem provam pagamento. O botão mostra progresso, recupera de falhas e recusa redirecionamento fora do domínio de checkout.

A migration 0315, refletida no baseline e no manifesto, limita novos agentes, canais e vínculos de pessoas por plano. A reserva serializa no registro da assinatura, inclusive em transações repeatable-read. Rascunhos e canais desconectados ocupam vaga até arquivamento; vínculos de equipe ocupam vaga até revogação. Convites por e-mail ainda sem vínculo não ocupam vaga. Empresas sem assinatura confirmada continuam no comportamento anterior. Cancelamento bloqueia novas adições, preservando edição e arquivamento dos recursos existentes. O contador de reserva não altera o relógio de retentativa do checkout.

Validação local: 17 testes de banco passaram, incluindo isolamento, concorrência, instalação/atualização do baseline e reaplicação. Outros 71 testes de interface, estados, adaptador, guardas, traduções e manifesto passaram. A verificação completa de tipos encontrou três indexações inseguras em testes desta entrega; corrigidas e `pnpm typecheck` passou.

A tela atual foi conferida no navegador em servidor separado, na porta 3002, com configuração fictícia de provedor exclusivamente para mostrar os controles. Três escolhas visíveis e ausência de rolagem horizontal em 1280 px. Evidência: `outputs/billing/planos-selecao-local.png`, fora do repositório. Nenhum botão de pagamento foi enviado ao provedor. A porta 3001 permanece com seu build anterior. Esta conferência não valida pagamento real nem substitui o ciclo completo de cobrança em teste.

Antes de habilitar: concluir a franquia de IA, os erros de limite nas jornadas de criação, a reconciliação de tentativas expiradas/ambíguas e o ciclo real na conta recebedora. Migration 0315 e seleção de plano ainda não publicadas em produção.

## Recuperação após limite de recursos

A criação de agentes pela ação usada no formulário e pela API, além da conexão WhatsApp pela página de Conexões e pelo onboarding, reconhece o SQLSTATE `P4020`. A resposta pública é `subscription_resource_limit` (HTTP 409 nas rotas), com orientação localizada para Configurações → Planos e assinatura. O backend não repassa diagnóstico SQL. A reserva de canal interrompe o fluxo antes de criar, iniciar ou parar sessões externas.

O formulário preserva nome e instruções quando a criação é recusada e exibe o aviso sem confirmar sucesso. Testes exercitam a ação real de criação, o formulário e a fronteira de transporte do canal. A expansão desse tratamento para equipe e outros provedores de canal permanece pendente; os gatilhos do banco já fazem a restrição independentemente da mensagem da interface. Cobrança e estas mudanças continuam sem ativação em produção.

## Contabilidade anterior à franquia comercial

O seam de IA agora complementa as tarifas legadas com `ai_models`, buscando o provedor escolhido e priorizando o identificador exato do modelo. Registra centavos fracionários de USD em `llm_calls`, sem arredondar cada chamada para um centavo inteiro. Não aplica a tarifa direta da Anthropic a chamadas da OpenRouter. Preço ausente, inválido, consulta indisponível ou cache sem tarifa permanecem como custo desconhecido, não zero. As tarifas legadas de cache da Anthropic foram preservadas.

A versão instalada do SDK já agrega todas as etapas em `usage`; esse comportamento não foi alterado. Um teste com o SDK e um modelo local simulado confirma que o custo consultado é gravado no registro da execução e que a resposta é preservada. Ainda faltam as tarifas de cache do catálogo e a vinculação da franquia comercial em reais ao período da assinatura, com reserva concorrente de consumo. Esta melhoria isolada não habilita a venda nem torna a franquia operacional.

## Recuperação de sessões de pagamento preparada

Antes de reutilizar ou substituir uma sessão persistida, o checkout consulta o [estado canônico da sessão na Stripe](https://docs.stripe.com/api/checkout/sessions/retrieve), validando empresa, tentativa, plano, cliente, ambiente e domínio. Uma sessão aberta é reutilizada mesmo que o relógio local indique expiração. Uma sessão concluída aguarda confirmação da assinatura; não gera outra cobrança. Somente expiração confirmada, ou uma sessão concluída da mesma assinatura já encerrada, permite substituição. Falha de consulta preserva a tentativa.

A recontratação passa a registrar estado `pending` antes de chamar o provedor, mantendo o identificador da assinatura encerrada. Assim, timeout reaproveita a chave de idempotência e a conta não entra na exceção de empresa legada dos limites. O webhook só aceita a nova assinatura com a tentativa persistida; eventos da anterior continuam ignorados. A interface permite recuperar o plano escolhido, sem apresentá-lo como ativo.

Tentativas ambíguas sem identificador de sessão com mais de 23 horas ainda exigem reconciliação administrativa. Os testes de sessão e webhook são simulações locais; autenticação da conta recebedora, pagamento real de teste e aplicação em produção permanecem pendentes.

Validação desta revisão: 83 testes unitários passaram em cinco arquivos, além de TypeScript e lint focado. O harness aplicou o baseline em instalação e atualização e passou 14 testes de limites no PostgreSQL, incluindo o estado `pending` com vínculo de assinatura preservado. Isso verifica a recuperação local e as restrições; não substitui o ciclo financeiro na conta real.

## Ciclo da assinatura para a franquia

A migration 0316 acrescenta `current_period_start`, mantendo valores desconhecidos como nulos e validando a ordem do intervalo quando conhecido. O adaptador exige início e fim válidos no item da assinatura, conforme a API Basil, e o webhook persiste ambos a partir da consulta autenticada ao provedor. Não infere o início pelo fim, pela chegada do evento ou pela virada do mês. Essa preparação evita conceder novamente uma franquia na data errada; a reserva e a aplicação do saldo comercial ainda precisam ser implementadas.

Validação local: 80 testes unitários e 21 de banco passaram, com instalação e atualização do baseline, ordem da varredura de permissões e manifesto conferidos. Tipos foram gerados do PostgreSQL local e incorporados somente para a tabela alterada; TypeScript e lint focado passaram. Migration 0316 aplicada somente no banco de desenvolvimento, sem alteração em produção.

## Reserva e conciliação da franquia

A migration 0317 cria períodos e reservas com isolamento por empresa. Cada período preserva a franquia e uma tarifa comercial fixa de conversão: **R$ 6 por US$ 1 de consumo apurado**, sem representar cotação cambial em tempo real. Alterações posteriores no catálogo não reescrevem ciclos já abertos. Esse valor ainda precisa aparecer na interface antes da ativação da oferta.

Cada execução no motor compartilhado (`runModelCall`) reserva até R$ 1 do saldo disponível antes de sair para o provedor. Essa reserva coordena concorrência; não é estimativa de custo nem cobrança adicional. Ao concluir, o custo em USD é convertido pela tarifa do período, a reserva é liberada e o desconto fica limitado ao crédito disponível, protegendo outras reservas. Custo do provedor acima desse crédito é absorvido pela plataforma e continua registrado em USD. O cliente nunca recebe excedente automático. A última chamada pode consumir mais que a reserva inicial; esse desenho não representa um teto exato de despesa da plataforma.

Falha ou custo desconhecido mantém a reserva para conferência e impede novas execuções no período. Não há liberação automática por tempo: uma resposta perdida não prova consumo zero. Conciliação repetida com o mesmo custo é idempotente; custo divergente é recusado. Chamadas iniciadas no ciclo anterior são conciliadas nele mesmo, inclusive após renovação ou cancelamento. Empresas legadas sem assinatura vinculada mantêm seu comportamento anterior. O orçamento editável da organização não desliga essa proteção comercial.

O caminho `lib/ai/runtime/agent.ts`, embeddings e demais chamadas diretas ao SDK ainda precisam ser ligados à mesma regra antes de habilitar a venda. Também faltam a apresentação de saldo/reservas, a recuperação administrativa dos custos desconhecidos e o QA financeiro na conta recebedora. Esta revisão não foi publicada em produção.

Validação desta revisão: suíte unitária completa com 934 arquivos aprovados, 9.527 testes aprovados e um caso de falha esperada. Quinze testes no PostgreSQL passaram para isolamento, concorrência, idempotência, custo desconhecido, renovação, cancelamento, proteção de outras reservas e privilégios. TypeScript passou; lint focado não teve erros e manteve um aviso de importação de tipo já existente no motor. Migration 0317 aplicada somente no banco de desenvolvimento, com tipos gerados dali. A primeira execução focada detectou perda do registro de uma chamada previamente cancelada; o cancelamento voltou para dentro do trecho que registra falhas e a suíte completa confirma a correção.

## Cobertura das chamadas diretas

`runMeteredOperation` aplica a mesma reserva antes dos caminhos ativos que chamavam o SDK diretamente: sugestão de funil no onboarding, worker anterior de respostas, descrição de imagens, runtime anterior de agentes e `embedText` para indexação/busca. O custo vem dos tokens medidos e do catálogo do provedor, sem arredondar cada embedding para um centavo inteiro. Uso ausente permanece desconhecido. Falha de conciliação preserva a resposta e registra o identificador da reserva para investigação.

A auditoria de chamadas encontrou também `edge/llm/embed.ts`, mas nenhum chamador de `embedQuery` ou `embedConfigFromEnv` em `app`, `lib` e `workers`; esse caminho sem uso não foi alterado. Serviços externos de voz/transcrição e tarifas de canais não foram convertidos em preços de tokens. Todas as imagens de app e workers que executam esses caminhos precisam ser atualizadas após aplicar as migrations; `SUPABASE_DB_URL` é necessário para a reserva transacional.

Testes específicos exercitam saldo recusado antes de enviar embedding, conciliação de tokens sem saída, empresa legada, medição ausente, falha de provedor e falha de banco após uma resposta válida. Os testes de roteamento que não exercitam cobrança agora usam explicitamente uma empresa legada no banco simulado. Ainda faltam saldo na interface, recuperação administrativa, cache/tarifas completas e QA financeiro antes da ativação comercial.

Validação da expansão: 30 arquivos focados e 222 testes passaram; o caso de empresa paga em embeddings foi acrescentado em seguida. A suíte completa passou em 935 arquivos, com 9.536 testes aprovados e uma falha esperada. TypeScript passou; lint focado sem erros, com um aviso de importação de tipo preexistente no teste de embeddings. Nenhuma chamada paga ou mensagem real foi usada nessa validação.

## Saldo visível na assinatura

`readAiAllowance` lê o período da assinatura e agrega somente reservas daquela empresa e daquele ciclo. `AiAllowanceCard`, em Planos e assinatura, apresenta franquia, saldo restante, consumo, reservas e tarifa fixa do período. Sem período confirmado, não apresenta números como crédito disponível; assinatura inativa e custo desconhecido têm aviso explícito. Falha de consulta gera orientação para atualizar a página. A porta continua restrita ao administrador, sem acesso comercial em sessão de suporte. A leitura não produz mutação nem libera reservas.

Validação local do saldo: 21 testes unitários (incluindo tradução), quatro testes com a consulta real no PostgreSQL, TypeScript e lint focado aprovados. O teste de banco cobre isolamento, renovação antes da primeira chamada e retenção de custo desconhecido. Navegador validado em desktop e 390 px, claro e escuro, com uma assinatura sintética no banco local; largura de documento e viewport iguais no celular. As capturas estão em `outputs/billing/saldo-*.png` no diretório de trabalho da entrega, fora do repositório. A assinatura e reservas temporárias foram removidas ao terminar. Nenhum pagamento, chamada de IA ou envio a cliente ocorreu. A interface está implementada localmente; ativação comercial e deploy continuam pendentes dos demais requisitos financeiros.
