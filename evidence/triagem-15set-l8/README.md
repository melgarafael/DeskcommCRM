# Prova em tela do lote 8 da triagem — 15/set/2026

As imagens desta pasta são o lastro da QA visual da integração
`integracao/triagem-15set-l8`, testada no SHA **`33ece762a`** (worktree limpo,
`git status` vazio antes da primeira escrita).

**Ambiente, o mais perto possível de uma VPS recém-instalada:**

- Supabase local em **Postgres 17**, projeto próprio (`qa-l8`, portas 5732x), com o
  banco montado **só pelo `supabase/baseline.sql`** (`ON_ERROR_STOP=1`), sem as
  migrations — o que o `install.sh` aplica.
- Dono criado por `scripts/bootstrap-owner.ts` (platform admin, verificação em duas
  etapas não exigida) e onboarding concluído **pela tela**, pulando o opcional.
- `next build` (exit 0) + `next start`, com o `.env.e2e`. **Sem nenhuma `META_*`,
  sem `RESEND_API_KEY`, sem chave de IA, sem Google.**
- Playwright dirigindo Chromium de verdade contra `http://localhost:3021`. Os
  scripts recusavam rodar se o Supabase não fosse `127.0.0.1:57321`.
- Medidas por ferramenta (`getBoundingClientRect`, `scrollWidth`, `getComputedStyle`),
  nunca a olho.

**Um passo do `install.sh` que o ambiente de teste não tinha, e foi reproduzido:**
o instalador semeia a chave de cifra em `private.app_secrets`
(`ensure_encryption_key`, `hostgator-setup-kit/_common.sh`). O prelúdio do e2e não
faz isso. Sem ela, salvar a chave da Meta é recusado — com motivo, e sem gravar
nada (`861-extra-sem-chave-de-cifra-recusa-com-motivo.png`). A chave foi semeada
do mesmo jeito que o instalador semeia, e só então a jornada seguiu.

## #861 — `/admin/meta`, o App da Meta da instalação

- `861-01-seletor-gerenciar-organizacoes.png` — o caminho começa no seletor de
  organização, em "Gerenciar organizações". Nenhuma URL digitada.
- `861-02-menu-admin-api-oficial.png` — o menu da administração tem "API Oficial (Meta)".
- `861-03-tela-nunca-configurada.png` — "Nunca configurado por aqui.", o cartão do
  token diz "Ainda não existe…", **não há** botão de gerar token (contagem 0) e
  "Salvar" fica desabilitado vazio e com 15 caracteres; com 16, habilita (medido).
- `861-04-token-gerado-copie-agora.png` — chave de 32 caracteres salva: "Seu token
  de verificação" + "Copiar" + "Copie agora."; o campo da chave esvazia
  (valor `""`), o placeholder vira "(já cadastrada)", o estado diz "Gerado em …".
  O Copiar põe na área de transferência exatamente o token da tela (lido de volta).
- `861-05-conexoes-na-outra-aba.png` — "Abrir Conexões em outra aba" abre
  `/app/connections?aba=oficial` numa aba nova (2 abas no contexto).
- `861-06-token-segue-na-aba-original.png` — de volta à aba original, o mesmo token
  continua na tela.
- `861-07-recarregado-token-some.png` — depois de recarregar, o token não está nem
  na tela nem no HTML servido; fica "Gerado em …" e "Gerar novo token".
- `861-08-confirmacao-novo-token.png` — a confirmação diz o efeito: o token atual
  para de valer na hora, as mensagens seguem chegando. **Cancelar não gera**: o
  `verify_token_created_at` do banco ficou idêntico.
- `861-09-novo-token-diferente.png` — confirmar mostra um token **diferente** do primeiro.
- `861-10-400px-escuro-repouso.png`, `861-11-400px-escuro-confirmacao.png` e
  `861-12-400px-escuro-token-gerado.png` — 400px, tema escuro: `scrollWidth` 400 =
  `clientWidth` 400 nos três estados, nenhum elemento fora da viewport. O claro, a
  400px, também mede 400/400. Ressalva medida: o token de 43 caracteres não cabe
  inteiro no campo (rolagem interna 342px em 201px) — o "Copiar" leva o valor inteiro.
- `861-13-400px-escuro-conexoes-token-na-instalacao.png` — Conexões › API Oficial,
  com um canal oficial existente: "Já cadastrado na administração da instalação",
  nenhum "defina no servidor", o token não aparece, e o link para a administração
  existe para o dono e leva a `/admin/meta`.
- `861-14-admin-de-tenant-nao-abre-admin-meta.png` — admin de organização que não
  é platform admin: `/admin/meta` termina em `/admin/forbidden` ("Acesso negado"),
  o formulário não é renderizado, e o seletor dele não oferece "Gerenciar organizações".
- `861-15-admin-de-tenant-conexoes-sem-link.png` — o mesmo admin em Conexões: o
  aviso aparece, o link para a administração **não** (contagem 0).
- `861-extra-sem-chave-de-cifra-recusa-com-motivo.png` — ver o parágrafo do ambiente.

**Handshake da Meta (diagnóstico por `curl`, não prova de tela):** o canal oficial
não conecta sem Meta real (a credencial é validada na Graph API antes de gravar),
então a sessão `meta_cloud` foi **inserida por SQL**, com `webhook_path_token` gerado
pelo banco. Contra ela: token da tela depois da rotação → `200` com o corpo `x`;
token anterior à rotação → `403`; caminho inexistente → `404`. Repetido **99 ms
depois de uma rotação** (dentro dos 30 s do memo do resolvedor): novo `200`,
anterior `403`.

## #860 — Confirmar na aba "Aguardando confirmação"

Não há tela para ligar "exige aprovação" num tipo de agendamento. O campo foi
ligado por `PATCH /api/v1/agenda/tipos` **com a sessão do dono**, na mesma rota que
a tela de tipos usa (200). Jornada, tipo e pedidos foram criados pela tela.

- `860-01-marcando-pedido-no-tipo-com-aprovacao.png` — o pedido marcado pela grade,
  no tipo que exige aprovação; no banco nasce `pending`.
- `860-02-aba-aguardando-com-confirmar.png` — dois pedidos na aba, cada linha com
  Confirmar · Remarcar · Cancelar, nessa ordem.
- `860-03-linha-saiu-da-aba-aguardando.png` — Confirmar na aba: o contador vai de
  2 para 1 e a linha some da aba.
- `860-04-confirmado-aparece-em-proximos.png` — a mesma linha em "Próximos"; no
  banco, `confirmed`.
- `860-05-painel-do-confirmado-diz-agendado.png` — o painel do compromisso
  confirmado diz "Agendado" e não oferece "Confirmar horário".
- `860-06-painel-do-pendente-com-confirmar-horario.png` — o outro pedido, ainda
  pendente, tem "Confirmar horário" no painel.
- `860-07-painel-confirmou-vira-agendado.png` — confirmar pelo painel vira
  "Agendado"; contadores finais: 0 aguardando, 2 próximos.

## #858 — encaixe fora da grade pela pessoa

Tipo "Encaixe de 1 hora" (60 min), jornada 08:00–20:00.

- `858-01-grade-de-hora-cheia-1030-nao-clicavel.png` — na grade, o bloco das 10:30
  está desabilitado, com o motivo "fora dos horários que você publicou"; o das
  11:00 está livre.
- `858-02-painel-oferece-so-hora-cheia.png` — o painel "Novo agendamento" lista só
  horas cheias e não tem campo de hora livre (contagem 0). **Não há caminho de
  tela para marcar 10:30.**
- `858-03-encaixe-1030-marcado-pela-rota-aparece-na-grade.png` — a mesma sessão
  da pessoa, chamando `POST /api/v1/agenda/agendamentos` direto (diagnóstico,
  não tela): 10:30 → `201`; 20:30, fora do expediente → `201`; 09:30, por cima do
  compromisso das 9h → `422`. Os encaixes aparecem na grade. (O card de 18/set
  10:30 veio de uma tentativa de reproduzir o aviso de "Erro interno" descrito
  mais abaixo.)
- `858-04-recusa-por-cima-de-compromisso-mensagem.png` — **a recusa pela tela**:
  duas abas da mesma pessoa escolhem 17:00; a segunda marca; a primeira confirma e
  recebe `422` com o aviso "Este horário já está ocupado na agenda de quem atende —
  por outro compromisso ou pelo Google Agenda." O painel não diz "Marcado.".

Evento do Google Agenda ocupando o horário: **NÃO MEDIDO** (sem Google real).

**Defeito do lote, reportado e não consertado:** o fragmento
`.changes/pessoa-marca-fora-da-grade.md` promete que "uma pessoa da equipe marca em
qualquer horário livre" e que antes "nem pela tela isso era possível". A regra
existe no servidor, mas **nenhuma tela a alcança**: a grade só habilita bloco com
horário publicado (`GradeDaAgenda.tsx`, `CamadaDeMarcacao`), o arraste só aceita
horário publicado, e o painel só lista os horários da rota. Token de integração
não conta como pessoa (`podeMarcarForaDaGrade`). Na prática, a capacidade só se
usa chamando a API com o cookie da sessão. Dar a porta (um "outro horário" no
painel) não é um conserto pequeno; a outra saída é o fragmento não prometer tela.

## #859 — contato com telefone repetido

- `859-01-primeiro-contato-criado.png` — o primeiro contato com `+5511976543210`
  (201).
- `859-02-telefone-repetido-diz-o-motivo.png` — o mesmo telefone: `409
  contact_exists`, e o aviso diz "Já existe um contato com este telefone." (o ID
  do aviso é o `X-Request-Id` da resposta). O diálogo fica aberto.
- `859-03-mesmo-numero-sem-nono-digito.png` — `+551176543210`, sem o nono dígito:
  o mesmo `409` e a mesma frase. No banco fica **uma** linha com o número.

## Achados que não são do lote (sem imagem própria)

- **Aviso "Erro interno" uma vez na Agenda**, logo depois de recarregar. Medido no
  Kong do Supabase local: `POST /rest/v1/rpc/fn_user_role_in_org` → `502` no mesmo
  segundo, com a máquina em carga 130+. Não reproduziu em 5 recargas seguintes.
  Infra sob carga, não defeito do lote.
- **Os gatilhos de automação da Agenda não são emitidos quando uma pessoa marca ou
  confirma pela tela.** A cada criação e confirmação o servidor registrou
  `[agenda] gatilho de automação não foi emitido … new row violates row-level
  security policy for table "event_log"`. O handler grava em `event_log` com o
  cliente da sessão, e a única policy de INSERT da tabela é a de acompanhamento
  (`support_write_insert`). O lote não mexeu nesse trecho, e na `main` ele é igual.
- O painel de um compromisso mostra "Sincronização Google — Há alterações
  aguardando sincronização" numa instalação **sem** Google configurado
  (`860-06-painel-do-pendente-com-confirmar-horario.png`). O lote só reformatou
  essa linha.

## O que estas imagens NÃO provam

- Que a server action de `/admin/meta` recusa quem não é platform admin — a
  tela não chega a renderizar para ele; a action em si é coberta por unidade.
- A entrega real de mensagem da Meta (POST assinado) e a conexão de um número
  oficial de verdade.
- O Google Agenda como ocupação, em qualquer das jornadas.
- A IA marcando só na grade: não há chave de IA neste ambiente; coberto por
  `tests/unit/pessoa-marca-fora-da-grade.test.ts`.
