# O que a instalação pede — na ordem, e o que acontece se pular

Fonte: a lista `FIELDS` e os validadores de `hostgator-setup-kit/install.sh` (v1.17.0). O
instalador mostra uma tela de conferência numerada antes de gravar; para corrigir um valor, digite
o número dele. `voltar` refaz a pergunta anterior. Interrompeu? Rode de novo: ele retoma do
`.env.partial` (o token do Supabase nunca é guardado ali).

## Pergunta prévia: qual IA atende

Menu `[1] OpenRouter · [2] Anthropic (Enter) · [3] OpenAI`. Decide **qual** chave será pedida — só
a do provedor escolhido. No modo `--yes`, sem escolha, o padrão é Anthropic.

## Obrigatórios

| campo | o que é, em português | como o instalador valida |
|---|---|---|
| `DOMAIN` | o endereço do CRM, ex. `crm.suaempresa.com.br` — só o domínio, sem `https://` nem barra | tem ponto, sem esquema, sem caminho |
| `ACME_EMAIL` | e-mail que recebe avisos do certificado (SSL) | formato de e-mail |
| `APP_IMAGE` | a versão que vai rodar — **deixe o padrão** (última versão publicada com as três imagens) | cascata: versão → `stable` → build local → `latest` |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL do Supabase (Settings › API) | chamada real a `/auth/v1/health` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key (Settings › API) | lê o papel dentro da chave e testa |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key — **secreta** | idem, contra a admin API |
| `SUPABASE_DB_URL` | connection string **Session pooler, modo URI** (Settings › Database) — secreta | recusa `[YOUR-PASSWORD]`, recusa host `db.<ref>.supabase.co` (Direct, só IPv6), confere que é o mesmo projeto da URL, e **abre uma conexão de verdade** |
| chave do provedor de IA | `ANTHROPIC_API_KEY` (`sk-ant-`), `OPENROUTER_API_KEY` (`sk-or-`) ou `OPENAI_API_KEY` (`sk-`) | prefixo + chamada real ao provedor (uma chave sem crédito passa; "recusada" é 401) |
| `OWNER_EMAIL` | e-mail do primeiro admin (o dono) | formato |
| `OWNER_PASSWORD` | senha do dono — secreta | mínimo 8 caracteres |

Se o token do Supabase for informado e as 4 credenciais estiverem vazias, o instalador **cria o
projeto** e preenche as quatro sozinho (`hostgator-setup-kit/supabase-provision.sh`).

## Opcionais — e o que acontece se pular (Enter)

| campo | se pular |
|---|---|
| `SUPABASE_ACCESS_TOKEN` (token pessoal, **não fica salvo**) | projeto criado à mão (4 cópias); os e-mails de acesso saem no modelo em inglês do Supabase e o **Site URL fica `localhost:3000`** — "esqueci minha senha", confirmação de cadastro e aceite de convite chegam com link quebrado até alguém configurar Authentication › URL Configuration (`Site URL = https://DOMÍNIO`, `Redirect = https://DOMÍNIO/auth/confirm`). O instalador imprime essa pendência no fim; `hostgator-setup-kit/marca-emails.sh` resolve depois, com o token |
| `OPENAI_API_KEY` extra (quando a IA não é OpenAI) | o agente **não ouve áudio** nem indexa/consulta a base de conhecimento até alguém cadastrar a chave da OpenAI em IA › Credenciais (não precisa mexer no `.env`) |
| `APP_NAME` (padrão `DeskcommCRM`) | é a **semente** do nome; depois muda em Configurações › Marca |
| `APP_LOCALE` (1 = Português, 2 = Español) | grava o idioma da organização |
| `APP_ACCENT_HEX` (ex. `#7a5cd6`) | a cor do produto (verde) na tela e nos e-mails |
| `SUPPORT_EMAIL` | a tela de "conta suspensa" fica sem endereço de contato |
| `RESEND_API_KEY` + `RESEND_FROM_EMAIL` | envio de e-mail **desligado**: o convite mostra o link de aceite na própria tela; o export de LGPD fica pendente. O remetente precisa ser de um domínio **verificado** na Resend, senão toda tentativa falha com mensagem opaca |
| Telemetria (`s/N`, padrão **não enviar**) | só erros, com CPF/telefone/e-mail redigidos, sem replay. `--yes` → não envia. Copiando o `.env` do exemplo a pergunta não aparece e sai **ligada** (issue #668) — escreva `SENTRY_DSN=off` |

## O que o instalador gera sozinho (não peça)

`INTERNAL_SECRET`, `INTERNAL_CRON_SECRET`, chaves de cifra (CPF, credenciais de IA, WAHA próprio,
Nuvemshop), `IMPERSONATE_COOKIE_SECRET`, `LGPD_SIGNING_KEY`, segredo e chave do WAHA (com o hash
SHA-512 que o contêiner exige), token do Redis. Vazios mas preservados: Google Calendar, VAPID (push),
`APP_LOGO_URL`, gateway de IA.

## As quatro fases que ele imprime

1. **Preparar o servidor** — ferramentas, Docker (instala se faltar), portas 80/443 livres (teste
   real de bind), RAM (avisa abaixo de ~3,5 GB, não bloqueia).
2. **Informações** — proxy da hospedagem (detecta Traefik; em modo host pede confirmação), token e
   provisionamento, a entrevista acima, conferência.
3. **Banco e domínio** — DNS (espera junto), extensões (`vector`, `citext`, `pg_trgm`), o
   `baseline.sql` (o schema inteiro, idempotente), e-mails de acesso (com token), o dono.
4. **Subir** — puxa as imagens da versão, sobe os 7 contêineres, confere `/api/v1/health`, instala
   o cron das automações (sem ele, follow-ups e automações **nunca rodam**) e o cron do agente de
   atualização pela tela.
