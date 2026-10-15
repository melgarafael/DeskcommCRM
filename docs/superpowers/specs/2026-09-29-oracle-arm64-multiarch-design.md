# Distribuição nativa AMD64 + ARM64 para self-host na Oracle

Data: 2026-09-29
Estado: aprovado pelo dono em 2026-09-30; implementação pendente

## Objetivo e limites

Permitir que um clone fresco instale e atualize o produto em Ubuntu `linux/arm64` (Ampere/Oracle) com a mesma versão e as mesmas capacidades oferecidas em `linux/amd64`: app, worker, scheduler, IA, WhatsApp NOWEB, mídia, Supabase externo ou single-server, e os perfis opcionais de chamadas WhatsApp e telefonia SIP. O caminho normal usa imagens publicadas; não compila o CRM na VPS do usuário. O suporte a AMD64 permanece. Uma capacidade opcional estar disponível não significa ligá-la automaticamente nem dispensar credenciais, números, SIP trunk e configuração de rede.

Não entram nesta mudança: migrar dados de outra VPS, obter credenciais/contas de terceiros, contratar SIP, ativar WAHA Plus, garantir throughput em uma configuração de CPU sem medição ou trocar o provedor de IA do usuário. Oracle é o primeiro alvo de prova; a distribuição deve ser por arquitetura, não por provedor de nuvem.

## Estado medido em 2026-09-29 e lacunas

- As quatro imagens próprias (`deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`, `deskcomm-voice-agent`) publicadas em `:stable` têm apenas `linux/amd64`. O workflow `.github/workflows/publish-image.yml` compila apenas essa plataforma. O job de `stable` espera as quatro imagens, mas a checagem do kit verifica presença de tags, não a plataforma dentro do manifesto.
- `hostgator-setup-kit/_common.sh` recusa instalação nova em ARM64. Uma instalação ARM64 já existente pode entrar no caminho de recuperação por build local. Essa proteção deve ser preservada até existir release multi-arquitetura e então substituída por checagem da *versão alvo*.
- O WAHA Core padrão `devlikeapro/waha:latest-2026.7.2` é somente AMD64; `devlikeapro/waha:noweb-arm-2026.7.2` é ARM64. O compose usa NOWEB. Imagem WAHA explicitamente escolhida pelo operador não pode ser trocada em silêncio; deve ser validada ou recusada com instrução de correção. Sessões e volumes não devem ser apagados na troca de imagem.
- Os digests atuais de WaCalls e Asterisk, além de Redis, SRH e Caddy, já anunciam ARM64 e AMD64. Isso prova disponibilidade de imagem, não funcionamento completo de chamadas ou SIP na Oracle. O `voice-agent` próprio ainda precisa de build e smoke nativos ARM64.
- `install-single-server.sh` prepara e sobe o Supabase antes de chamar a instalação do CRM. As 11 imagens do Compose oficial da ref pinada `self-hosted/v0.8.1` anunciam ARM64 e AMD64, mas falta um gate no CI e um preflight antes de criar a rede, o banco e as credenciais locais. Um bump dessa ref deve refazer a conferência.
- O `update.sh` altera checkout e pode aplicar `baseline.sql` antes de puxar as novas imagens. Um manifesto ausente pode, portanto, ser descoberto tarde demais. O preflight precisa anteceder qualquer alteração no banco e qualquer parada de serviço.
- O instalador atual pode cair em `stable`, `latest` ou build local quando falta um conjunto publicado. Em ARM64 novo, isso não deve converter erro de publicação em build demorado, emulação ou mistura de versões.

### Atualização da base em 2026-09-30

O upstream incorporou o PR #1938 entre a redação e a aprovação deste documento. Na `main` em `79e0a6b13`, as quatro imagens já são construídas em runners AMD64 e ARM64; os quatro `:stable` públicos já anunciam ambas as plataformas; o kit aceita `aarch64`/`arm64` e seleciona WAHA NOWEB ARM. Esses itens deixam de ser implementação nova e passam a ser invariantes a preservar. As lacunas ainda abertas são: verificar *a arquitetura presente* em cada imagem da versão alvo antes de instalar/atualizar; impedir fallback silencioso a canal ou build local em ARM64; proteger single-server e update antes de efeitos; sondar o runtime do `voice-agent` e os perfis de voz; automatizar a conferência das imagens Supabase pinadas; e documentar/provar a jornada Oracle ponta a ponta. O plano deve trabalhar sobre essa `main`, sem duplicar o PR #1938.

## Desenho da publicação

1. Em PR que afete imagem, construir e executar sondas nativas nas duas arquiteturas, usando runners AMD64 e ARM64. O gate cobre boot do app, extração de PDF dentro do artefato, laço do `event_log` no worker, crontab do scheduler e boot/rota de saúde do `voice-agent`. O teste de voz que exige serviço externo fica em ambiente de integração, com resultado explicitamente separado do smoke sem credenciais. Não tratar `docker build --platform=linux/arm64` sem executar como prova de runtime ARM64.
2. Na `main` e nas tags de release, construir as quatro imagens por arquitetura e publicar digests específicos; montar um índice OCI multi-arquitetura por imagem somente depois de ambos os builds passarem. Publicar as tags numéricas a partir desses índices, nunca de uma variante isolada. Preservar o `APP_VERSION` igual nas duas arquiteturas e a identidade do commit.
3. Antes de promover `stable`, conferir por manifesto que **cada uma das quatro tags numéricas** contém `linux/amd64` e `linux/arm64`, e que os smokes das duas plataformas passaram. Não promover se qualquer uma falhar ou for pulada indevidamente. `latest`/`main` também não podem apontar para índice incompleto. A promoção de quatro tags no registry não é uma transação atômica; o instalador deve preferir um número de versão completo e fixá-lo nas quatro referências, nunca depender de quatro leituras independentes de `stable` em movimento.
4. Preservar o modelo de imagens genéricas, sem segredo de cliente embutido, publicação pelo CI upstream e tags de versão imutáveis. O fork do usuário não substitui automaticamente o namespace oficial de GHCR; PR e merge upstream são o caminho para suporte distribuído. Até lá, um fork pode publicar seus próprios artefatos sob namespace próprio, com as mesmas provas, mas não declarar o registry oficial como corrigido.

## Instalação, atualização e recuperação

- Normalizar arquitetura do host (`x86_64/amd64` e `aarch64/arm64`) num único helper. Arquitetura desconhecida é erro claro. Não usar emulação como caminho de produto.
- Resolver uma versão alvo única. Preflight consulta os manifestos das quatro imagens próprias para a arquitetura efetiva, valida a variante WAHA configurada e as imagens upstream usadas pelo modo escolhido. Diferenciar `tag inexistente`, `arquitetura ausente`, `registry inacessível` e `credencial necessária`. Falha de verificação não é sucesso presumido: encerrar antes de mudar estado, com próximo passo recuperável. Para um operador sem rede, permitir somente modo de recuperação explicitamente solicitado e verificável, sem mudar versão ou banco.
- Em ARM64 novo, default de WAHA = variante oficial NOWEB ARM da versão pinada; em AMD64 manter default atual. Se `WAHA_IMAGE` foi definida explicitamente, preservar e verificar. Em atualização de instalação ARM64 antiga com default AMD64 gravado no `.env`, oferecer migração segura e explícita para a variante ARM, mantendo volumes/sessões e fornecendo rollback; não substituir uma imagem Plus/licenciada por Core.
- `install.sh` faz o preflight antes de gravar referências de imagem, aplicar schema ou subir containers. `install-single-server.sh` o faz **antes** de baixar/rodar `setup.sh`, criar rede, credenciais e banco. O preflight do single-server acompanha a ref pinada e verifica o Compose efetivo, incluindo override, para não esquecer serviços novos. Se a verificação falhar, a VPS fica intocada.
- `update.sh` faz preflight da versão alvo e da arquitetura antes de checkout, backup condicionado à atualização, parada e `baseline.sql`. Depois, segue a ordem atual de backup, schema, pull, restart, saúde e reparo. Se uma falha posterior ocorrer, não vender “rollback de banco” automático: preservar backup, sinalizar estado parcial e orientar recuperação com comandos existentes. A atualização nunca faz downgrade silencioso nem mistura imagens de commits diferentes. Uma cópia antiga do `update.sh` não ganha preflight retroativamente; a primeira passagem de uma instalação legada exige um bootstrap documentado/validado que obtenha o kit novo antes de tocar no banco.
- Manter o caminho de recuperação de instalações ARM já existentes que dependem de build local; não removê-lo na virada. Uma release antiga sem ARM continua indisponível para instalação/rollback ARM normal. O CLI deve explicar isso antes de alterar o banco. AMD64 segue funcionando com os mesmos defaults.
- Ajustar mensagens, diagnóstico e documentação para recomendar Oracle Ampere sem prometer uma quantidade fixa de RAM ou latência. A instalação verifica memória, CPU, disco e arquitetura antes do modo single-server; o checklist de operação mede `docker stats`, swap/OOM, espaço e tempos de resposta, sobretudo com voz ativada.

## Serviços e prova de funcionamento

| Superfície | Aceite em ARM64 |
|---|---|
| App e IA | UI autenticada, criação/teste de agente, chamada ao provedor configurado, gravação de `ai_agent_runs` e `llm_calls`; em falha, registrar a causa e não contar a integração como validada. A credencial externa é necessária para o teste real. |
| Banco externo | Schema de instalação fresca, RLS cross-tenant, autenticação, Realtime e Storage. URL pública e segredos só em env/headers previstos. |
| Single-server | Supabase pinado sobe com Auth, REST, Realtime, Storage e Postgres saudáveis; onboarding e reexecução idempotente; 11 imagens oficiais e override rechecados após bump. |
| WhatsApp | WAHA NOWEB ARM pareia, recebe/envia mensagem, reinicia sem perder sessão, processa mídia e webhook com HMAC/idempotência; teste de canal real só com número autorizado. |
| Workers | `event_log` drenado pelo worker e fallback do scheduler; não basta `/healthz` verde com laço quebrado. |
| Voz WhatsApp | WaCalls no perfil `voz`, com chamada de ida/volta e mídia; verificar UDP 7881, segurança da VCN e firewall do Ubuntu, sem abrir portas extras por default. |
| SIP/telefonia | Asterisk e `voice-agent` no perfil `telefonia`, SIP/RTP (5060/UDP e faixa 10000–10200/UDP conforme compose), autenticação/trunk, handoff e tratamento de queda; imagens multiarch não bastam como prova. |
| Operação | Instalação fresca, update, backup/restore ensaiado, restart/reboot, diagnóstico e healthcheck em ARM64 e regressão AMD64. |

Os perfis de voz permanecem opcionais e desligados até configuração. O teste de aceitação distingue: (a) build/boot offline do artefato, (b) integração local com fixtures e banco limpo, (c) chamada real com serviços, credenciais e portas externos autorizados. Não marcar (c) como concluído com base em (a) ou (b). Para uma VM Oracle de 2 OCPU/12 GB, confirmar capacidade com carga representativa; Supabase self-hosted, CRM, WAHA e voz simultâneos podem disputar CPU apesar da RAM disponível. Se a margem não for suficiente, separar Supabase/voz ou ampliar OCPU sem mudar a arquitetura do produto.

## Testes, documentação e entrega

- Testes de shell cobrem detecção de arquitetura, defaults WAHA, imagem customizada, manifesto incompleto, registry indisponível, release anterior ao suporte ARM, single-server que falha antes de criar estado, e update que falha antes do schema. CI exerce o kit em ambas as arquiteturas onde houver lógica dependente de `uname -m`.
- `test:db` cobre schema/RLS se a implementação tocar migrations; `test:e2e` e prova visual cobrem a jornada de instalação/uso afetada; `test:shell` é obrigatório para kit, Compose ou Dockerfiles; `gov:verify` e smokes de imagem entram no fechamento. Testes em ARM real/runner ARM nativo, não só QEMU. Atualizar `docs/doctrine/packaging.md`, runbook de deploy/Oracle, matriz de compatibilidade e exemplos sem exigir edição manual de arquivos na VPS.
- Critério de publicação: um release só é anunciado como compatível após manifestos públicos de quatro imagens, todos os gates relevantes verdes e uma instalação limpa ARM64 comprovada até a UI. O teste de telefonia real só é anunciado quando executado com infraestrutura apropriada; caso contrário permanece “pendente de validação externa”, não “funcionando”.

## Sequência de implementação proposta

1. Escrever testes que falham para arquitetura/preflight e publicação incompleta; atualizar matriz de CI com runners nativos.
2. Produzir índices multiarch para as quatro imagens, validar o gate e a promoção de canais.
3. Tornar o kit sensível à arquitetura e à versão alvo; corrigir default WAHA e proteger single-server/update antes de mutações.
4. Completar documentação operacional e provas AMD64 + ARM64, incluindo perfis opcionais em ambiente que permita teste real.
5. Abrir PR ao upstream a partir de fork próprio do usuário, sem tocar na instalação em produção até release validada. Quando houver deploy Oracle, configurar VCN/firewall, domínio, TLS, backups e monitoramento; alterações no GitHub não fazem deploy automaticamente sem um mecanismo de atualização deliberado.

## Riscos e decisões pendentes de prova

- As imagens upstream foram verificadas por manifesto nesta data. Tags móveis ou um novo pin exigem nova verificação automática; manifesto não equivale a compatibilidade funcional.
- WAHA Plus ARM depende de imagem/licença privada e não foi validado. Preservar configuração explícita e não declarar suporte a Plus sem prova própria.
- O registry não promove quatro tags de maneira transacional. A proteção efetiva é pin por versão e preflight do conjunto antes da instalação/atualização.
- O caminho de voz real depende de conta/número, tronco SIP e regras de rede externos. Sem esses elementos, entregar suporte de imagem, boot e testes locais, mantendo a validação ponta a ponta aberta.
- A estratégia detalhada de CI deve manter os checks obrigatórios existentes (`imagens-ok`) e as regras de segurança de PR de fork: código não revisado não publica em GHCR oficial.
