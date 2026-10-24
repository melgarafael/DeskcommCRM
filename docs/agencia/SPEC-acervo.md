# Spec: `acervo` — a pasta de cada cliente no Google Drive

> Fase 2 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **rascunho para aprovação** (24/10/2026).
> Depende de [`clientes`](SPEC-clientes.md). Decisão de origem: D20 do mapa.

## Objetivo

Tudo o que existe sobre um cliente fica numa pasta dele no Google Drive da agência,
criada sozinha. Nesta fase: conectar o Drive, criar a estrutura de pastas (inclusive
para os clientes que já existem), compartilhar com a equipe e guardar lá os anexos
das tarefas. Ler o Drive pela IA fica para a Fase 9.

## O que já existe e será reaproveitado

A central já tem um **app OAuth do Google** configurado em `/admin/google` (usado
pela Agenda), com as chaves guardadas pela instalação
(`lib/agenda/google/config.ts`). O Drive usa **o mesmo app**, pedindo o escopo
`https://www.googleapis.com/auth/drive.file` — que só dá acesso aos arquivos e
pastas que **a própria central criou**, nunca ao resto do Drive da conta.

A criptografia do token reaproveita `lib/crypto/aes_gcm.ts` (`encryptKey`/`decryptKey`).

## Decisões (propostas)

| # | Decisão | Por quê |
|---|---|---|
| A1 | **Uma conexão só, da agência** (a conta Google AI Pro de 5 TB), feita em `/agencia/configuracoes` por quem tem `configuracoes.gerenciar`. O refresh token fica cifrado no banco. | Os arquivos são da agência, não de um membro. |
| A2 | Escopo **`drive.file`**. | Menor privilégio: a central não enxerga nada do Drive que não tenha criado. As pastas começam do zero (decisão do dono), então não há pasta antiga para alcançar. |
| A3 | Estrutura fixa: `Clientes/<Nome do cliente>/` com as subpastas **01 Formulário · 02 Contrato e proposta · 03 Planejamento · 04 Identidade visual · 05 Captações · 06 Edições · 07 Artes · 08 Relatórios**. A pasta nasce quando o cliente é criado ou importado; um botão "Criar pastas que faltam" cobre os clientes de antes da conexão. | O pedido do dono: tudo de cada cliente num lugar, os próximos automáticos. |
| A4 | A pasta raiz `Clientes` é **compartilhada com o e-mail de cada membro ativo** (papel "leitor", ou "editor" para quem tem `clientes.gerenciar`). Membro desativado perde o compartilhamento. | Conta pessoal não tem Drive compartilhado; esta é a forma equivalente (mapa › Pesquisas). |
| A5 | **Upload direto do navegador para o Google**, por sessão resumível criada no servidor. O arquivo não passa pela VPS. | Vídeo de captação tem gigabytes; passar pela VPS ocuparia memória e disco do servidor. |
| A6 | Sem Drive conectado, nada quebra: anexos ficam indisponíveis com o aviso "Conecte o Google Drive em Configurações", e **links** continuam funcionando. | Instalação sem Drive não pode ter tela quebrada. |
| A7 | **Senhas nunca vão para o Drive** (D20). Nada desta spec escreve conteúdo do cofre. | Regra do mapa. |

## Dados

```sql
-- Conexão única da agência com o Google Drive.
create table if not exists public.agencia_drive (
  id                 boolean primary key default true check (id),
  conta_email        text,
  refresh_token_ct   bytea,       -- cifrado (aes_gcm), nunca em claro
  refresh_token_iv   bytea,
  refresh_token_tag  bytea,
  pasta_raiz_id      text,        -- "Clientes"
  conectado_em       timestamptz,
  conectado_por      uuid references auth.users(id) on delete set null,
  ultimo_erro        text,
  atualizado_em      timestamptz not null default now()
);

-- Cada arquivo que a central pôs no Drive (anexo de tarefa, upload na ficha).
create table if not exists public.agencia_arquivos (
  id             uuid primary key default gen_random_uuid(),
  cliente_id     uuid references public.agencia_clientes(id) on delete set null,
  tarefa_id      uuid,            -- FK para agencia_tarefas (spec tarefas)
  subpasta       text not null,   -- vocabulário fixo (A3)
  drive_file_id  text not null unique,
  nome           text not null,
  mime           text,
  tamanho_bytes  bigint,
  link           text not null,   -- webViewLink
  enviado_por    uuid references auth.users(id) on delete set null,
  criado_em      timestamptz not null default now()
);
-- E em agencia_clientes: drive_pasta_id (já na spec clientes) + drive_subpastas jsonb {"05 Captações": "<id>", …}.
```

## Como funciona

1. **Conectar:** "Conectar Google Drive" → tela do Google com a conta da agência →
   volta para `/api/v1/agencia/drive/callback` → troca o código, cifra o refresh
   token, cria a pasta `Clientes` e as dos clientes existentes, compartilha com a
   equipe. O callback entra em `lib/auth/public-paths.ts` (volta de outro site, o
   cookie Strict não viaja — mesmo caso do callback da Agenda), com `state` assinado.
2. **Cliente novo / importado:** cria `Clientes/<Nome>/` e as 8 subpastas.
   Renomear o cliente renomeia a pasta.
3. **Anexo:** a tela pede ao servidor uma sessão de upload para a subpasta certa →
   o navegador envia o arquivo direto ao Google, com barra de progresso → o
   servidor confirma e grava em `agencia_arquivos`.
4. **Membro ativado/desativado** (spec equipe): compartilha ou retira o acesso à
   pasta raiz.
5. **Falha do Google** (token revogado, cota): `ultimo_erro` aparece em
   Configurações com o que fazer ("Reconecte o Google Drive"), e um aviso geral vai
   para o dono (laço de retorno).

## Pré-requisito do dono (fora do código)

No **Google Cloud** do app que a central já usa para a Agenda: ativar a **Google
Drive API** e acrescentar o escopo `drive.file` à tela de consentimento. A tela de
Configurações mostra esse passo a passo quando a conexão falhar por isso.

## Testes

- **Unit:** montagem da estrutura de pastas (nomes e ordem); compartilhamento
  segue a situação do membro; erro do Google vira `ultimo_erro` em português, nunca
  exceção na tela; token nunca aparece em log.
- **Invariante:** `anon`/`authenticated` não leem `agencia_drive` nem `agencia_arquivos`.
- **Prova pela tela no teste, com o Drive de verdade:** conectar → ver a pasta
  `Clientes` e a de cada cliente no Drive → anexar um vídeo numa tarefa → abrir o
  link → desativar um membro e conferir que ele perdeu o acesso à pasta.

## Critérios de aceite

1. Conectar o Drive pela tela, com a conta da agência, sem editar arquivo nenhum na VPS.
2. Todo cliente (novo, importado ou antigo, pelo botão) tem a pasta com as 8 subpastas.
3. Anexo enviado numa tarefa aparece na subpasta certa do cliente e abre pelo link.
4. Membro ativo recebe acesso à pasta raiz; desativado perde.
5. Sem Drive conectado, as telas funcionam e dizem o que falta.

## Perguntas em aberto

- **A3** — Os nomes das 8 subpastas estão bons?
- **A4** — Toda a equipe vê a pasta de todos os clientes no Drive, ou só os que atende? (O Drive não sabe filtrar sozinho; "só os que atende" exigiria compartilhar pasta por pasta.)
