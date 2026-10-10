-- O PAÍS DA ORGANIZAÇÃO — onde moram o documento do titular, a lei citada e o
-- prazo do direito de acesso.
--
-- ─── o defeito, medido (issue #1033, decisão do dono 25-a) ───────────────────
--
-- O produto já saiu do Brasil pela TELA: fala espanhol (`lib/i18n/idiomas.ts`),
-- oferece peso mexicano e dólar (`lib/money.ts`) e deixa a organização escolher
-- moeda e fuso (`organizations.currency`, `organizations.timezone`, com seletor
-- em Configurações › Empresa). O que NÃO saiu do Brasil é tudo que tem lei
-- dentro, e o custo disso foi medido em `origin/main` `491a726a3`:
--
--   • o contato só sabe validar CPF (`lib/schemas/contacts.ts`, mod-11 da
--     Receita Federal), e o normalizador da importação por planilha apaga
--     LETRAS (`lib/contacts/csv.ts`, `replace(/\D/g,"")`) — o que destrói, por
--     exemplo, um documento que tenha letra no meio;
--   • o anonimizador que esconde dado pessoal antes de mandar a conversa para a
--     IA conhece quatro padrões, todos brasileiros (`lib/ai/anonymize/index.ts`).
--     Medido, rodando as regex do arquivo: "003862011LA042" -> "003862011LA042"
--     e "541712345" -> "541712345", ou seja, o documento ESTRANGEIRO passa
--     INTACTO para o modelo (o controle brasileiro "52998224725" -> "[cpf]"");
--   • o PDF do direito de acesso afirma `Base legal: LGPD Art. 18, II (Lei nº
--     13.709/2018)` (`lib/lgpd/pdf-renderer.tsx`) e rotula o campo como "CPF:";
--   • o prazo desse direito é contado em dias úteis BRASILEIROS
--     (`lib/lgpd/sla.ts` + `lib/lgpd/holidays-br.ts`, Tiradentes e Corpus
--     Christi até 2030). Trocar a lei citada sem trocar o calendário produziria
--     um documento que afirma um prazo que o sistema não cumpre;
--   • não existe onde guardar a resposta: `git grep` por `country` não devolvia
--     uma linha sequer no schema.
--
-- ─── o que esta migration entrega ────────────────────────────────────────────
--
-- (1) `organizations.country`: o país da organização, ISO-3166 alpha-2 em
--     maiúsculas, com CHECK de FORMA — `null` é Brasil. A localização é por
--     ORGANIZAÇÃO, e não por instalação: duas organizações no mesmo banco podem
--     estar em países diferentes e cada uma vê o documento, a lei e o prazo da
--     dela (um `APP_COUNTRY` no `.env` responderia por processo, e o processo
--     serve todas).
--
-- (2) SEM `default` e SEM backfill — de propósito. Nenhuma linha existente é
--     reescrita e nenhum DEFAULT de outra coluna muda: quem já instalou
--     continua exatamente onde está, e a linha vazia vale o perfil brasileiro,
--     que é o comportamento de antes desta migration (mesma escolha de
--     `lib/catalogo/moeda-da-org.ts` para a moeda).
--
-- ─── o que esta migration NÃO faz ────────────────────────────────────────────
--
-- Não cria tabela de países, não guarda texto de lei e não semeia feriado: o
-- perfil do país é CÓDIGO (`lib/legal/perfil-do-pais.ts`), versionado com o
-- produto, e não configuração por instalação. País entra no perfil com a
-- citação da lei REVISADA — o documento responde a um direito legal do titular,
-- e citar a lei errada é pior do que não citar artigo nenhum. É também por isso
-- que a coluna não tem FK para um catálogo: o catálogo é o registro em código,
-- que sabe quais países estão prontos e quais não estão.
--
-- ⚠️ Nada de RLS, grant ou policy nesta migration: a coluna nasce na tabela que
-- já tem as regras dela, e o valor é lido pela sessão do próprio membro da
-- organização (a tela de Configurações › Empresa já é admin-only por rota).

alter table public.organizations
  add column if not exists country text;

-- A trava de forma entra em separado, e não embutida no `add column if not
-- exists`: quem ATUALIZA (a coluna já existe) precisa da constraint tanto
-- quanto quem instala do zero, e o `drop ... if exists` deixa a migration
-- re-aplicável — a mesma lição idempotente do resto do repositório.
alter table public.organizations
  drop constraint if exists organizations_country_check;

alter table public.organizations
  add constraint organizations_country_check
  check (country is null or country ~ '^[A-Z]{2}$');

comment on column public.organizations.country is
  'O país DA ORGANIZAÇÃO (ISO-3166 alpha-2, maiúsculas; null = Brasil), de onde saem o rótulo e a '
  'validação do documento do contato, a lei citada no PDF de acesso ao titular, o calendário de dias '
  'úteis do prazo desse direito e os padrões de dado pessoal que o anonimizador redige antes de a '
  'conversa ir para o modelo. Resolvido por lib/legal/perfil-do-pais.ts — nenhuma rota lê esta coluna '
  'inline, pela mesma razão escrita em lib/catalogo/moeda-da-org.ts: duas leituras divergem no dia em '
  'que uma ganhar fallback e a outra não, e aqui a divergência prometeria a lei de um país com o prazo '
  'de outro. Sem default e sem backfill: null é o perfil brasileiro, o comportamento de antes da 0277. '
  'País só é oferecido no seletor quando a citação da lei dele já foi revisada por quem pode revisar.';
