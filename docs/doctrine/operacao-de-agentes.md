# Doutrina de Operação de Agentes — o CRM como função de um serviço

> Lei sobre **o que se opera, o que se vende e o que permanece livre**. O produto deixa de ser
> "um CRM com IA" e passa a ser **operação de agentes para empresas**, da qual o CRM é uma
> função. Complementa [`versionamento.md`](./versionamento.md) (o que o número promete) e
> [`packaging.md`](./packaging.md) (como o artefato chega ao disco do cliente).
>
> **Por que este documento existe.** A tese já foi arquitetada neste repositório e nunca foi
> decidida por escrito: o contrato de um runtime de agentes **externo** ("runtime de agentes de
> IA 1:N, fora deste repo") está em `docs/specs/14-contrato-governanca-agentes-externos.md`, e o
> CRM já é exposto como funções em `app/api/mcp/route.ts`. Depois disso, em 2026-07-17, a decisão
> tomada foi a **inversa** — fundir o cérebro dentro do CRM (`docs/vendaval-fusion-plan.md`).
> Enquanto a fronteira não estiver escrita, cada sessão escolhe sozinha uma das duas.

---

## 0. Decisões que NÃO são do agente

Estas decisões não tinham resposta escrita em nenhum lugar do repositório. **Não invente nenhuma
delas** — a doutrina proíbe preencher lacuna com suposição plausível. Três seguem abertas:

| Decisão                         | Estado                                                                         | Quem decide     |
| ------------------------------- | ------------------------------------------------------------------------------ | --------------- |
| Unidade de cobrança             | **DECIDIDO em 2026-09-13: retainer por cliente operado** — ver §1.2 da spec 19 | dono do produto |
| Mercado e idioma de entrada     | **EM ABERTO**                                                                  | dono do produto |
| Preço, SLA e prazo de resposta  | **EM ABERTO** — nenhum número existe                                           | dono do produto |
| Certificações SOC 2 / ISO 27001 | **FORA DE ESCOPO** por decisão escrita, "conforme demanda comercial"           | dono do produto |

A primeira linha foi fechada em 2026-09-13 e é a que destrava o resto: **retainer por cliente
operado**. O trabalho imediato passa a ser o console de agência
(`docs/specs/19-spec-console-de-agencia.md`), e não um medidor de consumo — cobrar por consumo
exigiria construir medidor → fatura antes do primeiro real, e o schema não tem tabela que fature o
operador de agentes (a régua é a pergunta da brecha "Faturamento e planos", §3). A cobrança que o
**dono de uma instalação** faz das empresas que atende é outro eixo, decidido à parte na
[ADR-0004](../adr/0004-cobranca-do-revendedor.md), e não é esta linha.

---

## 1. A fronteira — software livre, operação cobrada

**Invariante 1.** O software permanece MIT e completo. O que se cobra é a **operação**: hosting
gerenciado, atualizações, pacotes de agente, avaliação por cliente e SLA.

**Invariante 2.** Nada que o cliente precise para **operar sozinho** pode ficar atrás de
pagamento. Existe um caminho self-host que funciona ponta a ponta (`hostgator-setup-kit/install.sh`)
e ele nunca é sabotado — a mesma regra de ouro que já vale para a parceria de infraestrutura.

**Invariante 3.** Nenhum serviço de produção constrói na máquina do cliente, e a atualização
nunca exige edição manual de arquivo. Vale integralmente a lei de [`packaging.md`](./packaging.md).

**Consequência prática:** o projeto — mantenedor ou operador de agentes — cobrar por licença ou por
assento **contraria** a promessa MIT escrita em `VISION.md` e exigiria reescrever a identidade do
projeto. O dono de uma instalação que cobra as empresas dela é outro eixo
([ADR-0004](../adr/0004-cobranca-do-revendedor.md)). Cobrar pela operação não exige nada disso.

---

## 2. Inventário medido — o que já é substrato

| Peça de um serviço de agentes                                                             | Onde vive                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O CRM exposto como funções                                                                | `app/api/mcp/route.ts` e `lib/mcp/`, com catálogo por domínio (comércio, agendamento, atendimento, escalação, evolução, funil, governança, operação, retenção) |
| Runtime de agentes dentro do repo                                                         | `lib/agent-engine/` (turnos, `guardrails/`, `pacing/`, `flywheel/`, `edge/llm/`)                                                                               |
| Agente como entidade gerenciada (publicar, versionar, duplicar, escolher modelo, validar) | `lib/ai/agents/`                                                                                                                                               |
| Governança de agentes: lock otimista, idempotência, atribuição auditada                   | `docs/specs/14-contrato-governanca-agentes-externos.md` e `lib/audit/index.ts`                                                                                 |
| Custo medido por organização                                                              | `supabase/baseline.sql` — `llm_calls.cost_cents` e `ai_invocations`, agregados por `organization_id`                                                           |
| Freio de gasto por organização                                                            | `lib/ai/budget/check.ts` e `docs/architecture/teto-de-orcamento.architecture.json`                                                                             |
| Isolamento por cliente                                                                    | RLS e invariantes de banco no CI                                                                                                                               |
| Agente que **fala**, não só conversa                                                      | `lib/wacalls/` e `lib/voice/`                                                                                                                                  |
| Canal agnóstico                                                                           | `lib/channels/capabilities.ts` e [`restricao-de-canal.md`](./restricao-de-canal.md)                                                                            |
| Método de entrega já escrito                                                              | as skills `deskcomm-instalar`, `deskcomm-cliente-novo`, `deskcomm-prompt` e `deskcomm-metricas`                                                                |
| Marca própria (o cliente revende)                                                         | `lib/branding/`, `platform_branding`, e o gate que proíbe o nome do produto em código que alcança o usuário                                                    |

Comandos de medição — **CONFIRMADO**, rodados contra este commit:

```bash
git ls-files lib/mcp | wc -l                          # 40   — catálogo de tools
git ls-files lib/agent-engine | wc -l                 # 135  — runtime
git ls-files 'lib/ai/agents/*' | wc -l                # 17   — agente como entidade
git ls-files lib/wacalls lib/voice | wc -l            # 12   — voz
git ls-files '.agents/skills/*/SKILL.md' | wc -l      # 7    — método de entrega
grep -c 'cost_cents' supabase/baseline.sql            # 15   — custo por organização
pnpm test:db                                          # isolamento por cliente (RLS)
```

**O que isso significa.** A agência que vende agentes de IA para PMEs não tem como controlar o
custo de token por cliente nem provar quem fez o quê. Aqui isso existe **por organização**, com
freio e com auditoria. É esse o ativo — não a lista de funcionalidades.

---

## 3. Brechas — com critério de aceite observável

Cada brecha só está fechada quando o critério for observável por terceiro. "Está implementado"
não é aceite; **a prova é o comportamento visto**, não o teste que prova a si mesmo.

| Brecha                                                                                                                                                              | Critério de aceite                                                             | Como se prova                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| **Faturamento e planos do operador de agentes** (eixo 2, o retainer) — não há tabela que fature o operador; a cobrança do revendedor (eixo 3, [ADR-0004](../adr/0004-cobranca-do-revendedor.md)) é outra coisa e não fecha esta brecha                                                                                    | Um operador emite cobrança de N clientes sem planilha paralela                 | a pergunta abaixo, respondida tabela a tabela           |
| **Console de agência multi-cliente** — `app/admin/` é do administrador da instalação, com sessão de suporte auditada (`docs/support-sessions.md`), não uma carteira | Operar 3 clientes (modelo de agente, saúde, transferência) numa tela só        | Playwright contra o app rodando              |
| **Pacotes de agente por nicho** — hoje são procedimento manual descrito nas skills                                                                                  | Criar um agente novo para um cliente a partir de um pacote, sem editar arquivo | sessão real + diff do agente publicado       |
| **Aceite por cliente** — existe avaliação (`lib/ai/agents/avaliar-resposta-de-teste.ts`, `scripts/flywheel-judge-live.ts`), não um portão de entrega por conta      | Um agente só é entregue e cobrado com o conjunto de avaliação aprovado         | rodada de avaliação com resultado registrado |
| **MCP público** — declarado fora do MVP em `docs/specs/11-spec-mcp-server-internal.md`                                                                              | Cliente pluga o próprio agente com uma API key                                 | token real + chamada de tool observada       |
| **SLA e observabilidade por conta** — `lib/agent-engine/obs/metrics.ts` e `lib/agent-engine/health/circuit.ts` existem, falta a superfície por cliente              | Um cliente vê a saúde do próprio agente sem acesso interno                     | tela real por organização                    |

A régua da primeira linha é uma **pergunta**, não uma contagem. Liste as tabelas do schema com
cara de cobrança:

```bash
grep -oiE 'create table (if not exists )?"?public"?\."?[a-z_]+' supabase/baseline.sql \
  | tr -d '"' | grep -iE 'invoice|billing|fatura|plan|assinatura|subscription|cobranca|quota|credit'
```

e responda, para cada linha: **esta tabela fatura o retainer de um cliente operado?** A brecha só
fecha quando alguma responder "sim". Duas classes de linha respondem "não" e não fecham nada:

- tabela de outro domínio que casa o nome — `account_plans` é o plano de contas do caixa,
  `push_subscriptions` é inscrição de notificação;
- as tabelas `cobranca_*`, quando existirem: são a cobrança **do revendedor** (eixo 3,
  [ADR-0004](../adr/0004-cobranca-do-revendedor.md)) — o dono da instalação cobrando as empresas
  que atende, com plano fixo. Não medem nem faturam operação de agentes.

A régua anterior devolvia zero, e hoje esse zero é verdadeiro — mas por sorte: ela só via
`public.x` sem aspas (o trecho do dump, escrito `"public"."x"`, ficava fora) e só casava nomes em
inglês. As tabelas `cobranca_*` passariam por ela invisíveis pelo nome, e o zero seguiria lido como
"a brecha está aberta" pelo motivo errado.

---

## 4. Proibido

1. **Não reverter a fusão do Vendaval.** Ela foi decidida e executada; o cérebro está em
   `lib/agent-engine/`. Tirar o runtime de volta é o refactor mais caro do repositório e não se
   paga com prova comercial nenhuma. O CRM como função já se obtém via MCP, sem mover arquivo.
2. **Não construir faturamento antes do primeiro operador que paga.** Sem cliente pagante, o
   desenho do medidor é adivinhação. Vale para o faturamento do **operador de agentes** (o
   retainer, §0), não para a cobrança do revendedor, que é outro eixo e tem decisão própria
   ([ADR-0004](../adr/0004-cobranca-do-revendedor.md)).
3. **Não cobrar por licença nem por assento** (invariantes 1 e 2). A proibição é do
   **mantenedor e do operador de agentes**. Quem instala e cobra as empresas da própria instalação
   escolhe planos, preço e limites — inclusive de pessoas — como configuração dele, e todo limite
   nasce nulo, isto é, sem teto, até ele definir um (ADR-0004).
4. **Não inventar preço, SLA nem número.** O primeiro cliente real define os três.
5. **Não perseguir certificação** (SOC 2, ISO 27001), multi-região ou idioma adicional enquanto
   não houver demanda enterprise em mãos — está declarado fora de escopo de propósito.
6. **Não caçar paridade de funcionalidade sem cliente que a pague.** Campanhas com template
   oficial e canais adicionais entram quando um cliente pagante os pedir, não antes.

---

## 5. Sequência — cada fase termina em prova de realidade

A regra que vale sobre todas, escrita pelo plano de fusão que antecedeu esta:

> _"O projeto anterior falhou por UM motivo: tudo foi validado contra testes, mocks e dados de
> replay — nada contra a realidade."_

1. ✅ **Fronteira e unidade de cobrança escritas** (2026-09-13). A unidade é retainer por cliente
   operado; a lei está nesta doutrina e o trabalho seguinte está em
   `docs/specs/19-spec-console-de-agencia.md`.
2. ⏳ **Um cliente real**: WhatsApp real, agente respondendo, dinheiro real. Não é demo. **Nada
   depois desta linha avança sem ela.**
3. **Console de agência**, com um operador usando de verdade (spec 19).
4. **Pacotes de agente por nicho**, derivados do que a fase 3 provou.
5. **Aceite por cliente** como condição de entrega e de cobrança.

Cada fase herda a doutrina de QA visual: a prova é a tela observada como um leigo a usaria, com
evidência visual. `curl` não conta.

---

## 6. Critério de corte

**Se três retainers de agência não fecharem em 90 dias com o produto de hoje, a tese está errada
para este ativo** — e o caminho de volta é competir com CRMs de PME, onde as brechas são poucas e
concretas, em vez de reescrever a identidade do projeto.

O critério existe para ser escrito **antes** e não depois: sem ele, o custo afundado decide por
você.
