# Plataforma de extensões — pesquisa de arquitetura

**14/set/2026. Arquitetura aprovada; bancada experimental executada, corrigida e revisada. Jornada integrada de extensões no CRM ainda pendente.**

Referência de código: `25edc35b05c8d522e2bfe313863e6003f47b8f56`, obtida de `origin/main` para esta pesquisa. Os caminhos e as linhas dos relatórios descrevem essa fotografia; outras branches ou commits podem ter comportamento diferente.

## Entrada para acompanhar e decidir

| Documento | Conteúdo |
|---|---|
| PROG-016 — Plano e andamento *(documento interno de decisão)* | Contexto, achados, estado da entrega e próximos passos |
| PROG-017 — Arquitetura e contratos *(documento interno de decisão)* | Síntese das alternativas e desenho recomendado |
| PROG-018 — Provas e sequência de entrega *(documento interno de decisão)* | Experimentos de viabilidade e jornadas planejadas em tela |
| DEC-004 — Publicação, incidentes e métricas *(documento interno de decisão)* | Escolhas de produto com alternativas, recomendação e espaço de resposta |

## Três investigações distintas e paralelas

| Frente | Responsabilidade |
|---|---|
| [1 — O que impacta](01-o-que-impacta.md) | Bases existentes que condicionam a nova plataforma: dados, acesso, eventos, agentes, navegação e distribuição |
| [2 — O que será impactado](02-o-que-sera-impactado.md) | Jornadas, componentes e compromissos que precisam continuar funcionando quando uma extensão entra, muda ou sai |
| [3 — O que pode impactar](03-o-que-pode-impactar.md) | Falhas futuras, dependências externas, alternativas de execução, compatibilidade, autenticidade e custo operacional |

Os relatórios foram produzidos por agentes distintos e reconciliados na síntese. Duas frentes também revisaram a proposta consolidada; as correções estão registradas na linha do tempo do PROG-016. Evidência de leitura não é prova de execução: **CONFIRMADO**, **INFERIDO** e **PROPOSTO** têm significados separados nos documentos.

## Escopo e preservação do trabalho existente

A pesquisa foi feita numa worktree própria, sem incorporar nem reverter alterações de outras sessões. As decisões que ela alimentou são documentos internos, fora deste repositório; o que vale para PR está na [doutrina de extensões](../../doctrine/extensoes.md) e na [ADR-0002](../../adr/0002-tabelas-de-modulo-num-banco-so.md).

O diagrama da proposta descreve responsabilidades futuras. Ele não foi publicado como mapa de componentes já operacionais, nem autoriza declarar a arquitetura implantada. Escolhas técnicas que dependem de medição permanecem explícitas no plano de provas.

## Experimentos implementados

| Relatório | Alcance |
|---|---|
| [04 — Executor](04-bancada-executor.md) | Wasmtime concreto, capacidades sintéticas, limites e caminhos próprios |
| [05 — Eventos](05-bancada-eventos.md) | Captura/entregas, concorrência, retomada e efeito HTTP incerto |
| [06 — Estado e dados](06-bancada-estado-e-dados.md) | Compatibilidade real de tarefa antiga, RLS da fixture, desativação e anonimização |
| [07 — Perfil de contêiner](07-perfil-comparacao-executor.md) | Imagem fixa, rodada Docker real, limites exercitados e comparação delimitada |

O [runbook da bancada](../../../experiments/extensoes/README.md) permite repetir os experimentos em ambiente próprio. O PROG-020 *(documento interno de decisão)* é a síntese para acompanhar a execução sem ler o código.

## Primeira integração ao CRM

A bancada foi preservada na branch deste PR, que incorpora `origin/main`. O PROG-021 *(documento interno de decisão)* acompanha implementação e provas do marco 2. O [contrato v1](../../specs/extensoes-declarativas-v1.md) define o pacote declarativo, admissão e jornada.

| Investigação | Foco desta integração |
|---|---|
| [08 — Bases](08-integracao-bases.md) | Skills, download, confiança e operações existentes |
| [09 — Impactos](09-integracao-impactos.md) | RLS, navegação, auditoria e consumidor em Tarefas |
| [10 — Riscos](10-integracao-riscos.md) | Parser, compatibilidade, rede e recuperação |

A persistência foi implementada e revisada; a jornada integrada em tela continua pendente de execução. O catálogo público e o perfil de código externo continuam fora desta entrega.
