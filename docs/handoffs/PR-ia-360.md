# IA 360 — o agente ganha mãos, e o humano ganha painel

> Corpo do PR de integração `feat/ia-360-mcp` → `main`.
> Números medidos em `4ed080d8`, árvore limpa: 242 files changed, 24673 insertions(+), 1428 deletions(-) · 100 commits.
> Gates: `typecheck` ✓ · `lint` ✓ (0 erros) · `test:unit` 2232 ✓ · `test:db` 457 ✓ · `build` ✓

## O problema

O SonghaiCRM tinha **um agente que sabia conversar e não sabia operar**. Medido na linha de
base (`687716a`):

| | |
|---|---|
| Capacidades no catálogo MCP | **16** |
| Tabelas no `baseline.sql` | ~100 |
| Tabelas que as 16 alcançavam | ~8 |
| Capacidades de follow-up | **0** |

Zero de follow-up significa que o **invariante 4 da doutrina** — *nenhuma demanda sem próximo
passo* — era **impossível de cumprir** pelo agente que o dono configura na tela. A máquina existia,
rodava em worker, aparecia em tela; o agente não a alcançava.

## O que entra

**51 capacidades** (de 16), organizadas em seis pacotes por jornada — atender, vender, não perder
o cliente, passar para um humano, organizar a operação, aprender e evoluir.

**Um papel novo, `ai_operator`**, entre atendente e gerente. Ele resolve um impasse real: agendar
retorno pedindo `agent` daria à IA mais poder que uma **pessoa** do mesmo papel (as rotas exigem
`manager`); pedindo `manager`, o agente perde o que existe para fazer. O papel vive **só no escopo
do token efêmero, nunca em `user_organizations`** — por isso o CHECK do banco, a `fn_role_at_least`
e a RLS ficam **intactos**, e nenhuma pessoa pode recebê-lo.

**Painel para quem configura:** capacidades por jornada com risco declarado, ficha de cada uma, e
o uso real lido do `api_audit_log` — que já era gravado desde a Spec 11 e **nenhuma tela lia**.

**Linguagem de quem não programa**, com gate mecânico: rótulo, explicação, o-que-toca e lista de
jargão proibido, verificados no CI.

## Defeitos de raiz corrigidos — quase todos pré-existentes

Todos da mesma família: **falhavam em silêncio**.

| Defeito | Como falhava |
|---|---|
| 4 capacidades de escrita inalcançáveis pelo agente | erro devolvido ao modelo, nada na tela |
| `actor.id` era o run e a FK esperava o agente | atividade da IA morria com `23503` |
| `force_human` nunca era limpo | "devolver ao bot" respondia `{reactivated:true}` e não devolvia |
| a volta não tinha tipo na timeline | meia continuidade, lida como continuidade |
| cancelado indistinguível de disparado | a fila dizia "Concluída" para retorno não executado |
| **`listPipelinesHandler` sem filtro de organização** | quem é membro de duas orgs via as duas **misturadas** |
| busca de contato ignorava `display_name` | não achava **15 de 33** contatos desta instalação |
| agente sem relógio | "daqui a 3 dias" virava `2023-10-13`, a data do treino do modelo |
| prefixo do token efêmero colidia | **garantido** em toda retentativa de job |
| recusa por papel virava frase falsa | *"SEU perfil atual é agent"* na cara do cliente |
| selo de autoria virava ruído com o uso | 13% do sinal, 12% da altura da lista |
| painel mandava desligar o que o dono acabou de ligar | "nunca usada em 30 dias" tratava novo e abandonado igual |

## O que foi medido, e como

`typecheck` · `lint` · `test:unit` · `test:db` (aplica as 6 migrations em banco novo **e**
re-aplica em existente) · `build` · **E2E em tela**, com login real e MFA.

**Toda guarda nova foi sabotada** antes de ser considerada válida — quebrar a propriedade de
propósito, confirmar que reprova, desfazer. Verde de primeira não conta.

E o que **não** foi medido está declarado, não omitido: o estado "instalei agora e não tenho
credencial" (exige organização zerada), e a taxa real do intermitente de follow-up — **rebaixado,
não fechado**, com o poder estatístico junto (zero-em-9 sairia por acaso em 7,5% das vezes se a
taxa fosse 25%).

## Itens abertos, com dono e número

1. **Starvation do follow-up** — o claim é global com limite 20; org com mais de 20 vencidos
   monopoliza cada tick. Invisível hoje (uso single-operator), grave em SaaS multi-tenant.
2. **`followup-reactivity` intermitente** — dois mecanismos mapeados, CSV das 12 corridas
   versionado, conserto proposto.
3. **`update.sh` cospe 307 erros** — 112 índices do dump sem `if not exists`. Install limpo.
4. **App inutilizável abaixo de 768px** — sidebar fixo de 240px não colapsa.
5. **Contador de tokens ainda diz "~21 tokens"** — resíduo declarado pela W1: o componente é
   compartilhado com telas fora do épico, então não foi tocado.

> A tela bilíngue **saiu desta lista**: era o item 5 até a W1 traduzir as três telas
> (`Max steps` → **Ações por atendimento**, `p95 latência 17.621 ms` → **Tempo de resposta 16,2 s**),
> e junto vieram dois consertos que não eram tradução — o card de orçamento prometia "pausa ao 100%"
> de um teto que não existia, e as validações acusavam antes de a pessoa digitar.

## Contexto

- Contrato e decisões: `docs/handoffs/BRIEFING-ia-360.md`
- Registro vivo, com SHA em cada afirmação: `HANDOFF-ia-360.md`
- Evidência visual versionada: `evidence/` (224 arquivos, todos citados por documento — há gate
  mecânico para isso)
