# Módulo da Agência — Mapa de capacidades

> Estado: **aprovado** pelo dono em 23/10/2026.
> - **Fase 1** (equipe, WhatsApp da agência, avisos): construída e publicada no teste em 23/10/2026 — ver [plano-fase-1.md](plano-fase-1.md).
> - **Fase 2** (clientes, acervo, tarefas): construída e publicada no teste em 24/10/2026 — ver [plano-fase-2.md](plano-fase-2.md).
> - **Fase 3** (calendário e reuniões): spec aprovada em 24/10/2026 — [SPEC-calendario](SPEC-calendario.md); construída e publicada no teste — [plano-fase-3](plano-fase-3.md).
> - **Fase 4** (trilha do cliente): decidida e construída em 26/10/2026, publicada no teste — [SPEC-trilhas](SPEC-trilhas.md), [plano-fase-4](plano-fase-4.md). A partir daqui as fases seguem sem parar para aprovação (pedido do dono em 26/10/2026).
> - **Fase 5** (formulário e cofre de acessos): construída e publicada no teste em 26/10/2026 — [SPEC-cofre-e-formulario](SPEC-cofre-e-formulario.md), [plano-fase-5](plano-fase-5.md). O `formulario.emmovimento.tech` pode ser aposentado quando o dono quiser.
> - **Fase 6** (contratos): construída, publicada e provada no teste em 26/10/2026 — [SPEC-contratos](SPEC-contratos.md), [plano-fase-6](plano-fase-6.md). Para retomar o trabalho: [CONTINUIDADE.md](CONTINUIDADE.md).
> - **Fase 7** (aprovações do cliente): construída, publicada e provada no teste em 26/10/2026 — [SPEC-aprovacoes](SPEC-aprovacoes.md), [plano-fase-7](plano-fase-7.md).
> - **Fase 8a** (mapa mental): construída, publicada e provada no teste em 26/10/2026 — [SPEC-mapa-mental](SPEC-mapa-mental.md), [plano-fase-8](plano-fase-8.md).
> Este arquivo é o índice da iniciativa: cada módulo abaixo ganha a sua própria
> especificação (`docs/agencia/SPEC-<id>.md`) só depois que este mapa for aprovado.

## Objetivo

Dar à agência Em Movimento um lugar só, dentro da central.emmovimento.tech, para
levar cada cliente do primeiro contato até o conteúdo no ar todo mês — sem
depender de memória, planilha ou mensagem perdida no WhatsApp.

Quem usa:

- **Dono e sócios** — no painel administrador, veem e configuram tudo.
- **Equipe** (roteirista, videomaker, editor, designer, social media, gestor de
  tráfego, programador) — numa **área própria da agência**, vendo só tarefas,
  calendário e o que as funções dela permitem. Nunca entram no resto do painel.
- **Cliente** — pela organização dele no CRM, numa aba de avisos e aprovações.

Sucesso é: todo cliente novo segue a mesma trilha, cada passo tem dono e prazo,
ninguém precisa perguntar "isso já foi feito?", e o atraso aparece antes de
acontecer.

## Decisões já tomadas

| # | Decisão |
|---|---|
| D1 | A equipe entra numa área própria (`/agencia`), não como admin do painel. A regra de quem vê o quê fica no banco, não só na tela. |
| D2 | Um membro pode ter **várias funções**. Funções: roteirista, videomaker, editor, designer, social media, gestor de tráfego, programador. |
| D3 | Cada membro tem uma chave "vê todos os clientes" ou "só os clientes que atende". |
| D4 | Avisos chegam no sininho do sistema **e** no WhatsApp pessoal do membro, enviados pelo WhatsApp da agência. A antecedência do aviso de prazo é configurável (1, 2, 3… dias). |
| D5 | Dois tipos de contratação: **recorrente** (pacote montado sob medida, sem nomes fixos de plano) e **avulsa** (gravação, tráfego, site, automação, artes/design, assessoria). Um cliente pode ter várias contratações ao longo do tempo. |
| D6 | Avulso que vira recorrente entra direto no **Fechamento**. |
| D7 | Todo cliente ganha uma **organização no CRM**. O atendimento (chat) é opcional por cliente. |
| D8 | O formulário de acesso continua pedindo **senhas** — a agência organiza e devolve os acessos ao cliente. Ficam criptografadas, só quem tem permissão vê, e cada visualização fica registrada. |
| D9 | Contrato: PDF para levar impresso; assinatura **só digital** (ZapSign hoje). Pagamento pela **InfinitePay** (link avulso e cobrança recorrente). |
| D10 | Ao assinar **e** pagar: o sistema cria o grupo **"Em Movimento - <Empresa>"** com o cliente e a equipe e envia o formulário. |
| D11 | O cliente aprova vídeos, roteiros, artes e a estratégia do mês pela organização dele; o grupo recebe um aviso apontando para lá. |
| D12 | O mapa mental é só da agência, com etapas que **desbloqueiam** as seguintes (como fases de jogo). |
| D13 | Freelancers: **depois**. Fica anotado, fora desta iniciativa. |
| D14 | Uso no celular e no computador — toda tela nasce responsiva. |
| D15 | O painel administrador é o **centro**, com duas portas separadas: **Agência** (`/agencia`, o trabalho interno) e **Organizações** (`/app`, os clientes). Os dados de uma nunca aparecem na outra. A equipe entra pelo login normal e cai direto em `/agencia`; só o dono enxerga as duas portas. |
| D16 | O mapa mental tem **duas telas**: **Criação** (montar blocos, ligações e prazos, em rascunho) e **Ao vivo** (depois de publicado, a equipe cumpre as etapas, que vão se desbloqueando como fases de um jogo). |
| D17 | Cada bloco/tarefa escolhe **quem executa: humano ou IA**. A IA executa a partir de um catálogo de ações (ex.: criar campanha com título e segmentação, agendar publicação no calendário) e devolve o resultado para conferência. Ação que gasta dinheiro (campanha) nasce **pausada** e só vai ao ar com o aval de um humano. |
| D18 | WhatsApp da agência: conectar por **QR Code (WAHA)**, numa **organização própria da agência** criada na central. A API oficial exige modelo aprovado e cobra por mensagem para avisos fora da janela de 24 h e não cria grupos com a mesma liberdade. |
| D19 | Sem verificação em duas etapas para a equipe: só login e senha. |
| D20 | **Acervo do cliente no Google Drive.** Cada cliente ganha uma pasta com subpastas fixas, e tudo o que acontece com ele é guardado lá, em texto ou arquivo (formulário, contratos, planejamentos, identidade visual, captações, edições, artes). O **banco da central continua sendo a fonte** do que o sistema precisa consultar (tarefas, prazos, respostas); o Drive recebe a **cópia legível** e os **arquivos pesados** (vídeos, fotos). A IA lê o Drive e o que for consultado sempre fica também no CRM. **Senhas do cofre nunca vão para o Drive**: ficam criptografadas na central, e um botão gera o **relatório de acessos** (PDF) para entregar ao cliente. Conta: a do plano Google AI Pro da agência (5 TB). Pastas começam do zero; ao ligar o acervo, a central cria a pasta de cada cliente que já existe, e as próximas nascem sozinhas. |

## Regras do negócio (cliente recorrente)

### Etapa 1 — Reuniões com o cliente

| Marco | Prazo | O que acontece |
|---|---|---|
| **Apresentação** | Dia D | Entender o comércio e o objetivo (checklist no apêndice A). Gravar: Meet se online, gravador se presencial. |
| Preparação da proposta | Até o Fechamento | Apresentação + proposta. |
| **Fechamento** | D + 7 (remarcar a Apresentação arrasta o Fechamento) | Levar contrato impresso e link de pagamento. |
| Validade da proposta | 5 dias após o Fechamento | Assinou **e** pagou → segue. Só um dos dois → continua parado. |
| Proposta expirada | Passados os 5 dias | Contato com nova proposta, de valor maior. |
| Recusa | — | Contato vai para a lista de remarketing do WhatsApp da agência. |
| Ao assinar e pagar | Na hora | Grupo no WhatsApp + formulário de acesso. |
| **Ativação** (ex-"onboard") | Até 7 dias após assinar **e** pagar | Roteiros prontos para aprovar, acessos das redes ao vivo, explicar gravações, revisar estratégia e datas. |

### Etapa 2 — Preparação (trabalho interno, mês de preparação)

```
🎬 Vídeos e fotos      roteiros → storyboards → 1ª captação (vídeos + fotos)
                        → subir material → editor (vídeos) e designer (fotos)
🔄 Atualização geral   Instagram · Facebook · Google · YouTube · TikTok
                        identidade visual padronizada · informações · árvore de links · acesso ao CRM
📈 Campanhas           reconhecimento de marca e conversão, em Meta Ads e Google Ads
🎨 Artes
```

Desbloqueios já citados: **identidade visual → artes**; **vídeos e fotos em mãos →
edição e padronização das redes**. Quantidades (vídeos, fotos) vêm do contrato de
cada cliente.

### Calendário do contrato — regra do dia 15

Todo contrato começa no **dia 1**. O conteúdo é gravado num mês e postado no seguinte.
A data que conta é a de **assinar e pagar** (a última das duas).

| Assinou e pagou em | Contrato começa | Mês de preparação | Primeira postagem |
|---|---|---|---|
| Dia 1 a 15 (ex.: 06/jan, 15/jan) | Dia 1 do **mesmo** mês | Do pagamento até o fim do mês (mais curto: no dia 15 sobram ~15 dias) | Mês seguinte |
| Dia 16 em diante (ex.: 20/jan) | Dia 1 do mês **seguinte** | Do pagamento até o fim do mês seguinte (os dias do mês corrente são cortesia) | Dois meses depois |

O prazo mínimo de contrato é **3 meses**.

### Etapa 3 — Ciclo mensal (meses seguintes à preparação)

Padrão que se repete todo mês enquanto o contrato vale:

- **No mês N** as publicações e anúncios de N estão no ar **e**, ao mesmo tempo, a
  agência grava e prepara o conteúdo de **N + 1**.
- O planejamento já nasce no Fechamento cobrindo os **3 meses** do contrato mínimo;
  cada mês só aplica a parte correspondente.
- Reunião mensal com o cliente para apresentar o planejamento do mês seguinte é
  **opcional** (muitas vezes dispensável, porque os 3 meses já foram apresentados).
- Ajustes no planejamento entram conversando com a IA do mapa mental, que altera o
  plano (Fase 9).

Os prazos dos passos (storyboard, captação, edição…) **variam por cliente e por
mês**: o sistema não fixa números, e cada passo recebe data e hora preenchidas por
quem planeja.

### Acessos

O YouTube não entra no formulário: o acesso à conta Google já dá acesso a ele.

## Mapa de capacidades

Os ids são fixos: as especificações, o plano e as tarefas se referem a eles.

| id | O que entrega | Depende de |
|---|---|---|
| `equipe` | Área `/agencia`, convite de membros, funções múltiplas, chave "todos os clientes / só os meus", permissões por função | — |
| `whatsapp-agencia` | Qual WhatsApp conectado é o da agência; enviar mensagem a uma pessoa; criar grupo com participantes | — |
| `avisos` | Sininho + WhatsApp pessoal; preferências por membro; antecedência configurável; aviso de "chegando / vence hoje / atrasou" | `equipe`, `whatsapp-agencia` |
| `clientes` | Cadastro do cliente da agência (multiempresa, como o formulário), contratações recorrente/avulsa com serviços e quantidades, situação (em negociação, ativo, perdido, remarketing), criação da organização no CRM | `equipe` |
| `acervo` | Conexão com o Google Drive da agência (reaproveita o login Google que a central já tem para a Agenda, com o escopo do Drive como opcional); pasta por cliente com subpastas fixas; guardar texto e arquivo; anexos e uploads das outras partes vão para lá; leitura pela IA | `clientes` |
| `tarefas` | Kanban (Backlog → A fazer → Em andamento → Revisão → Concluído), vários responsáveis ou uma função inteira, checklist e "criar em lote", tags, links, anexos, cronômetro ao iniciar, atrasada em vermelho, ranking de pendências por cliente, tarefas recorrentes | `equipe`, `clientes`, `avisos` |
| `calendario` | Reuniões (presencial/online, participantes, link do Meet gerado e enviado ao cliente), agenda das tarefas, calendário de postagens (gravar → editar → entregar → postar) | `equipe`, `clientes`, `tarefas` |
| `trilhas` | Modelo de etapas com dependências e desbloqueio; cada contratação recebe a sua cópia, que vira tarefas e reuniões com datas reais; relógio de prazos (D+7, 5 dias, 7 dias, regra do dia 15); progresso da trilha | `tarefas`, `calendario`, `avisos` |
| `cofre-de-acessos` | Senhas criptografadas (AES-256-GCM, já existe em `lib/crypto/aes_gcm.ts`), ver só com permissão, registro de cada visualização, exportar a lista para o cliente | `equipe`, `clientes` |
| `formulario` | O formulário de acesso trazido para dentro da central, com as mesmas perguntas (apêndice B), link por cliente, validade de 72 h, respostas direto na ficha | `clientes`, `cofre-de-acessos` |
| `contratos` | Modelos com campos; gerar PDF; depois ZapSign (enviar e saber que assinou) e InfinitePay (link e saber que pagou); ao completar as duas, disparar o grupo e o formulário | `clientes`, `whatsapp-agencia`, `formulario`, `trilhas` |
| `aprovacoes` | Aba da agência na organização do cliente: avisos, aprovação de vídeos, roteiros, artes e estratégia do mês; aviso no grupo | `clientes`, `tarefas`, `whatsapp-agencia` |
| `mapa-mental` | Duas telas (D16): **Criação** — blocos com responsável, prazo, checklist, anexos, cor, link e executor (humano/IA), ligações e desbloqueios, em rascunho; **Ao vivo** — o mapa publicado, cumprido etapa por etapa. Bloco vira tarefa | `tarefas`, `trilhas` |
| `publicacoes` | Calendário de postagens por cliente e publicação agendada automática (Instagram e Facebook pela Meta primeiro; TikTok e YouTube depois de pesquisa) | `clientes`, `calendario`, `aprovacoes` |
| `ia-da-agencia` | Chat no mapa que cria os blocos; organizador do mês; checklist da Apresentação; rascunho de proposta/apresentação; árvore de links; **executor IA** (D17): criar campanha (pausada) no gerenciador de anúncios, agendar publicação | `mapa-mental`, `clientes`, `contratos`, `publicacoes` |

Sem ciclos: as setas só apontam para cima na tabela.

## Ordem de construção

Cada fase termina com algo **usável de verdade** pela agência.

| Fase | Módulos | O que vocês passam a usar ao final |
|---|---|---|
| 1 | `equipe`, `whatsapp-agencia`, `avisos` | Equipe cadastrada, cada um entra na sua área e recebe um aviso de teste no WhatsApp. |
| 2 | `clientes`, `acervo`, `tarefas` | **O sistema de tarefas do vídeo**, já com clientes reais: mandar a edição para o editor e ele ser avisado; cronômetro; atrasadas. Cada cliente nasce com a sua pasta no Drive, e os anexos das tarefas vão para lá. |
| 3 | `calendario` | Reuniões com participantes e link do Meet; agenda da semana. |
| 4 | `trilhas` | Cliente novo entra e as Etapas 1 e 2 se montam sozinhas, com prazos, desbloqueio e relógio. |
| 5 | `cofre-de-acessos`, `formulario` | Formulário dentro da central; senhas guardadas com segurança e exportáveis. Aposenta o subdomínio do formulário. |
| 6 | `contratos` | Gerar o contrato em PDF preenchendo os campos. Depois: ZapSign e InfinitePay detectando assinatura e pagamento, e o grupo criado sozinho. |
| 7 | `aprovacoes` | Cliente aprova vídeos, roteiros, artes e estratégia pela organização dele. |
| 8 | `mapa-mental`, `publicacoes` | Mapa com as telas Criação e Ao vivo e fases que desbloqueiam; calendário de postagens e publicação agendada. |
| 9 | `ia-da-agencia` | IA montando o mapa, organizando o mês, rascunhando proposta e contrato, e executando os blocos marcados "IA" (campanha pausada para aval, publicação agendada). |

**Preparado desde a Fase 2:** a tarefa já nasce com o campo "quem executa"
(humano/IA), mesmo que até a Fase 9 só exista o humano — assim os blocos da IA não
exigem refazer tarefas depois.

Por que essa ordem: tarefas e avisos são a base de quase tudo (a trilha, o mapa e
as aprovações acabam virando tarefas e avisos), e a Fase 2 já entrega o ganho que
vocês viram no vídeo. Contratos ficam na 6 porque precisam dos modelos que virão do
outro chat e porque, enquanto isso, o processo atual (Claude + ZapSign +
InfinitePay) continua funcionando. A IA vem por último porque organiza dados que
as fases anteriores criam.

## Pesquisas antes das fases que dependem delas

| Assunto | Pergunta | Fase |
|---|---|---|
| InfinitePay | Tem API para criar link de pagamento e avisar (webhook) quando o cliente pagou? Se não tiver, a confirmação fica manual. | 6 |
| ZapSign | API de envio e webhook de assinatura (a ZapSign oferece; confirmar no plano de vocês). | 6 |
| WhatsApp (WAHA) | Criar grupo e adicionar participantes pelo número da agência. A API do WAHA tem isso; o sistema ainda não usa. | 1 |
| Canva | A API que preenche modelos (Autofill) exige plano Canva Enterprise. Alternativa: o sistema gerar a apresentação a partir de um modelo próprio. | 9 |
| Google Drive | Conta pessoal com Google AI Pro (5 TB) **não tem "Drive compartilhado"**, que é recurso do Google Workspace. Equivalente: uma pasta raiz "Clientes" no Drive da conta da agência, **compartilhada** com a equipe. Para os arquivos continuarem sendo da agência (e contarem nos 5 TB dela), o envio é feito **pela central**, com o login da conta da agência; arquivo que um membro arrastar direto no Drive fica em nome dele. Escopo `drive.file` basta, porque as pastas nascem pela central. O Gemini do plano é usado à mão por quem estiver no Drive; a IA da central lê o Drive pela API. | 2 |
| Meta (anúncios e publicação) | A instalação já guarda um token da Meta para anúncios, insights e catálogo (migration 9002). Conferir se as permissões dele cobrem **criar campanha** (`ads_management`) e **publicar conteúdo** (`instagram_content_publish`, `pages_manage_posts`). | 8–9 |
| TikTok e YouTube | Publicação agendada exige app aprovado em cada plataforma. | 8 |
| Árvore de links | Gerar no computador do dono via IA é frágil (depende da máquina ligada). Alternativa recomendada: a central publicar a página de links de cada cliente (ex.: `links.emmovimento.tech/turbo-kids`). | 9 |

## Limites

- **Sempre:** toda tabela da agência nova com regra de acesso no banco; todo envio de WhatsApp respeita o ritmo anti-bloqueio que o sistema já tem; migrations versionadas + apêndice no `baseline.sql`; tela provada no navegador, no celular e no computador.
- **Perguntar antes:** mexer em tela ou tabela que as organizações já usam (a aba de aprovações é a única fase que toca o lado do cliente); adicionar dependência nova; integrações pagas.
- **Nunca:** senha em texto puro no banco, em log ou em mensagem de WhatsApp; equipe com acesso ao painel administrador; o grupo de WhatsApp sendo criado sem assinatura **e** pagamento confirmados.

## Perguntas respondidas (23/10/2026)

- **P1** — Dia 15 exato entra no caso do mês corrente (preparação mais curta). Regra completa na seção "Calendário do contrato".
- **P2** — Etapa 3 descrita na seção "Ciclo mensal"; o calendário de postagens volta para a Fase 8.
- **P3** — YouTube fora do formulário: vem junto com o acesso Google.
- **P4** — Sem prazos fixos: cada passo recebe data e hora preenchidas por quem planeja.

---

## Apêndice A — Checklist sugerido para a reunião de Apresentação

**O negócio**
1. O que vocês vendem e qual é o carro-chefe (o que mais dá lucro, não só o que mais vende)?
2. Ticket médio e margem aproximada.
3. Há quanto tempo existem e como os clientes chegam hoje (indicação, rua, Instagram, Google)?
4. Tem sazonalidade? Quais são os meses fortes e fracos?

**O cliente deles**
5. Quem é o cliente ideal (idade, região, poder de compra)?
6. Por que o cliente compra deles e não do concorrente?
7. Quais objeções o cliente mais faz antes de fechar?

**Concorrência**
8. Quais concorrentes mais preocupam, e o que eles fazem bem nas redes?

**Objetivo com o marketing**
9. O que seria sucesso daqui a 3 meses: visibilidade, mais vendas, rede mais bonita, outro?
10. Qual meta concreta (faturamento, clientes por mês, seguidores)?
11. O que já tentaram em marketing, o que funcionou e o que não funcionou?

**Operação e conteúdo**
12. Quem pode aparecer nos vídeos (dono, funcionário) e tem facilidade para falar?
13. Melhores dias e horários para gravar no local.
14. Capacidade de atender: se o marketing trouxer o dobro de clientes, eles dão conta?
15. Verba disponível para anúncios por mês.

## Apêndice B — Perguntas do formulário atual

Lido de `formulario.emmovimento.tech/api/form-config` em 23/10/2026. Aceita várias
empresas do mesmo grupo (repete CNPJ, site, contatos e endereços por empresa),
salva rascunho e expira em 72 h.

1. Nome da empresa
2. CNPJ
3. Site oficial
4. Contatos oficiais: telefone fixo/central, WhatsApp comercial, e-mail geral
5. Endereços da loja ou unidades
6. Horários de atendimento
7. Responsáveis por setor (nome e cargo)
8. Produtos ou serviços (texto ou arquivo)
9. Aviso sobre acessos corporativos
10. Acesso ao Instagram (usuário/e-mail e senha)
11. Acesso ao Facebook (página, e-mail vinculado e senha)
12. Acesso ao Google Meu Negócio
13. Acesso ao TikTok
14. Identidade visual (upload)
15. Fotos e gravações da empresa (upload)
16. Observações gerais
