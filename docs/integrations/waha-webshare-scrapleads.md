# Pesquisa: WAHA externa e proxies do Scrapleads

Data: 14/09/2026. Escopo: leitura dos dois projetos e documentação oficial; nenhuma sessão, proxy, credencial de produção ou integração do Scrapleads foi alterada. Diagnóstico autenticado em 14/09/2026 confirmou WAHA 2026.7.1 / GOWS / PLUS, 50 proxies válidos, 27 sessões com proxy e oito proxies US livres naquele instante. Uma requisição HTTPS por proxy US confirmou o IP de saída. O endpoint de ambiente não indicou WHATSAPP_HOOK_URL global.

## Confirmado no Scrapleads

Fontes relativas a `/Users/antoniosanches/projects/scrapleads`:

| Fonte | Comportamento confirmado |
|---|---|
| `src/app/api/whatsapp/connect/route.ts` | Valida usuário administrador, resolve organização, provisiona Chatwoot quando necessário, seleciona país/proxy, cria sessão e persiste estado para QR. |
| `src/lib/services/waha-client.ts`, `createWahaAdminClient` | Usa `WAHA_BASE_URL` e `WAHA_API_KEY`; autenticação por `X-Api-Key`. |
| Mesmo arquivo, `createSession` | `POST /api/sessions`, `start: true`, `config.proxy`, `config.webhooks` e filtros de eventos. O proxy é serializado em `server` como `usuario:senha@host:porta`. |
| Mesmo arquivo, `buildStandardWebhooks` | Configura eventos de estado/ACK/mensagens para Scrapleads e mensagens de entrada para N8N, com configuração por sessão. |
| `src/lib/services/webshare-client.ts` | Usa `WEBSHARE_API_KEY`, header `Authorization: Token …`, pagina `/proxy/list/?mode=direct`, filtra proxies válidos e mantém cache em memória. |
| Mesmo arquivo, `getProxyByCountry` | Sorteia proxy do país solicitado. Sem proxy nesse país, usa o país com maior quantidade disponível. Não consulta ocupação por outras sessões. |
| Rota de conexão | Persiste `proxy_id`, `proxy_address`, `proxy_country`; registra fallback. Falha de obtenção do proxy permite seguir sem proxy. Reconexão pode excluir a sessão anterior. |

O endereço de WAHA registrado na documentação local é `https://waha.metamorph-ai.com`; a fonte efetiva é a configuração de execução. Não se presume que documentação histórica comprove a versão/engine atual.

### Pontos que não devem ser copiados sem adaptação

- O comentário de proxy único não é uma garantia: não há reserva exclusiva no caminho de seleção analisado. Um controle exclusivo apenas no CRM também não impede o Scrapleads de sortear o mesmo proxy. Exclusividade entre aplicações exige coordenação central ou pools separados.
- A tela de países calcula fallback por uma cadeia de países; a conexão usa o país com maior estoque. A indicação visual pode divergir do país efetivamente escolhido.
- `testProxy(proxy)` não usa o parâmetro para transportar a requisição pelo proxy; chama a API Webshare diretamente. Não comprova o IP de saída da sessão.
- Não transportar a lógica de exclusão/recriação da sessão para o CRM: o CRM já possui reserva idempotente, confirmação por lease e recuperação sem exclusão automática.
- As integrações Chatwoot/N8N do Scrapleads não são necessárias para o Inbox nativo deste CRM.

## Estado anterior do CRM (antes desta implementação)

- `lib/waha/client.ts`: `createSession` cria sessão parada apenas com `config.ignore`; não envia proxy nem webhook por sessão. O cliente atualmente confirma compatibilidade NOWEB.
- `lib/channels/connect-waha.ts`: reserva tenant-aware com idempotência e checkpoints. Esse fluxo deve continuar sendo a autoridade da criação.
- `docker-compose.prod.yml`: o webhook está configurado globalmente no serviço WAHA local. Além disso, o worker fixa `WAHA_API_BASE_URL: http://waha:3000`, sobrescrevendo o `.env`. Apenas trocar a URL no `.env` pode deixar aplicativo e worker em servidores diferentes.
- `lib/waha/client.ts`, `convergirConfigDaSessao`: preserva os demais campos da configuração ao ajustar filtros. A extensão deve preservar proxy, webhooks e identidade nas reconexões.
- `lib/waha/webhook-auth.ts`: permite exigir assinatura. A implantação compartilhada precisa validar HMAC e resolver a organização pela sessão conhecida, sem confiar em um tenant enviado no payload.

## Contrato externo verificado

A [documentação oficial de proxy](https://waha.devlike.pro/docs/how-to/proxy/) admite configuração por sessão e recomenda `server: host:porta`, `username` e `password` separados, sem prefixo HTTP/HTTPS no servidor. O formato concatenado do Scrapleads deve ser tratado como compatibilidade a verificar na versão instalada, não como única forma válida.

Os [eventos de entrada](https://waha.devlike.pro/docs/how-to/receive-messages/) podem ser configurados em `config.webhooks`. A [documentação de sessões](https://waha.devlike.pro/docs/how-to/sessions/) descreve criação e atualização da configuração. A homologação deve confirmar também os webhooks globais existentes: configurar uma sessão não é prova de que nenhum listener global receberá seus eventos.

## Implementação

1. **Diagnóstico autenticado somente de leitura:** confirmar URL, versão, engine e formato aceito; consultar disponibilidade Webshare e ocupação das sessões sem registrar credenciais ou contatos. Não mudar webhooks globais nem sessões `sl_*`.
2. **Transporte comum:** configurar a WAHA externa para aplicativo, worker e rotinas de mídia. Corrigir o override do worker mantendo o padrão local para outras instalações.
3. **Proxy por conexão:** seleção de país/proxy na tela Canais → Conexões; persistência tenant-aware do vínculo, estado e país efetivo; segredo cifrado no backend ou resolvido sob demanda. Não devolver senha ao navegador.
4. **Criação consistente:** reservar canal/proxy, criar sessão parada com proxy e webhook do CRM, confirmar configuração e identidade, depois iniciar e apresentar QR. Uma falha deve deixar estado recuperável e visível. Quando proxy for exigido, falhar sem iniciar uma sessão direta.
5. **Webhooks próprios:** apontar as novas sessões para `https://crm.dealercrm.io/api/v1/webhooks/waha/<token-do-canal>`, com os eventos já consumidos pelo CRM e assinatura validada. Preservar sessões e configurações alheias.
6. **País e continuidade:** mostrar país efetivo e indisponibilidade. Troca de país deve ser uma escolha explícita na conexão, não um fallback escondido. Reutilizar o proxy nas tentativas; mudança em sessão ativa deve ser controlada e auditada.
7. **Pareamento:** apresentar QR para o número escolhido pelo operador. Não converter canais históricos da migração em canais de envio automaticamente. A definição de assumir um número hoje atendido no Warm pertence ao cutover, com verificação de roteamento para evitar atendimento duplicado.

### Critérios de validação

- Testes de autenticação, RLS, concorrência e repetição da reserva; zero segredos em respostas/logs.
- Proxy indisponível ou inválido impede conexão quando exigido; reconexão mantém vínculo.
- Teste real de saída pelo proxy, além de GET da configuração da sessão.
- Estado da sessão e QR visíveis; eventos assinados chegam ao Inbox da organização correta.
- Mensagens humanas e continuidade IA/humano passam pelo transporte escolhido; envio real de teste depende de destinatário e mensagem definidos pelo operador.
- Recursos do Scrapleads não alterados; baseline, migration e MANIFEST juntos caso sejam adicionados campos/tabelas.

## Integração com o sistema

Entrada: administrador em Conexões e API Webshare. Saída: reserva de canal → WAHA → webhook → Inbox/dispatcher existente. Auditoria: conexão, seleção/troca de proxy e falhas, sem segredos. Superfície: estado, país efetivo e ação de tentar novamente no canal. Recuperação: manter reserva e identidade após falha; não excluir sessão. Retorno: falha de proxy impede iniciar/reiniciar e fica visível para correção. O mapa de arquitetura e os testes de jornada devem acompanhar a implementação.

## Configuração e operação

`WAHA_EXTERNAL=true`, `WAHA_ENGINE=GOWS`, `WAHA_API_BASE_URL`, `WAHA_API_KEY`, `WAHA_WEBHOOK_BASE_URL` (origem HTTPS do CRM), `WAHA_HMAC_SECRET`, `WEBSHARE_API_KEY` e `WHATSAPP_PROXY_REQUIRED=true` configuram o transporte externo. Segredos ficam somente no ambiente protegido do servidor. `WEBSHARE_PROXY_IDS` pode limitar o pool por IDs separados por vírgula, se o operador separar um conjunto entre aplicações. O padrão sem essas opções continua local/NOWEB.

Em Canais → Conexões → Conectar novo WhatsApp, selecione apenas o país e gere o QR; o sistema reserva automaticamente um proxy livre, tentando o próximo do mesmo país em caso de disputa pela reserva. A seleção existe também no onboarding. O país não muda por fallback. Após falha, o cartão oferece reconexão e configuração de proxy; troca exige sessão parada/falha. A exclusão confirmada no transporte libera a reserva; histórico permanece arquivado conforme a regra existente. Nunca converter um canal histórico em canal ativo.

A migration 0247 consulta reservas do pool sem revelar a organização; a tela também bloqueia proxies reservados antes da criação remota. A migration 0246 cria o vínculo sem senha e a reserva atômica service-role; o baseline e o MANIFEST acompanham. A API de opções é administrativa. O transporte valida os marcadores de organização/canal antes de adotar uma sessão. Rotinas automáticas não recriam sessão perdida sem configuração. Webhooks externos exigem assinatura SHA512 e correspondência entre sessão e token do canal. Aplicativo e worker usam a mesma URL.

Living System Checklist: entrada em `ProxyPicker`/Webshare; saída em `connect-waha`/WAHA e Inbox; registro `channel.proxy_selected` na auditoria; vínculo visível em `ConnectionsClient`; porta existente Canais → Conexões; anti-morte por estado de falha e reconexão preservando identidade; configuração em seletor e ambiente do operador; continuidade IA/humano pelo dispatcher existente sem alteração de autoridade; falha impede início e solicita correção; mapa `proxy-por-conexao.architecture.json`. Mensagens reais e pareamento exigem o aparelho e um teste de envio autorizado pelo operador.
