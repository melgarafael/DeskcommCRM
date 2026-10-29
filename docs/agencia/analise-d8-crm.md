# Análise do D8-Crm (crm.oneinvestimento.com) — o que agregar à área da agência

> Feita em 29/10/2026, a pedido do dono, **só por leitura do código público** que o site entrega
> ao navegador: o manifesto do build, os 129 arquivos JavaScript das telas e os textos (traduções)
> que vêm na página. **Nenhum botão foi clicado, nenhuma tela foi aberta além da que já estava e
> nada foi criado ou alterado lá.** Não copiamos código deles: este documento descreve
> **funcionalidades e decisões**, para construirmos do nosso jeito.
>
> **Limite honesto:** o código do servidor (PHP) e o banco não ficam visíveis. O que está em
> "back-end" abaixo é **deduzido** dos endereços que a tela chama, dos nomes de rota e dos
> textos. Os itens marcados *(inferido)* não puderam ser lidos.

---

## 1. O que é o sistema

| Item | O que se viu |
|---|---|
| Nome | "D8-Crm" na aba; a tela inicial chama de **"V8 Tasks"** ("A maneira moderna de gerenciar seu negócio") |
| Servidor | **Laravel** (PHP) com **Inertia.js**: as telas recebem os dados prontos do servidor, sem API REST separada |
| Tela | **Vue 3** + Vite + shadcn-vue (Reka UI) + ícones Lucide + Tailwind |
| Autenticação | Kit oficial do Laravel (Fortify): login, cadastro, verificar e-mail, esqueci a senha, **2FA com QR e códigos de recuperação**, confirmar senha |
| Idiomas | Textos por chave (292 chaves), pt-BR ativo, com tela de idioma |
| Multiempresa | **Workspaces**: o usuário tem vários e um atual (`auth.workspaces`, `auth.current_workspace`) |
| Tamanho | 34 telas, 46 endereços fixos de servidor e cerca de 1,3 MB de JavaScript |

## 2. Mapa das telas

| Área | Telas | O que faz |
|---|---|---|
| Painel | Dashboard | Totais (tarefas, concluídas, clientes, clientes ativos, em andamento), **tarefas por status**, **distribuição por tags**, filtro por período e tag, **exportar PDF** (`dashboard.pdf.completed`) |
| Clientes | Lista, criar, editar, ficha | Campos: empresa, nome, e-mail, telefone, situação (Ativo / Inativo / **Prospecção**), tags. A ficha tem **Tarefas, Notas e Lembretes** do cliente |
| Empresas | Lista, criar, editar | Agrupam clientes. **Relatório em PDF por empresa** (`/companies/{id}/report/pdf`) |
| Tarefas | Quadro (kanban), **Agenda**, **Ranking**, **Tickets** | Ver §3 |
| Tarefas recorrentes | Lista e formulário | Padrão diário, semanal (dias da semana), mensal (dias do mês) ou **uma vez**; hora, início, fim opcional, ativa; mostra a **próxima execução** |
| Tags | Lista e criar | Para clientes e tarefas; nome e cor |
| Departamentos | Lista e modal | Agrupam usuários; usuário escolhe departamentos |
| Usuários | Lista e modal | Nome, e-mail, função, departamentos e senha |
| **Ticket público** | `Public/Ticket` | **Formulário sem login**: título, descrição e prioridade → "Enviar Ticket" (`tickets.store`) |
| Configurações | Perfil (com avatar), senha, 2FA, aparência (claro/escuro/sistema), idioma, **Automações** | Ver §4 |

## 3. Tarefas (o coração do sistema)

- **Modal da tarefa:** título, descrição, status (Backlog / A fazer / Em andamento / Revisão /
  Concluído), prioridade, **data limite**, cliente, **vários responsáveis**, tags (com "nova tag"
  ali mesmo), **checklist** com **"Criar tarefas em lote" a partir dos itens**, **anexos** e a
  **pasta no Drive criada pela automação**, com o estado e o botão "Tentar novamente".
- **Cronômetro** por tarefa (`tasks.timer.toggle`) e lançamento de horas (`/tasks/{id}/time`).
- **Quadro com colunas personalizáveis:** título, **cor** e **ícone** de cada coluna, guardados
  no navegador (`task_columns_settings`); arrastar e soltar.
- **Agenda** (as tarefas por dia) e **Ranking de empresas** com mais tarefas em aberto.
- **Tickets:** os pedidos que chegam pelo formulário público aparecem como tarefas, com o botão
  **"Pegar"** (claim), para alguém assumir.
- **Filtros:** por tag, por usuário, **por atribuição** (de um usuário só / compartilhadas) e
  **por período de criação**.
- **Tarefa por voz** ("Por voz" → "Criar tarefa por voz"):
  1. o navegador grava e transcreve **sozinho**, pelo reconhecimento de voz do próprio navegador
     (Web Speech API), sem custo de servidor;
  2. a pessoa **revisa o texto** antes;
  3. o texto vai para `POST /tasks/voice/parse`, e o servidor devolve os campos (`parsed`) que
     **preenchem o modal da tarefa** *(no servidor, provavelmente uma IA lê o texto e separa
     título, cliente, prazo e responsável — inferido)*;
  4. as mensagens de erro foram pensadas para o usuário: microfone negado, nenhuma fala, sessão
     expirada.
- **Notificações de tarefa** chegam junto com cada página (`taskNotifications`).

## 4. Automações por tag → pasta no Google Drive

- **Uma conexão Google Drive por workspace** (OAuth), com estados conectado / precisa reconectar /
  não conectado, **"Testar conexão"** e "Desconectar".
- **Regra:** *quando a tarefa recebe a tag X → criar pasta no Drive*. O caminho é configurável
  (relativo ao Meu Drive), com **prévia ao vivo** ("v8-crm / workspace / caminho / #123 - Título
  da tarefa") e validações (sem "..", até 10 níveis e 120 caracteres por pasta). A subpasta
  usa o nome da tag por padrão.
- **Execuções recentes:** as últimas 20, com estado (pendente / executando / concluído / falhou)
  e **"Tentar novamente"**. *(No servidor, uma fila de jobs do Laravel — inferido pelos estados.)*
- Mudar o caminho só vale para as tarefas seguintes; as pastas já criadas ficam.

## 5. Back-end deduzido (rotas e dados)

**Rotas que a tela chama:** `clients` (index, create, store, show, edit, update, destroy),
`clients.notes.store`, `clients.reminders.store`, `companies` (CRUD) + `report/pdf`,
`departments`, `users`, `tags` (CRUD), `tasks` (CRUD) + `attachments`, `time`, `timer.toggle`,
`voice.parse`, `checklist.update`, `recurring-tasks` (CRUD), `tickets.create`, `tickets.store`
(público), `settings/automations` + `google`, `google/connect` e `google/test`,
`dashboard.pdf`, mais as de autenticação e 2FA do Fortify.

**Modelo de dados inferido:** workspace → (empresas → clientes) · tarefas (status, prioridade,
prazo, cliente, responsáveis N:N, tags N:N, checklist, anexos, tempo, pasta do Drive) · notas e
lembretes do cliente · tarefas recorrentes (padrão, dias, hora, início, fim, próxima execução) ·
tags · departamentos · usuários (função, departamentos) · automações (tag, ação, caminho,
ativa) · execuções da automação (estado, erro, tarefa) · tickets.

---

## 6. Comparação com a nossa área da agência

| Funcionalidade deles | Nós | Situação |
|---|---|---|
| Quadro, lista, ranking, checklist + lote, tags, links, anexos, cronômetro, recorrentes, atraso | ✅ (Fase 2) | Já temos, inclusive o lote e o ranking |
| Vários responsáveis, prioridade, prazo | ✅ | Já temos |
| Agenda das tarefas | ✅ calendário com os prazos | Já temos |
| Pasta do cliente no Drive | ✅ por cliente (8 subpastas) e o botão da pasta na tarefa | Temos por **cliente**; eles têm por **tarefa** |
| 2FA, perfil, tema claro/escuro | ✅ (núcleo do CRM) | Já temos |
| **Painel com métricas** (totais, por status, por tag, período e **PDF**) | ❌ o Início mostra só a lista do dia | **Falta** |
| **Notas e Lembretes na ficha do cliente** | ❌ | **Falta** |
| **Tarefa por voz** (ditar → revisar → IA preenche o modal) | ❌ | **Falta** (temos a camada de IA; falta a chave no teste) |
| **Ticket público** (pedido sem login → "Pegar") | ⚠️ Envios é da agência para o cliente; o caminho contrário não existe | **Falta** |
| **Automação por tag** (tag → ação, com execuções e tentar de novo) | ⚠️ nossos ganchos são fixos (trilha, mapa, envios) | **Falta** a regra configurável pela tela |
| **Colunas do quadro com cor e ícone** | ❌ colunas fixas | **Falta** (simples) |
| **Relatório PDF por cliente** (tarefas, horas) | ⚠️ temos PDF do cofre e do contrato | **Falta** o de trabalho |
| Filtro "por atribuição" e "por período de criação" | ⚠️ temos "Só as minhas" | **Falta** o período |
| Departamentos | ✅ equivalente: **funções** com permissões | Já temos (melhor: com permissão) |
| Workspaces | ✅ equivalente: organizações | Já temos |
| Situação do cliente | ✅ mais rica (prospecção → … → remarketing) | Já temos |

**Onde estamos à frente** (não há nada equivalente lá): trilha do cliente com reloginho,
calendário com reuniões, Meet e arrastar, cofre de acessos, formulário de acesso, contratos com
assinatura e pagamento, Envios (vídeo de até 2 GB aprovado dentro do sistema), mapa mental no
estilo do Fluxo, calendário de publicações e IA da agência.

---

## 7. O que recomendo agregar (em ordem)

| # | O quê | Por quê | Tamanho | Front-end | Back-end |
|---|---|---|---|---|---|
| 1 | **Notas e Lembretes na ficha do cliente** | Registro rápido de conversa e "me lembre dia X" sem criar tarefa | Pequeno | Aba nova na ficha: lista de notas (autor, data) e lembretes (data, hora, texto) | Tabelas `agencia_cliente_notas` e `agencia_cliente_lembretes`; o lembrete vencido vira aviso pelo relógio `agencia-prazos` (que já existe) |
| 2 | **Painel com métricas + PDF** | O dono vê a operação de uma vez e manda o resumo ao cliente | Médio | Início ganha cartões (tarefas abertas, concluídas no período, atrasadas, clientes ativos), gráfico por status, por etiqueta e por cliente, e filtro de período | Consultas agregadas; PDF com o mesmo gerador do contrato (`@react-pdf`) |
| 3 | **Tarefa por voz** | Criar tarefa no celular, andando, em segundos | Pequeno a médio | Botão "Por voz" no quadro: reconhecimento do navegador (grátis), revisão do texto e modal já preenchido | Ação que manda o texto à IA da agência (`pedirAIa`, já existe) com o formato da tarefa (título, cliente, prazo, responsável, checklist), validado por Zod. Sem chave de IA, fica só o ditado |
| 4 | **Pedidos do cliente (ticket)** | O cliente pede algo ("arte para sábado") sem WhatsApp perdido; vira tarefa com "Pegar" | Médio | Na aba Aprovações da organização do cliente, "Fazer um pedido" (com login, mais seguro que o formulário público deles); na agência, a coluna "Pedidos" no quadro com o botão "Pegar" | Tabela `agencia_pedidos` com `organization_id` e RLS de tenant (o mesmo padrão de `agencia_aprovacoes`); aviso para quem atende o cliente |
| 5 | **Automações por etiqueta** | "Tag *Gravação* → criar a pasta da tarefa no Drive"; "tag *Urgente* → avisar o gestor" | Médio | Configurações › Automações: regra (etiqueta → ação → caminho), prévia do caminho e lista de execuções com "Tentar de novo" | Tabela de regras e de execuções; a execução pela fila `event_log` que já temos (nunca no gatilho do banco), com estado e nova tentativa |
| 6 | **Colunas do quadro com cor e ícone** | Cada um deixa o quadro do seu jeito | Pequeno | Configurar coluna (título, cor, ícone) | Preferência por membro no banco (eles guardam só no navegador: troca de aparelho perde) |
| 7 | **Relatório PDF por cliente** | Entregar ao cliente o que foi feito no mês (tarefas e horas) | Pequeno | Botão na ficha | Rota PDF como a do cofre |
| 8 | **Filtro por período de criação** no quadro | Ver o que entrou na semana | Pequeno | Seletor de período | Filtro na consulta |

Os itens 1, 3, 6, 7 e 8 não pedem decisão: dá para construir direto. Os itens 2, 4 e 5 merecem
uma conversa rápida antes:
- painel: quais números importam;
- pedidos: se vêm só de dentro da organização do cliente ou também por link público;
- automações: quais ações entram na primeira versão.

## 8. O que não deu para ver

- Como o servidor transforma o texto ditado em campos (que IA, que regras).
- O conteúdo exato do PDF do painel e do relatório por empresa.
- Se as notificações de tarefa também saem por e-mail ou WhatsApp.
- Regras de permissão por função (o que cada papel pode fazer).

Para isso seria preciso o código do servidor ou abrir essas telas, e este levantamento foi feito
só por leitura.
