# Criar e manter um tema

Comece por [README.md](README.md) e `ui-themes/padrao/definition.ts`. Padrão herda a composição nativa completa: não é necessário copiar páginas inteiras para preservar recursos. `ui-themes/author-template/` é um exemplo copiável, sem entrada instalada no catálogo público.

## Um primeiro pacote

1. Copie `ui-themes/author-template/` para um diretório próprio; altere o identificador estável, título, descrição e versões. Use o schema público para validar o manifesto na importação.
2. Escolha uma região declarada em `lib/ui-themes/areas.ts`. O exemplo muda somente tipografia do cabeçalho do inbox e oferece uma opção finita. Páginas/áreas ausentes conservam Padrão.
3. Escreva CSS Module local, respeitando os tokens nativos de marca, texto e superfícies. Não use seletores globais para alcançar outra área, dados empresariais, URLs externas ou regras que ocultem controles/avisos. Verifique claro/escuro, contraste de texto e estados de erro/permissão.
4. No catálogo da instalação `lib/ui-themes/installed.ts`, importe o pacote e acrescente uma entrada habilitada com `installationId` próprio. Preserve Padrão e use o construtor `createUiThemeCatalog`. O painel não instala fontes ou executa código enviado por usuário.
5. Construa a imagem pelo fluxo oficial da instalação. Na Marca, edite o rascunho, visualize as áreas e larguras pertinentes, cancele e aplique. Confirme pelo fluxo autenticado da página e após recarregar; a amostra é de dados fictícios, sem comandos de negócio.

O exemplo não é uma segunda entrada da distribuição pública. Um exercício de autoria pode registrá-lo temporariamente em um teste/checkout de QA; não altere o catálogo de produção para demonstrar o contrato.

## Compor sem substituir ações

O host declara um `UiAreaContract`, prepara os componentes e fornece slots, `rootProps`, `slotProps`, elementos complementares `after` e fallback completo. O pacote pode reorganizar os slots em `row`, `stack` ou `grid`; cada slot só aparece uma vez. Slots obrigatórios continuam presentes. Opções são valores validados, nunca fragmentos de CSS livre.

`regions` oferece classes de partes visuais. Cada região aceita `className` e mapas `variants` de opção→valor→classe. `global` também aceita variantes; a contribuição da área usa `className`, `layout`, `regions` e `configuration`. Variantes não pertencem diretamente ao objeto da área. Uma classe só é aplicada quando seu valor pertence ao mapa fechado.

O nó raiz recebe os atributos/handlers/refs do host, inclusive medição e realtime. Conteúdo complementar precisa ser renderizado uma vez; não copie modais, composer, callbacks ou verificações de permissão dentro de um pacote. Elementos internos marcados pelo adaptador, como `data-ui-part` e `data-ui-mode`, são parte de sua superfície documentada. Não dependa de nomes de classes gerados por outro CSS Module.

## Capacidades das áreas iniciais

| Área     | Slots                                            | Regiões e configurações                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox    | list, conversation, contact obrigatórios         | Consulte `inboxArea` e `inboxPresentationSchema`. Filtros, cabeçalho, histórico, editor, ficha e balões têm regiões. Configurações incluem filtro inicial/ordem, modo e dimensões da ficha, largura de lista e piso da conversa, dentro dos limites do schema.            |
| Pipeline | toolbar, board obrigatórios                      | Regiões de barra, quadro, coluna, card, estado e score. `pipelinePresentationSchema` descreve capacidades de apresentação. A edição decorativa de cor usa a rota nativa e continua exigindo permissão de gerente; o tema não concede acesso nem altera score/ganho/perda. |
| Calendar | controls e content obrigatórios; notice opcional | Regiões de filtros, aviso, conteúdo, evento, histórico, grade e lista do período. `calendarPresentationSchema` fecha as opções de apresentação. A disponibilidade continua no contrato nativo de serviço, não no tema.                                                    |

Os schemas dos adaptadores são a referência dos nomes, tipos e limites. Um campo desconhecido ou uma versão incompatível faz a área voltar ao fallback completo. O host fornece apenas dados já autorizados e preserva fuso/escopo. Temas não consultam banco, alteram revisores, fazem reservas nem inventam disponibilidade.

Partes do inbox incluem `composer-input`, `composer-modes`, `reply-review`, `data-ui-mode` e os modos de contato publicados por seu adaptador. Parte do card: `card-title` e `data-ui-state`; a borda semântica nativa e as ações de revisão continuam visíveis. A variável `--ui-stage-color` recebe somente uma cor decorativa validada, mantendo estado e decoração independentes.

## Acrescentar outra área

Defina um contrato com identificador/versão, regiões, slots obrigatórios/opcionais e, quando necessário, `validateConfiguration` puro. Registre-o com `createUiAreaCatalog`; envolva a composição existente em `UiThemeArea`, fornecendo fallback e componentes funcionais prontos. Um pacote pode oferecer apenas parte das áreas. Não há limite de três páginas ou dois temas no motor.

A página sem contribuição precisa continuar usando Padrão. O editor recebe o catálogo e descreve a cobertura; áreas sem amostra de prévia própria pedem a conferência da página real. Acrescentar um adaptador é trabalho de produto com inventário de ações/permissões, não uma alteração do motor de seleção nem autorização para reformular todas as páginas.

## Atualizar, desativar e remover

Atualização compatível preserva `installationId`, mantendo seleção e opções. Use `version` para a versão do pacote; incremente `optionsVersion` quando mudar a forma/significado das opções salvas. Defaults novos são validados; opções inválidas geram diagnóstico no painel. Alterar o contrato incompatível de uma área exige versão nova do adaptador e de suas contribuições.

Desabilitar/remover a entrada preserva a seleção salva e usa Padrão com diagnóstico. Reinstalação recebe identidade nova e exige aplicação explícita. Não reutilize identidade antiga para reativar silenciosamente uma instalação removida. Trocar para Padrão conserva as opções de outros temas e é o primeiro retorno visual; reversão de imagem segue a operação da instalação, sem restaurar banco automaticamente.

## Conferir a entrega

Um administrador pleno pode usar o pacote incorporado como tema inicial em **Administração → Marca**. A identidade instalada, a versão das opções e a seleção visual são copiadas para cada organização criada depois do salvamento. Não é instalação dinâmica nem mudança forçada das empresas existentes. Ao atualizar/remover um pacote, confira também o padrão inicial e seu diagnóstico nessa tela; não reutilize uma identidade antiga para reativar um pacote removido.

Valide schema, compatibilidade das áreas, defaults/valores inválidos e fallback. Confira a seleção por organização, concorrência/auditoria e retorno ao Padrão no recorte afetado. No navegador, prove as ações nativas, teclado, layouts estreitos, texto longo, estados vazios/erro e claro/escuro. A prévia isolada serve à aparência; não comprova entrega a provedores ou execução empresarial.

Para distribuir uma variante pública, prepare catálogo, fontes, contexto de build, imports, histórico e evidências sem pacotes/dados privados. Confira fisicamente o público sem esses fontes; ocultar uma opção no seletor não remove seu código do artefato. Use evidência genérica. Não publique uma branch privada como ancestralidade da contribuição.
