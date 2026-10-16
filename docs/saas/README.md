# O seu SaaS com o DeskcommCRM

Este é o caminho de quem quer **revender o DeskcommCRM como produto próprio**: uma instalação
numa VPS sua, várias empresas-clientes dentro dela, cada uma pagando um plano, com a sua marca.
A licença MIT permite hospedar para terceiros, revender e cobrar o que quiser, sem royalty.

Siga na ordem. Cada etapa aponta para o guia que a cobre.

| # | Etapa | Guia |
|---|---|---|
| 1 | Entender o modelo: uma instalação, várias empresas | [abaixo](#1-o-modelo) |
| 2 | Contratar a VPS, instalar o Coolify, o CRM e o banco | [`coolify.md`](coolify.md) |
| 3 | Primeiro dia de dono: marca, cadastro, e-mail | [abaixo](#3-primeiro-dia-de-dono) |
| 4 | Criar e entregar o primeiro cliente | [abaixo](#4-o-primeiro-cliente) |
| 5 | Cobrar: planos, Stripe ou Asaas, régua de atraso | [`cobranca.md`](cobranca.md) |
| 6 | Contrato e LGPD com o cliente final | [`contrato-e-lgpd.md`](contrato-e-lgpd.md) |
| 7 | Dia a dia: custo por cliente, atualizar, backup | [abaixo](#7-dia-a-dia) |

Roteiros de aula para quem ensina este caminho estão em [`aulas/`](aulas/README.md).

Quem usa um assistente de IA (Claude Code, Codex, Cursor, OpenCode ou Antigravity) dentro de
um clone deste repositório tem o guia `deskcomm-saas`, que conduz estas etapas pela conversa.

## 1. O modelo

Você é o **dono da instalação**, e cada cliente seu é uma **empresa** dentro dela, com equipe,
agentes de IA, WhatsApp e dados próprios. Os dados de uma empresa não aparecem para outra, e
isso é testado automaticamente a cada mudança de código: o teste cria duas empresas e confere
que uma não lê a outra.

**Cliente novo é uma empresa nova no seu painel, não uma instalação nova.** Uma instalação
separada por cliente só compensa quando o cliente exige domínio e marca próprios na tela de
login, ou quando ele não pode cair junto com os outros.

| | Uma instalação para todos | Uma instalação por cliente |
|---|---|---|
| Custo de servidor | Uma VPS | Uma VPS por cliente |
| Marca na tela de login | A sua | A do cliente |
| Se o servidor cair | Todos param | Só aquele cliente para |
| Atualização | Todos de uma vez | Uma por vez |

## 2. A instalação

Siga [`coolify.md`](coolify.md). Ele instala o Coolify (o painel que publica o site e cuida do
cadeado do HTTPS), o CRM e o banco de dados, todos na mesma VPS, e foi medido de ponta a ponta,
inclusive a atualização pelo botão da tela. A VPS precisa de **8 GB de memória** para os três
juntos (a conta está no guia).

Sem Coolify, o caminho mais curto é o [Deploy na HostGator](../deploy-hostgator/README.md).

## 3. Primeiro dia de dono

Tudo no painel do dono, em `https://SEU_DOMINIO/admin`:

- **Marca:** nome, logo e cor do seu produto. Vale na hora. Cada empresa-cliente também pode
  ter a marca dela (Configurações › Marca). A regra de onde a marca aparece está em
  [`../white-label.md`](../white-label.md).
- **Credenciais:** o e-mail de suporte que o cliente vê nas telas de conta suspensa e de
  cobrança.
- **E-mail:** o servidor de envio (SMTP). Clique em **Salvar** e depois em **Testar conexão**:
  o teste usa o que já está salvo. Na instalação com o banco na VPS, rode depois
  `bash hostgator-setup-kit/update.sh` na pasta do sistema: é ele que leva o e-mail também ao
  "esqueci a senha" e à confirmação de cadastro.
- **Cadastro:** quem pode criar conta sozinho. *Aberto* serve a produto de autoatendimento,
  *com aprovação* deixa você filtrar, e *só por convite* serve a quem vende e cria cada cliente.
  Quem tem convite válido entra em qualquer modo.
- **Verificação em duas etapas** para você, em Configurações › Segurança: o dono enxerga todas
  as empresas.

## 4. O primeiro cliente

1. No painel, **Tenants** › **Novo tenant**.
2. Preencha o nome da empresa, a **Razão social** (vai nos documentos de LGPD) e o **e-mail do
   responsável**, que é o dono do lado do cliente.
   Nunca use o seu e-mail: a empresa vira sua e nenhum convite sai.
3. Com a cobrança ligada ([`cobranca.md`](cobranca.md)), escolha o **Plano de cobrança**: a
   empresa começa em teste grátis pelos dias do plano. Sem plano, ela é **isenta**.
4. O convite vale 24 horas. Sem e-mail configurado, use **Copiar convite** e mande o link.
5. Enquanto o cliente não aceita, você é administrador provisório e pode deixar a empresa pronta.
   Para montar os agentes, roteadores e follow-ups por nicho, use o guia
   [`deskcomm-cliente-novo`](../../.agents/skills/deskcomm-cliente-novo/SKILL.md).

**Excluir uma empresa** só é possível depois de suspendê-la à mão (Tenants › empresa ›
Suspender tenant, depois Excluir tenant). O e-mail de acesso de quem está numa empresa se troca
em Tenants › empresa › Membros e e-mails de acesso › Alterar e-mail.

## 7. Dia a dia

**Custo por cliente.** O maior risco é a IA. Com a **chave do cliente** (BYOK, cadastrada na
empresa dele, em Agente de IA › Credenciais), quem paga a IA é ele, e se o saldo acabar só ele
para. Com a **chave da instalação** (no `.env` do servidor), quem paga é você, e um saldo zerado
para todos os clientes. Cada empresa tem um orçamento mensal em Agente de IA › Uso e orçamento
(`/app/ai/usage`), que começa **sem limite**. O painel **Usage** mostra mensagens, conversas e custo por empresa e exporta
planilha.

**Atualizar e fazer backup:** seções "Atualizar" e "Backup" de [`coolify.md`](coolify.md). O
backup não é agendado pelo instalador. Para agendar todo dia às 3h, rode `crontab -e` na VPS e
acrescente a linha que o próprio `hostgator-setup-kit/backup.sh` sugere no cabeçalho:

```
0 3 * * * cd /root/deskcommcrm && bash hostgator-setup-kit/backup.sh
```

Rodar pelo agendador não foi conferido: no dia seguinte, confira com
`ls -lt ~/deskcommcrm/backups | head` se apareceu um arquivo novo. E leve a cópia para fora da
VPS.
