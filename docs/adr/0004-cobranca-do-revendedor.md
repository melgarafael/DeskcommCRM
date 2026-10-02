# ADR-0004 — Cobrança do revendedor: o dono da instalação cobra as empresas que atende

- **Status:** aceito em 2026-09-29 pelo dono do produto, junto com o desenho e as decisões D-1…D-14 dele
- **Data:** 2026-09-29
- **Contexto medido em:** `9b63075bf` (topo de `origin/main` em 29/09/2026); o peso das tabelas, num Postgres 17 descartável no mesmo dia
- **Lei que muda quando aceita:** [`docs/doctrine/operacao-de-agentes.md`](../doctrine/operacao-de-agentes.md) — §0, §1, a brecha "Faturamento e planos" da §3 e as proibições 2 e 3 da §4 — e, **só para este caso**, a condição 2 da [ADR-0002](0002-tabelas-de-modulo-num-banco-so.md)
- **Desenho que a detalha:** [`docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md`](../superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md)

---

## Contexto

O produto tinha duas respostas escritas para "quem cobra quem":

1. **O mantenedor não vende assinatura.** O software é MIT, completo e sem versão paga; o projeto
   se sustenta por infraestrutura, na parceria de VPS ([`VISION.md`](../../VISION.md), "Modelo do
   projeto").
2. **O operador de agentes cobra retainer por cliente operado.** Decidido em 13/09/2026
   ([`operacao-de-agentes.md`](../doctrine/operacao-de-agentes.md) §0 e a spec 19). O faturamento
   desse eixo continua proibido antes do primeiro operador que paga (§4, proibição 2).

Uma terceira pessoa já existia e não tinha ferramenta: **quem instala o sistema para outras
empresas e cobra por isso**. O guia de marca própria autoriza desde sempre — "você pode modificar,
hospedar para terceiros, revender e cobrar o que quiser" ([`docs/white-label.md`](../white-label.md)) —,
e a instalação já é multiempresa, com marca por instalação e por organização. O que falta é o dono
da instalação transformá-la num SaaS próprio: criar planos, dar teste grátis às empresas novas,
receber por um checkout hospedado, avisar quem atrasa, suspender depois de uma tolerância e liberar
sozinho quando o pagamento entra.

Três fatos moldam a decisão:

| Fato | Onde foi medido |
|---|---|
| A suspensão de empresa que existe hoje troca `organizations.status` (com data, motivo e autor) e nada mais corta: a IA, as automações e o envio de mensagens não leem esse status. As exceções que já o leem, como a rodada de campanhas, estão enumeradas junto com os pontos de corte que faltam | o `update` de status em `app/api/v1/admin/tenants/[id]/suspend/route.ts`; §4 do desenho |
| As travas que um plano precisa — pessoas, números conectados, teste grátis na criação da empresa — têm de morar em tabelas do núcleo: `user_organizations`, `channel_sessions`, `organizations` | §2.6 e §5 do desenho |
| A VPS de quem instala não compila código: ela baixa imagem pronta, e o `update.sh` regrava a imagem a cada atualização | `hostgator-setup-kit/update.sh`; [doutrina de packaging](../doctrine/packaging.md) |

### A tentativa anterior (PR #307)

O PR #307 ("Pivot SaaS pago (Genesisia Contabilidade): billing Asaas + fundação contábil") propôs
outra coisa: uma **instância hospedada paga**, sob uma marca, vendendo assinatura — o eixo 1
invertido. Trazia a própria ADR, no arquivo `0002-pivot-saas-pago.md`, com o número que a `main`
deu depois à ADR-0002 das tabelas de módulo. Foi fechado sem merge em 24/08/2026. Esta ADR não o
retoma: aqui quem cobra é quem instala, nunca o projeto. O que os dois desenhos têm em comum —
desligado por padrão, Asaas como provedor, suspensão pelo `organizations.status` — é convergência
registrada, não herança de código.

---

## Decisão

### D1 — Existe um terceiro eixo de dinheiro, e ele é de quem instala

| Eixo | Quem cobra | De quem, e como | Onde está decidido |
|---|---|---|---|
| 1 | o mantenedor | de ninguém: não vende assinatura; o projeto vive de infraestrutura | [`VISION.md`](../../VISION.md) |
| 2 | o operador de agentes | das empresas que ele opera: retainer por cliente operado | [`operacao-de-agentes.md`](../doctrine/operacao-de-agentes.md) §0; spec 19 |
| 3 | o dono de uma instalação (administrador da plataforma) | das empresas da própria instalação: planos, teste grátis, checkout hospedado (Stripe ou Asaas), régua de atraso | esta ADR e o desenho |

Os três convivem. O eixo 3 não autoriza o eixo 1 a vender nada, e não constrói o faturamento do
eixo 2.

### D2 — Capacidade do núcleo, com chave da instalação, desligada por padrão

- A cobrança entra no código de toda instalação e chega pelo `update.sh` como qualquer correção.
  Fica desligada até o dono da instalação ligá-la em `/admin/sistema`. A chave mora em
  `platform_config`, no mesmo trilho das chaves de instalação que `lib/instalacao/modulos.ts` já lê,
  e só o valor `ligado` a liga (falha fechada).
- Com a chave desligada, **nada do que existe muda**: as rotas da cobrança respondem 404, a tela do
  dono some do menu, nenhum limite vale, o cron sai sem auditar, e o formulário de nova empresa, o
  rótulo de plano, a tela de cobrança da empresa e o menu seguem idênticos. Quem administra a
  instalação vê só um interruptor a mais em `/admin/sistema`; quem opera uma empresa não vê
  diferença nenhuma.
- As duas tabelas da cobrança (planos e assinaturas) nascem vazias no banco de **toda**
  instalação, inclusive de quem nunca liga a chave. O peso está medido na seção seguinte.

### D3 — Empresa sem assinatura é isenta

Não há estado "isenta": empresa sem linha de assinatura não tem cobrança, limite nem régua. Isso
cobre de uma vez a empresa do próprio dono, toda empresa que existia antes de ligar a chave e quem
o dono isentar.

### D4 — O provedor é insumo, não fonte de regra

Teste grátis, régua de atraso e limites moram no nosso banco. O provedor responde só "há assinatura
viva e paga?", "está devendo?" e "foi cancelada?", e responde por releitura na API dele, nunca pelo
corpo de um aviso recebido. Um provedor por vez para assinatura nova; as antigas seguem no provedor
em que nasceram (decisão D-8).

### D5 — A suspensão que suspende vem antes, e vale sem a chave

Uma empresa suspensa — pelo dono, por motivo administrativo, ou pela régua, por falta de
pagamento — para de gastar e de falar: nenhuma IA roda, nada sai, a sessão cai numa tela própria,
token e MCP recebem 403. Mensagem que chega continua gravada, e a LGPD nunca é bloqueada. Isso
conserta a suspensão administrativa de hoje, vale para toda instalação e é o primeiro PR da
entrega, antes de qualquer linha de cobrança.

### D6 — As decisões de produto estão no desenho

As 14 decisões do dono (D-1…D-14: prazo de tolerância, troca de plano só na virada paga, convites
fora do limite, o que a suspensão corta e o que deixa passar, entre outras) estão na tabela do topo
do desenho. Esta ADR registra só o que muda doutrina: a D-1 (seção seguinte) e o alcance das
proibições da doutrina de operação de agentes.

---

## Relação com a ADR-0002

A ADR-0002 separa dois destinos para tabela nova: o **núcleo**, pela tripla de sempre (migration,
apêndice do baseline, MANIFEST), e o **módulo opcional com dados**, cujas tabelas só nascem quando o
módulo é instalado, por uma função provisionadora sem parâmetro. A condição 2 do dono sustenta a
separação: "quem não usa o módulo não carrega as tabelas dele".

A cobrança é classificada como **capacidade do núcleo com chave da instalação**, pelo mesmo caminho
do caixa, que a ADR-0002 registra como "já decidido como núcleo e entra pela tripla de sempre" (seção
"O que esta ADR não decide"). O motivo é estrutural:

- as travas de pessoas e de números e o teste grátis automático são gatilhos em tabelas do núcleo
  (`user_organizations`, `channel_sessions`, `organizations`) que **consultam** as tabelas da
  cobrança;
- a D4 da ADR-0002 reprova, por invariante, função provisionadora cujo corpo referencie tabela de
  fora do módulo — e a provisionadora da cobrança teria de criar esses gatilhos no núcleo;
- a saída que sobra — tabelas criadas pela provisionadora e gatilhos no baseline que toleram a
  ausência delas com `to_regclass` e SQL dinâmico, no espírito da D7 — poria SQL dinâmico em
  gatilhos quentes, no caminho de todo convite aceito e de toda conexão de número, contra duas
  tabelas pequenas. Recusada.

**O custo, medido.** As duas tabelas vazias, com os índices do desenho (§2.2 e §2.3), ocupam
**48 kB** (49152 bytes) num Postgres 17 descartável — a mesma bancada em que a
ADR-0002 mediu ~368 KB para as cinco tabelas vazias da comanda, com 18 índices.

**Isto revisa a condição 2, só para este caso.** A linha "Tabelas no baseline para todos" da D9 da
ADR-0002 diz que a reconsideraria "se o dono revisar a condição 2". O dono revisou, em 29/09/2026,
para a cobrança do revendedor (decisão D-1). A condição 2 continua valendo para todo módulo com
dados — a comanda, os honorários e os próximos —, e a exceção não vira precedente automático: outra
capacidade que queira o mesmo caminho precisa de decisão própria, com o peso medido na mão.

---

## Relação com a doutrina de operação de agentes

- **Invariante 1** (software livre, operação cobrada) segue intacta: nada do software fica atrás de
  pagamento ao projeto. A cobrança é uma ferramenta que quem instala usa ou não; desligada, a
  instalação é a mesma de antes.
- **Invariante 2** (quem opera sozinho não paga) segue intacta: o caminho self-host continua
  completo, e a empresa que instala para si nunca liga a chave. Quem paga, no eixo 3, é o cliente de
  um revendedor, pelo serviço que o revendedor presta, na instalação do revendedor.
- **Proibição 2** (faturamento antes do primeiro operador que paga) passa a dizer de quem é: do
  **operador de agentes**. O faturamento do retainer continua não construído, e a brecha
  "Faturamento e planos" continua aberta para ele.
- **Proibição 3** (licença ou assento) passa a dizer de quem é: do **mantenedor e do operador de
  agentes**. Planos, preço e limites — inclusive de pessoas — do revendedor são configuração dele.
  Todo limite nasce nulo, isto é, sem teto, até ele definir um.

---

## Consequências

- **Quem instala para si:** nenhum passo novo; um interruptor a mais em `/admin/sistema`; duas
  tabelas vazias no banco.
- **Quem revende:** liga a chave, conecta Stripe ou Asaas pela tela, cria planos e testa em modo de
  teste antes de publicar. Nenhuma edição manual de arquivo e nenhum fork: as atualizações chegam
  pelo `update.sh`.
- **O projeto:** passa a manter os adaptadores de dois provedores e a deriva das APIs deles. É o
  preço de a cobrança sobreviver à atualização.
- **Toda instalação, com ou sem cobrança:** ganha a suspensão que de fato suspende (D5).
- **Doutrina e documentos:** a doutrina de operação de agentes nomeia o eixo de cada proibição e
  troca a régua da brecha de faturamento por uma pergunta; a spec 19 diz que o console de agência
  segue sem faturamento; a VISION separa "nós não vendemos assinatura" de "quem instala pode cobrar
  os próprios clientes"; o catálogo de regras de negócio ganha o estado medido das regras de
  cobrança.

---

## Alternativas consideradas e recusadas

| Alternativa | Por que não | Reconsideraríamos se |
|---|---|---|
| **Fork, ou prompts que editam o código do revendedor** | A VPS baixa imagem pronta e o `update.sh` a regrava: a primeira atualização apaga a cobrança do fork, ou o fork deixa de receber atualização. É o que a doutrina de packaging proíbe exigir de quem opera | nunca: é o motivo de a capacidade morar no núcleo |
| **Sidecar** — um serviço de cobrança à parte, ao lado da instalação | Serviço que não é imagem publicada do compose nunca é atualizado (doutrina de packaging). E ele não alcança onde a cobrança precisa agir: as travas moram em gatilhos do núcleo, e a suspensão precisa de pontos de corte dentro da IA, do envio e da sessão; de fora, o sidecar só chamaria a rota de suspender, que hoje não suspende | o núcleo expor um contrato de corte por organização que um serviço externo possa acionar, com prova dos dois lados |
| **Extensão de pacote** | A lista fechada de capacidades de extensão deixa cobrança de fora, e pacote não traz SQL, credencial nem código ([`extensoes.md`](../doctrine/extensoes.md), não-negociável 2) | — |
| **Tabelas pela função provisionadora da ADR-0002, com gatilhos tolerando a ausência delas** | SQL dinâmico em gatilhos quentes de `user_organizations` e `channel_sessions` (seção "Relação com a ADR-0002") | as travas deixarem de morar em tabelas do núcleo |
| **Instância hospedada paga pelo projeto** (PR #307) | Inverte o eixo 1: contraria o "não vendemos assinatura" da VISION e a invariante 1 da doutrina de operação de agentes | decisão do dono de mudar o modelo do projeto — outra ADR, não esta |
| **Dois provedores aceitos ao mesmo tempo para assinatura nova** | Uma escolha a mais para o revendedor leigo e para o cliente final; trocar de provedor já não quebra quem assinou (D-8) | os revendedores pedirem, com o caso em mãos |

---

## O que esta ADR não decide

- **O faturamento do operador de agentes** (eixo 2): segue na proibição 2.
- **Preço de qualquer coisa:** planos e valores são do revendedor.
- **Nota fiscal, cupom, proração, Pix Automático e Mercado Pago:** fora da primeira entrega (§1.2 do
  desenho).
- **O endurecimento geral** do acesso de suporte só-leitura nas policies do banco e o fechamento da
  escrita direta ao banco por membro de empresa suspensa (riscos residuais 1 e 2 do desenho;
  decisão D-12).

## Aceite

**Aceita em 2026-09-29 pelo dono do produto**, com o desenho e as decisões D-1…D-14, todas pela
recomendação. O aceite não implementa nada. A ordem de construção está na §14 do desenho: a
suspensão que suspende; planos e limites; contrato, Stripe e régua; Asaas; o guia de instalação no
Coolify; o material para revendedores. Para ver o que já chegou à `main`:
`git log --oneline origin/main -- lib/cobranca lib/organizacao/operante.ts`.
