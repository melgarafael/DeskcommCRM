# Temas de apresentação

Um tema altera a apresentação de áreas que oferecem um adaptador. O host mantém dados, ações, permissões e componentes funcionais; o pacote declara composição e estilos. A distribuição pública incorpora somente **Padrão**, que referencia a interface nativa completa. Uma página sem contribuição continua usando essa interface.

Este contrato é uma capacidade de núcleo incorporada ao build. Ele não modifica o ABI das extensões declarativas v1 de `lib/extensions`, não instala JavaScript pelo painel e não oferece upload de código, marketplace ou editor visual. Instalar um pacote exige revisar seus fontes e construir uma imagem. O painel **Configurações → Marca** permite à organização selecionar os pacotes incorporados e habilitados nessa imagem.

## Arquivos e responsabilidades

| Arquivo                                                            | Papel                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `lib/ui-themes/contracts.ts`                                       | Schemas dos pacotes, opções e composição; compatibilidade de área |
| `lib/ui-themes/registry.ts`                                        | Catálogos extensíveis de temas e áreas; Padrão obrigatório        |
| `lib/ui-themes/installed.ts`                                       | Decisão da instalação sobre pacotes incorporados                  |
| `lib/ui-themes/areas.ts`                                           | Contratos versionados dos adaptadores                             |
| `lib/ui-themes/resolve.ts`                                         | Seleção, defaults, fallback e classes finitas                     |
| `ui-themes/padrao/definition.ts`                                   | Referência comentada, herdando o JSX nativo                       |
| `components/ui-themes/Provider.tsx`, `Area.tsx`                    | Contexto e composição de regiões prontas                          |
| `components/ui-themes/ThemeEditor.tsx`                             | Rascunho, prévia, aplicar e cancelar                              |
| `lib/ui-themes/server.ts`, `app/actions/settings/updateUiTheme.ts` | Leitura e aplicação autorizadas                                   |

## Contrato v1

`UiThemePackage` declara `apiVersion: 1`, `id` estável, título, versão semântica, descrição, `optionsVersion`, opções, base global opcional e contribuições por identificador de área. O catálogo não contém uma lista fechada de páginas ou um limite de dois temas.

Cada `UiAreaContract` identifica versão, regiões aceitas, slots e slots obrigatórios. O host entrega `ReactNode`s já preparados e o fallback nativo a `UiThemeArea`. A árvore de composição usa `row`, `stack`, `grid` e folhas `slot`. Ela não recebe banco, credencial, função de negócio, HTML arbitrário ou novo poder de execução. Slot desconhecido, repetido, ausente ou versão incompatível faz a área voltar à composição nativa completa.

Regiões internas podem consumir `useUiThemeArea(contract).regionClass(name)`. Não existe acesso estável a um seletor interno não declarado: acrescentar uma área exige seu adaptador e contrato, preservando os handlers existentes. As contribuições devem aceitar responsividade e estados vazios, carregando, erro e sem permissão.

Classes vêm de CSS Modules compilados e revisados. Opções são `boolean`, `enum` ou `range`, com defaults e limites, em namespaces `global.<chave>` ou `<area>.<chave>`. `variants` escolhe classes em um mapa finito; valores gravados nunca viram CSS ou seletor livre. Estilos de uma área ficam sob seu escopo. A base `global` pode declarar classes/variantes globais e tokens aceitos pelo validador nativo, preservando marca e claro/escuro. Tokens ativos alcançam os portais do host; os da prévia ficam no documento isolado da prévia.

## Adaptador do inbox

`inbox` oferece os slots obrigatórios `list`, `conversation` e `contact`, além das regiões internas `start`, `filters`, `list-item`, `header`, `history`, `composer`, `bubble-in` e `bubble-out`. Os slots contêm os componentes nativos completos. Busca, seleção, atalhos, splitters, diálogos, estados de envio e permissões permanecem sob controle do host.

Sua `configuration` aceita somente as chaves de `inboxPresentationSchema`: `initialFilter` (um dos seis recortes nativos), `allTabFirst`, `contactMode` (`native` ou `adaptive`), `initialContactPinned`, `listWidth`, `detailWidth` e `minimumConversationWidth`. O schema publica limites numéricos. A entrada inicial respeita os recortes permitidos ao papel e um filtro explícito na URL. `{}` conserva a apresentação e as preferências nativas.

O modo adaptativo mede a largura útil da raiz, preserva uma largura mínima de leitura e oferece ficha fixa, recolhida ou sobreposta conforme o espaço. Preferência de ficha e larguras pertence à combinação organização + usuário + área; não é opção empresarial. Bloqueio do armazenamento conserva os controles utilizáveis na sessão. A composição nunca remonta o editor para apenas fixar ou recolher a ficha.

Partes estáveis do editor: `data-ui-part="composer-input"`, `composer-modes` e `reply-review`; a raiz publica `data-ui-mode="reply" | "note"`. Use esses pontos sob a região `composer`. Preserve o significado visual da nota, as advertências, a sugestão expandida e seus controles de aprovação. Não oculte ações ou estados para ganhar espaço.

Para adaptadores próprios, `rootProps`, `slotProps` e `after` de `UiThemeArea` são entradas exclusivas do host: preservam refs, atributos, medidas e complementos na raiz real da composição. Não pertencem ao manifesto do pacote. `validateConfiguration` também é função pura do contrato do host, nunca código recebido do pacote. Mudança incompatível de validação ou semântica exige nova versão do contrato; a função não é serializada no catálogo mostrado ao editor.

## Seleção, segurança e retorno

Uma entrada instalada tem `installationId`, `enabled` e o pacote. Padrão é sempre disponível. Ausência, remoção, desativação ou identidade de instalação diferente deixam a seleção salva preservada, mas usam Padrão com diagnóstico na Marca. Reinstalação usa identidade nova e exige aplicação explícita. Atualização compatível conserva a identidade; mudar a forma das opções exige incrementar `optionsVersion`. Não reutilize uma entrada antiga como procedimento de reinstalação.

`organization_ui_themes` guarda uma linha por organização, configurações separadas por tema, revisão e recibo do último pedido. Trocar para Padrão conserva opções de outros temas. Não grave a seleção no JSON de configurações gerais nem diretamente pelo navegador.

A action resolve usuário/organização da sessão, confere administração da empresa, suporte, MFA, catálogo e opções. A RPC é exclusiva de `service_role` e revalida organização/papel no banco sob lock. Escrita compara revisão; concorrência pede recarregar. Repetir o último pedido idêntico devolve o recibo sem nova revisão/auditoria. Mesmo identificador com conteúdo diferente é conflito. A auditoria `ui_theme.updated` é atômica e registra identificação/versão/revisão, sem conteúdo empresarial.

## Editar e conferir

Selecionar um tema ou mudar opções edita o rascunho. A prévia usa componentes reais e dados sintéticos em documento isolado; claro/escuro e largura da prévia não mudam a preferência ativa. **Cancelar** restaura o rascunho. **Aplicar tema** valida/grava e atualiza a interface. Erro conserva a edição e informa a causa.

A amostra não substitui a conferência do fluxo autenticado nas áreas reais. Antes de distribuir uma imagem, valide suas regiões/ações, mobile, contraste, retorno ao Padrão, persistência após recarregar e isolamento entre organizações. Testes dirigidos de contrato, editor, action e banco estão junto aos respectivos fontes e em `tests/invariants/ui-theme-selection.test.ts`. A interface precisa também de prova no navegador.

## Sistema vivo

Entrada: catálogo da imagem e escolha administrativa da organização. Saída: loader SSR, editor e regiões de apresentação. O [mapa de arquitetura](../architecture/ui-themes.architecture.json) mostra essas conexões e a volta de recibos/falhas ao editor.

A mutação emite `ui_theme.updated` na mesma transação; o painel nativo de auditoria usa o catálogo canônico de ações para leitura e filtro. Não há uma demanda comercial nova, troca de controle IA/humano, cron, worker ou efeito em mensagens. Contextos e próximos passos existentes permanecem nos componentes/handlers do host. Criar um evento de atendimento para uma escolha visual não teria consumidor ou finalidade.

Toda configuração suportada tem leitura, escrita e erro visível na Marca. Fallback informa sua razão e mantém o estado anterior para correção administrativa. A decisão automática de fallback termina em um diagnóstico acionável pelo administrador; ela não altera critérios de agentes nem oferece aprendizado de negócio. A aplicação explícita/revisão do catálogo é o retorno desse ciclo.

## Kit para autores

Leia [AUTHORING.md](AUTHORING.md) para copiar o exemplo público, compor regiões, registrar outra área e manter versões/remoção. A prévia da Marca oferece amostras das áreas iniciais; Restaurar opções muda somente o rascunho, que ainda precisa de Aplicar para ser salvo.

O catálogo público canônico fica em `lib/ui-themes/public-catalog.ts`; a entrada pública de `installed.ts` o reexporta. Testes do contrato usam essa referência; cada distribuição confere também sua entrada efetiva. A prova do artefato público precisa excluir fisicamente os fontes privados.
