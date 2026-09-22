---
name: deskcomm-especialista
description: 'Torna Claude especialista no DeskcommCRM antes de implementar — arquitetura, padrões de UI/UX, padrões de criação de agentes de IA e o que a distribuição open-source/self-host exige. USE SEMPRE antes de começar QUALQUER implementação, melhoria, feature nova, redesenho de tela, ou criação/edição de agente de IA/prompt/roteador neste repositório — mesmo que a pessoa não peça um "estudo" ou "briefing" explicitamente, e mesmo em tarefa que pareça pequena. Produz um briefing escrito com doutrina aplicável, padrões a seguir e riscos de compatibilidade antes do código, e decide quais das outras skills (deskcomm-doutrina, deskcomm-extensao, deskcomm-prompt, deskcomm-cliente-novo, sistema-vivo) carregar e em que ordem.'
---

# DeskcommCRM — vire especialista antes de implementar

> Objetivo: toda implementação nova nasce entendendo a doutrina, os padrões de UI/UX, os padrões de
> criação de agentes de IA e o que a distribuição open-source/self-host exige — nessa ordem, e ANTES
> do primeiro `Edit`. Esta skill não substitui as outras (`deskcomm-doutrina`, `deskcomm-extensao`,
> `deskcomm-prompt`, `deskcomm-cliente-novo`, `sistema-vivo`) — ela é o roteiro que decide QUAIS
> carregar, em QUE ordem, para a tarefa em mãos, e termina num briefing escrito antes de codar.

## Por que isso importa aqui

DeskcommCRM é distribuído open-source (`docs/doctrine/packaging.md`) e cada instalação é a VPS de um
cliente que não tem como te ligar quando quebra. Uma implementação "tecnicamente correta" ainda pode
ser recusada se: quebrar o `update.sh` de quem já instalou, inventar um padrão de UI que destoa do
resto do produto, ou criar um agente de IA fora do contrato que `deskcomm-cliente-novo`/`deskcomm-prompt`
já estabeleceram. O custo de checar antes é uma leitura; o custo de checar depois é um PR recusado ou
uma migration que quebra o clone de outra pessoa.

## 1. Mapeie a tarefa antes de ler qualquer coisa

Toda tarefa de implementação cai em uma ou mais destas categorias — identifique quais, porque cada
uma manda para uma leitura diferente. Uma tarefa real costuma cair em mais de uma linha:

| a tarefa... | estuda primeiro | depois carrega a skill |
|---|---|---|
| mexe em tabela, RLS, migration, RBAC, roteamento, webhook | Doutrina de Migrations & Banco no `CLAUDE.md` + `supabase/migrations/MANIFEST.md` | `deskcomm-doutrina` |
| cria/edita tela, componente, fluxo de usuário | `app/design/README.md`, `app/design/lib/tokens.ts`, `app/globals.css` | `frontend-design` |
| cria/edita agente de IA, prompt, roteador, follow-up, RAG | `docs/prd/05-prd-ai-rag-handoff.md`, o pacote do nicho já publicado | `deskcomm-cliente-novo`, `deskcomm-prompt` |
| adiciona funcionalidade que uma organização pode nunca ativar | `docs/doctrine/extensoes.md` | `deskcomm-extensao` |
| toca Dockerfile, compose, kit de instalação, versão | `docs/doctrine/packaging.md` | `deskcomm-instalar` (perspectiva do operador) |
| qualquer mudança de comportamento visível a quem usa o produto | `docs/doctrine/sistema-vivo.md` (7 invariantes) | `sistema-vivo` |
| vai virar PR | — | `deskcomm-contribuir` (antes de commitar, não antes de codar) |

Tarefa pequena não pula linha da tabela — só encurta o briefing (seção 3). O que nunca se pula é a
doutrina não-negociável do `CLAUDE.md`: isso já é coberto por `deskcomm-doutrina`, carregue sempre.

## 2. Não confie em memória de sessão anterior nem neste arquivo

Antes de escrever o briefing, confirme contra a fonte — não contra o que parece lembrado de uma
sessão anterior ou o resumo desta tabela:

```bash
cat docs/current-state.md          # o que está pronto, incompleto, quebrado — leia antes de estimar
cat docs/harness-audit.md          # onde o gov:verify NÃO cobre (schema/UI não provados por ele)
```

Se a tarefa toca UI, confira o estado vivo da navegação, não uma lembrança de uma sessão passada:

```bash
grep -n 'href:' lib/navigation/catalogo.ts | wc -l   # quantas portas existem hoje
```

## 3. Escreva o briefing antes do primeiro Edit

Formato fixo — curto para tarefa pequena, completo para feature nova. Seção sem conteúdo aplicável
some, não fica em branco:

```markdown
## Briefing pré-implementação: <nome curto da tarefa>

### O que muda
<1-3 frases>

### Doutrina aplicável (o que foi lido, não o que foi lembrado)
<arquivos/seções do CLAUDE.md e docs/doctrine/ relevantes à tarefa>

### Estado atual relevante
<o que docs/current-state.md diz sobre esta área, se houver algo>

### Padrões a seguir
<UI/UX: componentes shadcn/tokens existentes a reaproveitar — ou
 Agente de IA: contrato de nicho/prompt já estabelecido que este agente deve seguir>

### Núcleo, extensão, ambos ou infraestrutura
<resposta à pergunta de docs/doctrine/extensoes.md: "se nenhuma organização ativar isto,
 a operação comum continua inteira?">

### Riscos de compatibilidade self-host/open-source
<migration sem apêndice no baseline? env var sem default? tela sem porta na navegação?>

### Plano de implementação
<passos, na ordem>
```

Tarefa trivial (fix de uma linha, ajuste de string) não precisa do template inteiro — mas ainda
responde à pergunta de "Riscos de compatibilidade self-host", porque é exatamente a mudança pequena
demais para "merecer estudo" que costuma esquecer o apêndice do baseline ou a env var no
`.env.example`.

## 4. Depois do briefing

Implemente seguindo o plano. O que fecha o ciclo não é desta skill: `deskcomm-contribuir` antes de
commitar, a Doutrina de QA Visual (`CLAUDE.md`) antes de dizer "pronto" se a tarefa tocou UI, e a
Definition of Done completa do `CLAUDE.md` — os itens todos, não um resumo deles.

## Não-objetivos

Não repete o conteúdo de `deskcomm-doutrina`, `deskcomm-extensao`, `deskcomm-prompt`,
`deskcomm-cliente-novo` ou `sistema-vivo` — aponta para elas. Copiar o conteúdo aqui garantiria
divergência na próxima vez que uma delas mudasse (o mesmo argumento que `deskcomm-doutrina` já faz
sobre o `CLAUDE.md`). Não é um comando de fluxo (`/implementa-X`) nem um gerador de código.
