# Extensões — investigação 3: o que pode impactar a sustentabilidade

**Data:** 14/09/2026. **Base examinada:** `main` em `25edc35b05c8d522e2bfe313863e6003f47b8f56`. **Estado:** pesquisa e proposta; nenhum executor, instalador ou marketplace foi implementado ou validado em tela nesta investigação.

`CONFIRMADO` identifica código ou documentação primária examinados; `INFERIDO` identifica consequências desses fatos; `PROPOSTO` identifica desenho a validar. As fontes externas foram consultadas em 14/09/2026; páginas sem data editorial explícita são referências vivas, não compromissos de versão.

## Resultado recomendado

**PROPOSTO:** construir um contrato de capacidades independente do executor. Começar com contribuições declarativas e módulos oficiais delimitados; provar funções isoladas antes de aceitar código externo; reservar aplicativos em contêiner para necessidades que realmente exijam processos persistentes, bibliotecas nativas ou protocolos próprios. Não fazer cada extensão equivaler a um serviço permanentemente ligado.

O protocolo define comandos, eventos, permissões e respostas. O executor define onde o código roda e seus limites. HTTP, RPC ou MCP não conferem isolamento por si mesmos. Essa separação permite trocar o executor mantendo o contrato público, sem obrigar o núcleo a conhecer a implementação de cada nicho.

O catálogo compartilhado atende descoberta, distribuição e reputação. O funcionamento já instalado pertence à VPS. Falha de catálogo, identidade comunitária ou métricas não pode impedir atendimento local.

## Três caminhos viáveis, com custos diferentes

| Abordagem | Vantagem | Limite e custo | Papel recomendado |
|---|---|---|---|
| Módulos nativos na release do CRM | Reutilizam componentes e serviços atuais; instalação segue o kit existente | Compartilham processo e dependências; correção exige release do CRM; desativação não remove código da imagem | Transição e capacidades oficiais que exigem integração profunda |
| Pacotes declarativos + funções isoladas | UI coerente; arquivos pequenos; funções podem executar sob demanda; versão independente possível | Contrato de telas pode ficar pobre ou virar linguagem excessiva; sandbox, dados e ferramentas exigem implementação real | Caminho principal a provar para especializações comuns |
| Aplicativos/contêineres isolados | Dependências e ciclos de versão próprios; acomodam operações persistentes | Mais RAM, disco, conexões, atualizações, backups e supervisão; isolamento depende da configuração | Perfil adicional para casos que excedam o anterior |

**INFERIDO:** nenhum caminho satisfaz sozinho toda extensão imaginável. Um catálogo pode distribuir os três, deixando o perfil explícito e preservando a experiência de instalar. A primeira versão deve implementar somente os perfis comprovados, com erro compreensível para os demais; uma interface abstrata não prova suporte.

## UI e execução: fronteiras que não podem ser confundidas

**CONFIRMADO:** [next.config.ts](../../../next.config.ts) usa `standalone` no self-host; o [Dockerfile](../../../Dockerfile) copia o resultado compilado e os assets. O arquivo de configuração registra falhas reais de dependências nativas que o rastreamento não incluiu. A documentação do Next confirma a seleção de arquivos durante o build. [Next: output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output).

O Next atual também documenta `turbopackIgnore`/`webpackIgnore` para imports em runtime e `turbopackOptional` para módulos ausentes no build. Portanto, afirmar que import dinâmico é impossível seria incorreto. **INFERIDO:** isso não entrega automaticamente novas rotas, Server Actions ou integração de componentes RSC/React no shell compilado; também não isola código. Os guias locais de `node_modules/next/dist/docs/` foram consultados no checkout principal, porque este worktree não tem dependências instaladas. [Next: lazy loading](https://nextjs.org/docs/app/guides/lazy-loading).

**PROPOSTO:** primeiro, telas compostas com componentes e ações versionados do host, sem CSS global ou acesso livre ao DOM. Evitar construir uma linguagem que tente representar qualquer aplicativo: quando os pilotos excederem esse contrato, avaliar UI externa isolada, com origem e troca de mensagens restritas, autenticação própria e limites de navegação. Um iframe exige trabalho de acessibilidade, altura, foco, downloads e sessão; não basta encaixá-lo visualmente.

**CONFIRMADO:** VS Code protege sua evolução visual ao impedir acesso direto ao DOM e oferecer pontos de contribuição; Grafana executa backends em subprocessos e negocia versões de protocolo. São referências de fronteiras, não arquiteturas prontas para copiar. [VS Code: capacidades](https://code.visualstudio.com/api/extension-capabilities/overview), [Grafana: backend](https://grafana.com/developers/plugin-tools/key-concepts/backend-plugins), [Grafana: protocolo](https://grafana.com/developers/plugin-tools/key-concepts/backend-plugins/plugin-protocol).

**CONFIRMADO:** Node 22 declara que `--permission` não protege contra código malicioso. `node:vm` não é mecanismo de segurança; `node:wasi` também adverte contra seu uso para código não confiável. Assinatura, TypeScript e revisão não mudam essas propriedades. [Node: permissões](https://nodejs.org/docs/latest-v22.x/api/permissions.html), [Node: vm](https://nodejs.org/api/vm.html), [Node 22: WASI](https://nodejs.org/download/release/latest-v22.x/docs/api/wasi.html).

**PROPOSTO:** funções curtas podem ser candidatas a WASM num executor supervisionado, sem credenciais do CRM, filesystem ou rede implícitos. Wasmtime documenta isolamento, capacidades de filesystem e interrupção por combustível ou épocas; Extism oferece manifesto com limites e funções fornecidas pelo host. Isso indica viabilidade técnica, não prova economia ou segurança da combinação que adotarmos. Implementações/SDKs têm diferenças; não transferir garantias do Wasmtime para qualquer biblioteca JavaScript com “WASM” no nome. [Wasmtime: segurança](https://docs.wasmtime.dev/security.html), [interrupção](https://docs.wasmtime.dev/examples-interrupting-wasm.html), [Extism: manifesto](https://extism.org/docs/concepts/manifest/), [funções do host](https://extism.org/docs/concepts/host-functions/).

O supervisor precisará limitar compilação, memória, duração, tamanho de entrada/saída e concorrência. Combustível de WASM não limita automaticamente uma chamada HTTP fornecida pelo host. Chamadas externas precisam de prazo e cancelamento; efeitos já enviados precisam de reconciliação. Pools/cache de módulos não podem reutilizar estado de uma organização em outra.

Para aplicativos, propor contêiner sem privilégios, sem Docker socket, sem ambiente completo do CRM e sem conexão administrativa ao banco. Rede apenas para o intermediário de capacidades e destinos autorizados. Instalar contêiner é tarefa de um supervisor estreito; conceder controle geral do Docker ao processo web ampliaria sua autoridade. Contêineres compartilham kernel e precisam de hardening e atualizações. [Docker: segurança](https://docs.docker.com/engine/security/).

## Compatibilidade tem mais de uma versão

**PROPOSTO:** registrar separadamente versão do pacote, formato do manifesto, API pública de capacidades, representação de UI, executor/ABI e schema dos dados. A versão comercial do CRM continua seguindo a [doutrina de versionamento](../../doctrine/versionamento.md); não substitui esses contratos.

Faixas declaradas são intenção; uma matriz de testes registra combinações comprovadas. Instalar/atualizar resolve o conjunto completo de dependências antes de alterar a instalação, grava versões e digests exatos e rejeita ciclos, requisitos incompatíveis e permissões obrigatórias desconhecidas. Nada de atualizar dependência compartilhada silenciosamente para satisfazer o último pacote.

O começo mais simples é uma versão ativa de cada pacote por instalação, com ativação, configurações e permissões separadas por organização. Versões simultâneas por organização multiplicam compatibilidade de dados e workers; só devem entrar com necessidade e prova próprias.

Comunicação ocorre por capacidades públicas, com identificadores sob namespace do publicador; não por imports internos, DOM, tabelas de outro módulo ou ordem de instalação. Campos aditivos não podem reinterpretar valores antigos. Remover capacidade exige depreciação, caminho de migração e prazo de suporte publicado — a duração depende da capacidade real de manutenção, ainda não medida.

## Dados e rollback: conflito real com o modelo atual

**CONFIRMADO:** [CLAUDE.md](../../../CLAUDE.md) exige migration, apêndice idempotente no baseline e MANIFEST juntos. [agent.sh](../../../hostgator-setup-kit/agent.sh) restaura imagens anteriores de app/worker/scheduler quando disponíveis; não restaura o banco. Desativar uma extensão não torna seus registros descartáveis.

Há duas opções distintas. Manter schema oficial no baseline preserva o instalador atual, mas todos os bancos recebem essas estruturas e sua evolução continua vinculada ao CRM. Instalar schema específico somente com o pacote exige runner, inventário, recuperação e backup próprios, além de revisão explícita da doutrina atual. **Não existe dispensa automática porque chamamos a mudança de “plugin”.**

**PROPOSTO:** primeiros pacotes reutilizam capacidades e armazenamento já contratados, sem SQL arbitrário. Schema novo de módulo oficial segue os três artefatos vigentes. Um armazenamento genérico também precisa de schema central e DIRC; JSON livre não resolve modelagem. Se pilotos exigirem schema verdadeiramente independente, desenhar a mudança doutrinal e operacional antes de abrir essa superfície a terceiros.

Atualização prepara pacote, verifica pré-condições, aplica migração compatível, valida e só então ativa. Migrações devem permitir convivência temporária entre código anterior e novo quando houver rollback de código. Transformação irreversível exige recuperação por avanço ou restauração coordenada; backup sem ensaio não é garantia. Workers em andamento e dependências entram no plano. Reverter código jamais repete automaticamente pagamento, mensagem ou outra ação cuja execução ficou incerta.

## Distribuição, autenticidade e funcionamento sem catálogo

**PROPOSTO:** separar API de catálogo/reputação do armazenamento dos artefatos. Publicação produz pacotes imutáveis em CI, com origem, licença, dependências e inventário de componentes. O cliente fixa versão e digest; downloads passam por limites de tamanho e extração segura antes da ativação.

**CONFIRMADO:** um digest OCI identifica os bytes e permite detectar alteração quando recebido por canal confiável. Sozinho, não prova quem publicou. Índices OCI descrevem variantes de arquitetura; a existência de uma imagem não prova suporte a todas. [OCI: descritores](https://github.com/opencontainers/image-spec/blob/main/descriptor.md), [índice](https://github.com/opencontainers/image-spec/blob/main/image-index.md).

São três afirmações diferentes: “estes bytes correspondem ao hash”, “este publicador os assinou” e “este catálogo os autoriza agora”. Catálogo assinado que vincula identificador, versão e digest já autentica o artefato em relação ao catálogo. Assinatura própria do pacote acrescenta procedência transportável entre catálogos; não é automaticamente necessária para duplicar a mesma confiança.

**PROPOSTO:** avaliar TUF para autorização e atualização do catálogo; Sigstore/Cosign para procedência dos pacotes. TUF 1.0.36, de 05/08/2026, especifica papéis separados, expiração, versões e rotação encadeada de raízes para enfrentar replay e congelamento de metadados. Cosign verifica identidade/emissor ou chave e oferece verificações locais/bundles. Nenhum atesta ausência de bugs. Preferir implementação mantida a recriar criptografia ou um subconjunto informal de TUF. [TUF](https://theupdateframework.github.io/specification/v1.0.36/), [Cosign](https://docs.sigstore.dev/cosign/verifying/verify/).

Manter raízes confiáveis, histórico de rotação, digests e pacote anterior localmente. Expiração de metadados impede novas decisões de instalação quando a confiança não pode ser renovada; não desliga extensão já aprovada. Indisponibilidade, relógio incorreto, assinatura inválida e incompatibilidade precisam de mensagens distintas. Sem rede não é possível conhecer revogações novas; a interface deve mostrar a data da última verificação, sem alegar proteção atualizada.

Reinício local precisa usar artefatos presentes, sem pull obrigatório. A [doutrina de packaging](../../doctrine/packaging.md) já registra que `pull_policy: always` pode impedir subida mesmo com imagem no disco. Catálogos privados/instalação por arquivo devem preservar verificação e origem; não ser um caminho silencioso para ignorar o contrato.

## Custo de VPS e custo de manter a comunidade

**CONFIRMADO:** [docker-compose.prod.yml](../../../docker-compose.prod.yml) fixa limites de memória em serviços atuais; [.github/workflows/publish-image.yml](../../../.github/workflows/publish-image.yml) publica `linux/amd64`. Esses limites e os picos comentados são contexto existente, não orçamento medido para extensões. Docker não limita automaticamente o consumo de CPU por contêiner. [Docker: recursos](https://docs.docker.com/engine/containers/resource_constraints/).

**PROPOSTO:** medir CPU, memória residente/pico, disco, conexões e latência no host suportado, com carga concorrente do CRM e falhas provocadas. Incluir download, descompressão, migração, compilação WASM, execução e atualização; memória virtual reservada não equivale a RAM residente. Não prometer número de extensões nem requisito de RAM antes desse ensaio.

Carregar funções sob demanda, limitar pools e desligar executores ociosos quando aplicável. Apps persistentes declaram necessidade e têm quotas. Cinquenta extensões instaladas não devem produzir cinquenta servidores vazios. Reservar espaço para atualização e recuperação; limpeza não remove a única versão recuperável. ARM exige publicação e ensaio próprios, inclusive do runtime WASM e dependências nativas.

O serviço público terá custos de transferência, armazenamento, CI, backups, abuso e moderação. Dimensionar pelos pacotes e tráfego medidos; não escolher hospedagem com base em “gratuito para sempre”. Open VSX comprova que registro aberto pode ser independente dos clientes, com instâncias privadas; também explicita responsabilidade dos publicadores e tratamento de abuso. Isso é referência de operação, não indicação para reutilizar seu backend inteiro. [Projeto Open VSX](https://projects.eclipse.org/projects/ecd.openvsx), [FAQ, atualizado em 08/05/2024](https://www.eclipse.org/legal/open-vsx-registry-faq/).

## Estrelas e métricas sem inventar uma população conhecida

**PROPOSTO:** avaliações autenticam uma identidade comunitária central, independente do administrador local. Uma avaliação editável por conta/extensão, acompanhada de quantidade, versão e data; denúncia, decisão de moderação e resposta fecham o ciclo. Autodeclaração “instalei” não equivale a compra verificada: quem controla a VPS pode modificar o código e simular recibos. Múltiplas contas continuam possíveis.

Downloads incluem atualizações, cache, reinstalações e automação. Relatos de instalação incluem somente quem participou. Sinal periódico indica relato recente, não uso efetivo. Ausência de sinal pode significar falha, desligamento da telemetria ou falta de rede; não deve ser contada automaticamente como abandono.

**CONFIRMADO:** o [manual do Sistema Vivo, capítulo 7](../../doctrine/sistema-vivo/07-o-projeto-como-sistema.md) exige consentimento, campos declarados, desligamento e agregado público, além de proibir identificadores que reconstruam identidade. Seu quadro “telemetria não existe” está desatualizado frente ao [README](../../../README.md): existe opt-in para erros Sentry. Esse consentimento não cobre métricas de adoção.

**PROPOSTO:** iniciar com downloads e avaliações; métricas de adoção exigem consentimento independente e desenho específico. Identificador persistente, mesmo aleatório ou hasheado, pode permitir correlação; não chamá-lo de anônimo. IPs nos logs de infraestrutura e combinações raras também contam. A distinção entre anonimização e pseudonimização está no [glossário da ANPD](https://www.gov.br/anpd/pt-br/documentos-e-publicacoes/glossario-anpd); consentimento não elimina essa distinção.

Preferir agregação local e relatos sem ligação longitudinal para o primeiro ensaio, reconhecendo que deduplicação e retenção exatas ficam indisponíveis. Publicar campos, retenção, limitações e agregados; não coletar eventos individuais de clientes. Um desenho com ID estável exigiria revisar a tensão com a doutrina e obter nova decisão de produto. Conta comunitária e avaliações têm sua própria superfície de privacidade; não precisam se vincular à identidade da VPS.

## Laços de retorno e provas que faltam

**PROPOSTO:** falha de instalação mantém a versão anterior e oferece correção visível. Falha repetida de execução pausa aquela capacidade, preserva demanda e entrega contexto a um responsável. A retomada exige corrigir causa ou reconhecer condição; não apenas limpar o alerta. Usar a [Central de Avisos na referência desta pesquisa](https://github.com/melgarafael/DeskcommCRM/blob/25edc35b05c8d522e2bfe313863e6003f47b8f56/docs/architecture/central-avisos.architecture.json), auditoria e timeline existentes como destinos a integrar, com entrada pelo registro de navegação. São integrações propostas, ainda não implementadas.

Antes de abrir publicação externa, faltam estas provas:

1. Jornada em tela: buscar, compreender permissões, instalar pacote novo sem rebuild do CRM, configurar, usar, atualizar, desativar e recuperar histórico.
2. Duas organizações: combinações diferentes, revogação de acesso, ausência de vazamento e execução concorrente.
3. Interrupção: queda de rede, disco cheio, falta de RAM, reinício durante migração, dependência incompatível e efeito externo de resultado incerto.
4. Confiança: pacote alterado, metadados antigos/expirados, rotação após longo período offline e restauro local com catálogo indisponível.
5. Operação visual: mensagens em português, marca própria, foco, responsividade, estados vazios e responsável capaz de resolver a falha sem terminal.
6. Piloto representativo de função isolada e app persistente, com medições e tentativa explícita de ultrapassar permissões e limites.

Testes automáticos sustentam essas provas e impedem regressões; não substituem percorrer a experiência real. Nenhuma delas foi executada por este relatório.

**Decisões genuínas do dono:** compromisso de manutenção do catálogo/curadoria; política futura de retirar versões maliciosas já instaladas, preservando soberania e explicando riscos; eventual coleta longitudinal que altere a doutrina. Selecionar biblioteca, definir namespaces e escolher formato interno são trabalho técnico. MIT e gratuidade já são direção do produto; abrir exceções de licença exigiria decisão própria, nunca suposição.
