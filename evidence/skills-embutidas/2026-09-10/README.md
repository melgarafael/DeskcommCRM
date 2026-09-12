# Prova de acionamento das skills embutidas — 10/set/2026

**O que se prova aqui:** que os guias (`.agents/skills/deskcomm-*`) carregam **sozinhos**, pela
descrição, quando uma pessoa leiga faz uma pergunta comum — sem citar o nome da skill e sem saber
que ela existe — em três CLIs sem interface. Teste automatizado não prova acionamento; sessão real
prova.

**Como foi medido.** `scripts/skills-embutidas/provar.mjs` roda cada pergunta num clone do épico
**sem `node_modules`**, com identidade de contribuidor (`user.email` de fork, `GH_TOKEN`
inválido para o `gh` não denunciar o mantenedor), e resume ferramentas usadas, leituras de
`SKILL.md`, turnos, duração e custo. Claude Code 2.1.263 (`claude -p`, modo plano), Codex CLI
0.153.4 (`codex exec --json`, `CODEX_HOME` limpo com a pasta confiada) e OpenCode 1.18.18
(`opencode run --format json`, modelo gratuito). O bruto de cada corrida ficou fora do git
(contém a resposta inteira); `depois.json` traz o resumo e os 300 primeiros caracteres.

## Depois — com os guias (branch `feat/skills-embutidas`)

| pergunta | CLI | guia acionou sozinho | ferramentas | turnos | tempo | custo |
|---|---|---|---|---|---|---|
| instalar (clínica, VPS HostGator) | claude | sim (deskcomm-instalar) | 1 | 3 | 40 s | US$ 1.76 |
| instalar (clínica, VPS HostGator) | codex | sim (deskcomm-instalar) | 1 | 1 | 15 s | n/d |
| instalar (clínica, VPS HostGator) | opencode | sim (deskcomm-instalar) | 1 | 2 | 54 s | n/d |
| montar clínica odontológica | claude | sim (deskcomm-cliente-novo) | 8 | 10 | 90 s | US$ 2.27 |
| montar clínica odontológica | codex | sim (deskcomm-cliente-novo) | 2 | 1 | 24 s | n/d |
| montar clínica odontológica | opencode | sim (deskcomm-cliente-novo) | 1 | 2 | 15 s | n/d |
| analisar desempenho e custo | claude | sim (deskcomm-metricas) | 12 | 14 | 175 s | US$ 2.63 |
| analisar desempenho e custo | codex | sim (deskcomm-metricas) | 2 | 1 | 22 s | n/d |
| analisar desempenho e custo | opencode | sim (deskcomm-metricas) | 1 | 2 | 22 s | n/d |
| agente da imobiliária não marca visita | claude | sim (deskcomm-prompt) | 7 | 9 | 88 s | US$ 2.16 |
| agente da imobiliária não marca visita | codex | sim (deskcomm-prompt) | 2 | 1 | 26 s | n/d |
| agente da imobiliária não marca visita | opencode | sim (deskcomm-prompt) | 1 | 2 | 35 s | n/d |
| corrigir bug e abrir PR | claude | sim (deskcomm-contribuir) | 11 | 13 | 100 s | US$ 2.42 |
| corrigir bug e abrir PR | codex | sim (deskcomm-contribuir) | 5 | 1 | 64 s | n/d |
| corrigir bug e abrir PR | opencode | sim (deskcomm-contribuir) | 2 | 3 | 39 s | n/d |

Custo: só o Claude reporta; Codex (ChatGPT) e OpenCode (modelo gratuito) não. Em todas as 15
corridas o guia esperado foi carregado — no Claude pela ferramenta `Skill`, no Codex lendo o
`SKILL.md` no primeiro turno, no OpenCode pela ferramenta `skill`. Nas perguntas de métricas,
prompt e contribuição o Claude também leu as referências e rodou `quem-sou.sh` (respondeu
"contribuidor") — e reportou, sem que se pedisse, que o `origin` do clone de prova não existe.

## Antes — `origin/main` sem os guias (mesmas perguntas, Claude Code)

| pergunta | ferramentas | turnos | tempo | custo | guia |
|---|---|---|---|---|---|
| instalar (medido em 08/set) | 30 | 4 | 200 s | US$ 3,08 | nenhum |
| montar clínica odontológica | 158 | 15 | 426 s | US$ 9,78 | nenhum |
| analisar desempenho e custo | 191 | 3 | 399 s | US$ 9,94 | nenhum |
| agente não marca visita | 175 | 6 | 526 s | US$ 11,63 | nenhum |
| corrigir bug e abrir PR | 14 | 3 | anômalo (processo parado ~3 h por pressão de memória) | US$ 2,08 | nenhum |

Resumo em `antes.json`. Em nenhuma das cinco a IA achou um guia — não havia; ela varreu o
repositório (até 191 ferramentas numa pergunta) e respondeu por conta própria.

## Antigravity — o CLI (`agy --print`), 11/set

O app instala um CLI (`agy`) com modo sem interface. Rodei as cinco perguntas nele (modo plano,
permissões auto-aprovadas — sem isso o primeiro comando pedido pela doutrina global do dono
encerra a corrida sem resposta). Resultado: **o CLI não enxerga as skills do workspace** —
perguntado diretamente "quais skills do workspace você tem no contexto?", respondeu "NENHUMA".
Nas cinco corridas, o guia certo foi encontrado **por exploração** em duas (montar clínica: leu o
`SKILL.md` e as referências depois de 30 ferramentas; instalar: foi buscar o guia no GitHub), e não
foi encontrado em três (métricas, prompt, contribuir), que responderam por conta própria. Resumo
em `antigravity.json`. A prova do **app** Antigravity (que, pelas docs, lê `.agents/skills/`)
segue à mão.

## O que NÃO ficou provado

- **Hook de início de sessão** (`.claude/settings.json` → `sessao.sh`): em `claude -p` os hooks
  de projeto **não executaram** nesta versão, mesmo com a pasta confiada em `~/.claude.json` —
  medido com um hook que gravava um marcador em disco (nunca apareceu). A sessão interativa não foi
  medida. O acionamento não depende dele: a descrição basta.
- **Cursor**: o CLI (`agent`) foi instalado em 11/set e exige `agent login` — a prova fica para
  depois do login. **Antigravity**: o CLI não carrega skills do workspace (acima); o app segue com o
  roteiro à mão em "Decisão Implementações/CRED-003".
- **Codex com muitas skills globais**: numa instalação com centenas de skills pessoais o Codex
  encurta e depois remove as descrições da lista (medido em 08/set); o gate limita o que o repo
  gasta desse orçamento, mas não o que a pessoa já tem.
