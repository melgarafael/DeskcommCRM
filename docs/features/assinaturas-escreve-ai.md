# Assinaturas escreve.ai

Estado: interface e catálogo publicados em 20/09/2026; contratação e cobrança permanecem indisponíveis.

## Oferta mensal

| Plano | Mensalidade | Pessoas | Canais | Agentes | Franquia de IA |
| --- | ---: | ---: | ---: | ---: | ---: |
| Essencial | R$ 197 | 2 | 1 | 2 | R$ 30 |
| Crescer | R$ 397 | 5 | 3 | 5 | R$ 80 |
| Escala | R$ 797 | 15 | 8 | 15 | R$ 180 |

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
