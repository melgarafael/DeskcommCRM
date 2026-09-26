# Conversões de anúncios pelo CRM

## Operação

1. Em **Configurações → Conversões**, conecte a plataforma que trouxe o contato.
2. Configure a captura da origem. Anúncio direto para WhatsApp precisa fornecer o identificador real do clique; o caminho Google usa `gclid`, `gbraid` ou `wbraid` e referência na mensagem. UTMs de site permitem identificar campanha, mas não substituem o identificador aceito pela API de conversões.
3. No funil, marque o negócio como ganho e preencha valor positivo e moeda. O consumidor `conversoes.venda` acompanha tanto `lead.won` quanto `lead.stage_changed`.
4. A tela mostra vendas aceitas e pendências. Depois de corrigir uma pendência, clique **Verificar ou tentar novamente**. Esse comando emite `ad_conversion.retry_requested`; não repete eventos comerciais nem notificações de ganho.

Falhas temporárias ficam visíveis e são tentadas novamente. No Data Manager, o protocolo fica no registro de envio: passagens seguintes consultam esse protocolo, sem repetir a ingestão. Após 24 horas sem conclusão, a pendência pede consulta manual. Reprocessar uma pendência com protocolo consulta novamente. Rejeição explícita de processamento libera uma nova tentativa após corrigir a causa.

Uma resposta HTTP de sucesso não basta: a Meta precisa confirmar `events_received`; no caminho Google anterior, o resultado por item precisa estar presente e sem falha parcial; no Data Manager, a consulta precisa confirmar `SUCCESS`. Isso comprova recebimento/processamento, **não** atribuição à campanha. Confira a atribuição no gerenciador de anúncios.

Eventos enviados com código de teste da Meta ficam como pendência de teste e não elevam o contador de vendas aceitas. Desative o código e só reporte vendas reais verificadas.

## Google: duas formas de conexão

- Conexões existentes permanecem na Google Ads API. O token de desenvolvedor continua necessário para esse caminho.
- Novas autorizações usam Data Manager. Use o mesmo aplicativo OAuth configurado na instalação, habilite a Data Manager API no projeto Google Cloud e autorize o escopo `https://www.googleapis.com/auth/datamanager`. Não precisa de developer token para essa API.
- A tela oferece **Autorizar nova integração do Google** para migrar uma conexão anterior de forma explícita. Conta e ação continuam sendo informadas pela tela. A escolha da API faz parte do `state` assinado; o callback grava a API junto do refresh token cifrado.
- A conexão deve ter permissão sobre a conta/ação escolhida. Se ela for alterada enquanto houver protocolo pendente, restaure o destino original para consultar esse protocolo. Não há reenvio automático para outra conta.

Configuração de instalação já existente: `GOOGLE_ADS_OAUTH_CLIENT_ID` e `GOOGLE_ADS_OAUTH_CLIENT_SECRET`; `GOOGLE_ADS_DEVELOPER_TOKEN` é específico do caminho anterior. Não há variável nova obrigatória.

Fontes oficiais consultadas em 24/09/2026 UTC:

- [Importação pela Google Ads API](https://developers.google.com/google-ads/api/docs/conversions/upload-offline): `partial_failure=true` e inspeção por item.
- [Restrições de acesso a uploads antigos](https://developers.google.com/google-ads/api/docs/deprecations): a elegibilidade histórica depende do uso anterior do recurso.
- [Ingestão Data Manager](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest) e [consulta do protocolo](https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve).

## Escopo desta entrega

Correção e evolução da integração já distribuída no núcleo. Reutiliza contatos, funil, eventos e configuração por organização. Não cria outro CRM nem transforma o envio em requisito para o atendimento.

Esta entrega usa a origem capturada no contato e os eventos de venda `Purchase` e qualificação `QualifiedLead` (Google). Captura web completa para Meta, atribuição por nova jornada de cliente antigo, outros eventos por etapa, conversões otimizadas por dados pessoais e painéis de ROAS são evoluções separadas. Não são anunciados como implementados.

## Captura Google e qualificação por etapa

CONFIRMADO no código desta entrega:

- **Captura de origem do Google Ads**, na mesma tela, configura WhatsApp, mensagem com `[ref:{token}]` e ativação do endereço. Funciona antes de conectar a API de conversões.
- O botão do site deve repassar os parâmetros reais recebidos na página: `gclid`, `gbraid` ou `wbraid`. Copiar apenas a URL fixa não preserva esses identificadores. Macros não resolvidas e identificadores inválidos não fabricam atribuição; o visitante ainda recebe o destino WhatsApp.
- A captura persiste os tipos de identificadores e somente UTMs permitidas da query. O código curto é associado ao contato pela ingestão existente. Remover o código da mensagem impede essa associação.
- Em **Google Ads → Lead qualificado (opcional)**, escolha uma etapa aberta e o ID de uma ação de conversão diferente da compra. A conta e a autorização são as mesmas da conexão. Configure a categoria da ação e a participação na otimização no Google Ads; o CRM não cria nem altera essas propriedades remotamente.
- A regra começa desligada. Salvar não percorre negócios antigos: apenas movimentos posteriores à configuração são elegíveis. Arrastar e mover em lote usam `lead.stage_changed`.
- Qualificação envia uma vez por negócio, sem valor monetário; compra continua exigindo negócio ganho e valor positivo. Reentrada na etapa não gera uma segunda qualificação. Um novo negócio é outra conversão.
- `QualifiedLead` é o nome interno do registro, não um evento enviado à Meta. No Google, a ação escolhida define o resultado. O transporte Meta continua aceitando somente compra.
- O livro de envios guarda data e ação originais da qualificação. Alterar uma regra não muda a ação de qualificações já registradas. Pendências mostram evento e permitem reprocessá-lo individualmente.
- A origem do contato ainda segue primeiro toque; compras de clientes que retornam por outra campanha exigem a evolução de origem por jornada antes de afirmar atribuição correta nesse cenário.

Fontes do contrato Google: [identificadores e evento Data Manager](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest), [envio de eventos](https://developers.google.com/data-manager/api/devguides/events/send-events).

Migration 0402 preserva conexões existentes e grants privados, acrescenta identificadores de clique, etapa opcional com FK composta por organização e snapshot de qualificação. A assinatura anterior da RPC de reenvio permanece compatível com compras.

Aceite do piloto: primeiro verificar captura real do identificador e da mensagem; depois mover um negócio elegível à etapa escolhida, conferir o evento de qualificação e seu diagnóstico; por fim ganhar o negócio com valor e conferir a compra. Designar um único emissor por evento durante a comparação com outro rastreador, evitando dupla contagem.

## Contratos e verificação

Migration 0401 adiciona API da conexão e protocolo do envio, preserva RLS/grants existentes e impede rebaixar `sent` numa execução atrasada. A RPC de reprocessamento só é executável por `service_role`; a rota exige administrador, MFA pelo guard canônico e bloqueia suporte somente leitura. Organização vem da sessão. A RPC usa lock no registro e evita dois pedidos pendentes simultâneos.

- Unitários: `conversoes-entrega-confiavel`, `conversoes-de-anuncio`, `conversao-reprocessar-rota`, `google-ads-conversoes` e `google-ads-cartao-sem-credenciais`.
- Banco: `tests/invariants/conversoes-reprocessamento-isolado.test.ts` e vocabulário banco/TypeScript.
- Navegador: `tests/e2e/conversoes-reprocessamento.spec.ts`, registrado no CI. Exige Supabase local e app construído. Não faz chamada real a contas de anúncios.
- Piloto externo necessário antes de ativar em uma instalação: clique real → mensagem recebida → negócio ganho → recibo/processamento → diagnóstico e atribuição na plataforma. Eventos e credenciais sintéticos dos testes não provam essa jornada externa.

### Living System Checklist

1. Entrada: captura pública Google configurada em `_formCapturaDeUtm`, eventos do funil e botão de reprocessamento.
2. Saída: `qualificacao.handler.ts` e `envio.handler.ts` usam os transportes em `lib/plataformas-de-anuncio/`.
3. Registro: `ad_conversion_dispatches`, `event_log` e `ad_conversion.retry_requested` na auditoria.
4. Tela: `/app/settings/conversoes`, origem, pendência e próximo passo.
5. Porta: navegação existente de Configurações → Conversões.
6. Recuperação: retentativa transitória, consulta de protocolo e ação manual após 24 horas.
7. Configuração: `_formGoogle` escolhe etapa/ação e `_formCapturaDeUtm` configura o destino; formulários existentes, escolha explícita da nova autorização e explicação quando faltam credenciais.
8. Continuidade: ganho pelo humano ou pelas capacidades existentes alimenta o mesmo consumidor; falha de anúncios não interfere no atendimento.
9. Retorno: resultado altera o registro e a pendência; pedido manual volta ao mesmo consumidor, com a mesma identidade de venda.
10. Mapa: `docs/architecture/conversoes-de-anuncios.architecture.json`.

## Script para o site (captura v1)

CONFIRMADO no código: depois de salvar e ligar uma captura, **Configurações → Conversões → Script para instalar no site** oferece um trecho para copiar. Instale uma vez em cada página, antes de fechar `head`, mantendo os links normais de WhatsApp. O domínio do script vem da instalação aberta no navegador; não contém chaves ou tokens de acesso. O site deve permitir esse domínio em sua política de scripts (CSP). Em um site HTTPS, use também HTTPS na instalação do CRM. Se alterar números ou quais capturas estão ligadas, copie novamente o trecho.

O arquivo `public/rastreio/v1.js` é servido anonimamente, inclusive no Docker que já copia `public`. Identificadores Google válidos escolhem a captura Google; UTMs/fbclid sem identificador Google usam a captura de site existente. Não configura o Pixel nem acrescenta envio de conversões web à Meta. Só modifica links `wa.me`, `api.whatsapp.com/send`, `web.whatsapp.com/send` e `whatsapp://send` cujo número corresponde à captura escolhida. Links abreviados, iframes, shadow DOM e botões que abrem WhatsApp por código próprio exigem adaptação.

- A origem é mantida no `sessionStorage`, por domínio do site, instalação e organização, para a navegação na mesma aba. Não há cookie nem persistência entre dispositivos/domínios. Uma nova entrada explícita substitui a anterior, sem misturar identificadores; parâmetros inválidos não recuperam um clique antigo.
- `data-storage="none"` desliga leitura e gravação em storage: só os parâmetros da página atual são usados. Armazenamento bloqueado não impede o uso na página atual. A instalação deve respeitar as escolhas de armazenamento do site; se houver carregamento condicionado a consentimento, inclua o script depois dessa escolha.
- `data-rastreio-ignorar` exclui um link. Elementos adicionados depois são observados. Cliques normais, teclado e nova aba preservam a navegação nativa; o script não usa `preventDefault`.
- Só identificadores e chaves de campanha permitidos atravessam; não copia a query inteira, cookies, campos de formulários nem o texto original do botão. O texto e número finais são os salvos na captura do CRM.
- Sem origem utilizável ou sem carregar o script, os links originais permanecem. Depois de um link apontar para a captura, a disponibilidade do CRM é necessária. O código curto é gerado apenas no clique, pelo servidor; remover o código da mensagem impede o casamento.
- A atribuição do contato continua sendo de primeiro toque. A origem de uma visita nova não altera automaticamente um contato já atribuído.

Teste de instalação: abra o site com parâmetros de uma campanha, navegue para outra página, confira o destino do botão e envie a mensagem mantendo `[ref:XXXXXX]`. Confira a origem no contato antes de habilitar conversões reais. O teste de navegador automatizado usa campanha sintética e intercepta WhatsApp; não prova atribuição final por uma plataforma de anúncios.

Living System Checklist do script: entrada = URL e capturas salvas; saída = rotas de captura e referência na mensagem; registro = click refs e origem do contato existentes; superfície/configuração = seção do script em Conversões; continuidade = mensagem normal no atendimento; falha = link original quando script/origem ausente, com roteiro de diagnóstico acima; retorno = ajustar configuração e repetir a visita de teste; mapa = site → script → captura → contato. O script não muda responsável, etapa ou decisão do agente.
