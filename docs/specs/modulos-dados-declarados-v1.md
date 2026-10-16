# Spec — Módulo de dados declarados (classe `data`), onda 1

**Status:** onda **1a entregue** (#2334, `40d03e2de`, 08/10/2026); onda **1b por fazer**. A decisão que
a sustenta é a [ADR-0005](../adr/0005-plataforma-de-modulos-de-terceiro.md), aceita em 14/10/2026.
**Escrita em:** `efed1d574` (02/10) como proposta. **Reescrita em:** `ccbae41fd` (14/10) como registro do
que foi entregue e do que falta.

> A onda 1 entrega o seguinte: um terceiro publica um **arquivo declarativo**, o administrador da
> instalação o instala, e aparecem no produto **tabelas reais, telas e ações de um nicho** — sem uma
> linha de código do terceiro executando em lugar nenhum, sem contêiner novo, sem egress, sem RAM
> adicional e com os dados dentro do backup do cliente.
>
> **Prova de aceite da onda inteira (1b):** portar o módulo de honorários, que hoje é código no
> repositório, para um artefato declarado, **sem nenhum PR no Core**. As lacunas que essa prova vai
> revelar já estão escritas no §7.3.

Como ler este documento: cada seção diz **o que existe** (com o caminho) e **o que falta**. Nada aqui
que está marcado "existe" é promessa; nada marcado "falta" está construído. Quando duvidar, rode o
comando que acompanha a seção.

---

## 1. O que a onda 1 NÃO entrega

Dito antes do resto, porque a doutrina proíbe anunciar o que não existe:

- nenhum código de terceiro executa (isso é a classe `connected`, onda 2);
- nenhuma integração externa, credencial de terceiro ou webhook de provedor;
- nenhum envio de mensagem;
- nenhum gancho no caminho quente (ingestão, dreno, turno, envio);
- nenhuma vitrine pública nem cobrança (onda 4);
- nenhuma avaliação, contagem de download ou telemetria.

---

## 2. O artefato

O mesmo pacote JSON estrito das extensões, com `profile: "data"`. Continua valendo: UTF-8, teto de
bytes, parser estrito, nenhuma chave desconhecida, nenhum `null`, licença declarada, e **nenhuma URL**
(o endereço vive no catálogo revisado — ADR-0003 D3). A validação é dupla: Zod no serviço
(`lib/extensions/manifest.ts`) e o vocabulário fechado de novo no banco, no compilador.

**Teto do artefato — falta.** Continua em 64 KiB (`EXTENSION_LIMITS.packageBytes` no TypeScript e
`octet_length(p_document) not between 1 and 65536` em `fn_extensions_finish_install`). Um nicho com
seis objetos e quarenta campos passa disso. A decisão é **aumentar o teto**, não compactar o JSON —
texto legível é o que torna a revisão do catálogo possível. Entra na 1b.

### 2.1 Objetos e campos

Os objetos moram na chave **`data`**, que o manifesto já reservava — nenhuma 14ª chave. O perfil
declarativo continua exigindo `{"mode": "none"}`; o perfil de dados usa:

```jsonc
"data": {
  "mode": "declarado",
  "objetos": [{
    "slug": "odontograma",
    "rotulo": { "pt-BR": "Odontograma", "es": "Odontograma" },
    "campos": [
      { "slug": "dente",    "tipo": "inteiro", "obrigatorio": true },
      { "slug": "valor",    "tipo": "dinheiro" },          // vira valor_cents bigint + valor_moeda
      { "slug": "laudo",    "tipo": "texto_longo" },
      { "slug": "feito-em", "tipo": "data" }
    ],
    "refs": [{ "slug": "paciente", "entidade": "contato", "obrigatorio": true, "ao_apagar": "cascata" }]
  }]
}
```

**Existe (1a)** — o que o validador e o compilador aceitam hoje:

| Item | Vocabulário em vigor |
|---|---|
| Chaves do objeto | `slug`, `rotulo`, `campos`, `refs` |
| Tipos de campo | `texto`, `texto_longo`, `inteiro`, `booleano`, `data`, `data_hora`, `dinheiro` (vira `<campo>_cents bigint` + `<campo>_moeda text` com CHECK de 3 letras) |
| `refs.entidade` | só `contato` (FK composta `(organization_id, <ref>_id)` → `contacts(organization_id, id)`) |
| `refs.ao_apagar` | só `cascata` |

Para conferir o vocabulário sem acreditar nesta tabela:

```bash
grep -n 'export type ObjetoDeclarado' -A10 lib/extensions/manifest.ts
grep -n "modulo_tipo_de_campo_desconhecido\|modulo_entidade_desconhecida\|modulo_acao_ao_apagar_nao_suportada" supabase/baseline.sql
```

Tipo, entidade ou ação fora do vocabulário **recusa** — nunca vira coluna de palpite.

**Falta (1b):**

- chaves do objeto `escopo` (só `organizacao`), `unico`, `indices` e `privacidade`
  (`{"pessoal": [...], "sensivel": [...]}`) — **o validador hoje recusa todas elas**;
- tipos `decimal`, `escolha`, `escolha_multipla`, `arquivo`, `imagem` e as restrições de campo
  (`min`, `max`, `opcoes`, `max_bytes`);
- entidades `lead`, `conversa`, `compromisso`, `usuario` — a mesma allowlist da ADR-0005 D3.
  **`comanda` não entra:** desde a 0619 (09/10) ela é o módulo opcional `financeiro`, e uma FK para
  `sales` falharia onde ele não está instalado. Se um dia entrar, só condicionada à instalação do
  módulo, no padrão de `financial_entries.sale_id`. `produto` também fica fora até haver demanda
  medida;
- `ao_apagar: "anula"` — precisa de `on delete set null (coluna)`; anular a FK composta inteira
  tentaria anular `organization_id`, que é NOT NULL;
- referência **entre objetos do próprio módulo** (ex.: parcela → contrato) — ver §7.3.

`privacidade` não é enfeite: é o que liga o objeto à cascata de LGPD e ao export (§5). Campo marcado
`pessoal` entra na anonimização do contato; `sensivel` acrescenta a proibição de sair da instalação
quando a classe `connected` existir.

### 2.2 Telas

**Existe (1a):** um painel na ficha do contato (`components/modulos/FichasDoModulo.tsx`, montado em
`app/app/contacts/[id]/_client.tsx`), que lista as fichas do módulo daquele contato. Ele só é
desenhado onde há dado da própria empresa — painel sem nenhuma ficha não aparece. O módulo não
declara nada de tela para isso: é o host que decide.

**Falta (1b):** telas declaradas, renderizadas pelo host com os componentes do próprio produto — o
módulo **descreve**, não desenha:

```jsonc
"telas": [{
  "slug": "odontogramas",
  "rotulo": { "pt-BR": "Odontograma" },
  "objeto": "odontograma",
  "vista": "lista",                        // lista | ficha | calendario | quadro | galeria
  "colunas": ["paciente", "dente", "feito-em"],
  "filtros": ["feito-em"],
  "ordem": [["feito-em", "desc"]],
  "acoes": ["criar", "editar", "remover"]
}],
"paineis": [{ "slot": "contato.lateral", "objeto": "odontograma", "vista": "lista", "colunas": ["dente"] }]
```

Slots: `contato.lateral`, `lead.lateral`, `conversa.lateral`. Um slot é um lugar onde o host **já**
mostra informação da entidade; não é um ponto de injeção arbitrário. A rota `/app/m/[modulo]` e o
grupo "Módulos" na navegação (ADR-0005 D7) também são 1b.

### 2.3 Ações, eventos e ferramenta de IA — falta (1b)

Nada desta seção existe ainda. Tudo de catálogo fechado, implementado pelo **host**:

- **Ações**: `criar`, `editar`, `remover`, `mudar_campo`, `lancar_no_caixa`, `criar_tarefa`,
  `registrar_na_linha_do_tempo`. O módulo compõe; nunca traz lógica. `lancar_no_caixa` precisa
  garantir **pagamento único** (o que `fn_honorarios_parcela_pagar` faz hoje em código), senão a prova
  do §7.3 não fecha.
- **Eventos emitidos** pelo próprio registro: `<objeto>.criado`, `<objeto>.alterado`,
  `<objeto>.removido` — entram em `event_log` como qualquer fato, e ficam disponíveis como gatilho de
  automação.
- **Ferramenta de IA**: declarativa e **somente leitura** (`consultar <objeto> do contato atual`). A
  descrição que o modelo vê é **gerada pelo host** a partir dos rótulos, nunca texto livre do pacote —
  texto de terceiro no prompt já foi recusado na ADR-0003.

### 2.4 Concessões

**Existe (1a):** `dados.proprios`, na mesma tela de consentimento das outras permissões
(`grep -n 'dados.proprios' lib/extensions/capacidades.ts`).

**Falta (1b):** `contato.ler`, `lead.ler`, `lead.campos.escrever`, `linha_do_tempo.escrever`,
`tarefa.criar`, `caixa.lancar`, `ia.consultar`, com consentimento por organização em frases legíveis
(podendo consentir menos). Autoridade efetiva = declarado ∩ consentido ∩ papel de quem clica,
revalidada na transação do efeito (ADR-0005 D4).

---

## 3. O compilador

**Existe (1a).** Uma função fixa, `public.fn_modulo_dados_compilar(p_artifact_id uuid)` (migration
0611 + apêndice no `baseline.sql`), `security definer`, executável só por `service_role`. Ela **não**
gera nem grava função nova: lê o manifesto da linha de `extension_artifacts` — já admitida, imutável e
auditada — e executa o DDL direto. É chamada só de dentro de `fn_extensions_finish_install`, na mesma
transação do recibo da instalação. Por que o parâmetro ser um id preserva a ADR-0002 D4 está no
cabeçalho da 0611:

```bash
sed -n '1,24p' supabase/migrations/20261008130000_0611_modulo_de_dados_compilador.sql
grep -n 'fn_modulo_dados_compilar' supabase/baseline.sql   # definição, grants e a única chamada
```

Ordem do que ela faz hoje, e a razão de cada passo:

1. **Validar** — o vocabulário fechado é conferido no serviço (Zod) e de novo no banco; o que o banco
   não conhece levanta (`modulo_tipo_de_campo_desconhecido`, `modulo_entidade_desconhecida`,
   `modulo_acao_ao_apagar_nao_suportada`).
2. **Construir o nome**: `m_<publicador>_<modulo>_<objeto>`, com `-` virando `_` **no publicador e no módulo**; o slug do **objeto** entra como está (pode ter `-`, que o validador aceita: `^[a-z0-9]+(?:-[a-z0-9]+)*$`). Todo identificador
   passa por `format(%I)`; nada do JSON entra como texto cru.
3. **Criar a tabela** (`create table if not exists`) com `id`, `organization_id` com FK para
   `organizations`, as colunas declaradas, as FKs **compostas por organização** — a checagem de FK
   ignora RLS, então uma FK simples aceitaria id de outra organização — e `created_at`/`updated_at`.
   O índice único `(organization_id, id)` em `contacts` que a FK composta exige é criado **no caminho
   do schema** (0611), não na instalação: `create unique index` sem `concurrently` pararia a ingestão.
4. **Fechar as portas**: `revoke all … from anon, authenticated` **antes** de
   `fn_proteger_modulo_provisionado()`. Tabela de módulo é server-only — a leitura passa pela rota do
   host, nunca pelo PostgREST direto.
5. **Proteger** (`fn_proteger_modulo_provisionado()`: RLS ligada, isolamento por organização, travas
   da sessão de suporte — ADR-0002 D5) e **avisar o PostgREST** (`pg_notify('pgrst', 'reload schema')`).
   O reload é assíncrono: por alguns segundos depois de instalar, a leitura pode responder que a
   tabela não está no cache. Limitação conhecida e declarada no corpo da função.

**Falta (1b):**

- **truncamento do nome com sufixo de hash** para caber em 63 bytes (`NAMEDATALEN`), colunas reservadas
  recusadas, nome de policy por hash, e **conferência de quem é dono** da tabela antes de criar — um
  módulo nunca escreve sobre a tabela de outro;
- **`lock_timeout`** na compilação: a FK para `contacts` toma `SHARE ROW EXCLUSIVE`, e a ingestão de
  WhatsApp está no ar;
- CHECK das escolhas, índices e únicos declarados (dependem do vocabulário da 1b);
- **conferência pós-provisionamento** com a regra da ADR-0005 (escolha 2): módulo de terceiro
  **suspende e avisa**; só o oficial derruba a atualização (ADR-0002 D6);
- registro das seções de LGPD (§5).

O que o compilador **nunca** faz: aceitar identificador cru do pacote, montar SQL por concatenação de
texto do pacote, criar função que o pacote nomeie, tocar tabela do núcleo, ou criar role.

### 3.1 Atualizar e remover

**Remover existe (1a)** pelo caminho das extensões (`fn_extensions_remove_installation`, o mesmo de
`removeExtension` em `lib/extensions/service.ts`): é lógico e **preserva os dados** (não-negociável 7)
— o painel sai, as tabelas ficam. Provado pela tela no segundo caso do e2e (§7.2). Apagar os dados é
ação separada, que ainda não existe.

**Atualizar falta (1b).** Hoje o compilador só roda na conclusão da instalação. O módulo de dados **não** entra em
`modulos_instalados` (não aparece em `/admin/modulos`) nem em `fn_reaplicar_modulos_instalados`, então
uma atualização do núcleo não o toca e uma versão nova do módulo **não recompila**.

- **Atualizar** deve recompilar a versão nova, e só quando o hash do artefato mudou (para não alongar a
  janela em que o app fica parado). Mudança **compatível** (campo novo opcional, índice, tela) é
  aplicada; **incompatível** (remover campo, apertar tipo, trocar FK) é recusada com código próprio —
  quem precisa disso publica outra versão maior e migra, como o Core faz.
- **Apagar** os dados de um módulo removido é ação separada, com consequência escrita na tela e as
  regras de LGPD do domínio.
- **Liga/desliga por organização**: hoje o corte é por instalação, e o cabeçalho da 0611 explica por
  que `organization_extensions.enabled` não serve ao perfil `data` como está.

---

## 4. Escrita e leitura

**Existe (1a):**

```
GET    /api/v1/modulos/{modulo}/{objeto}            lista (filtro opcional ?contato=, limite ≤ 200)
```

`app/api/v1/modulos/[modulo]/[objeto]/route.ts`. A organização vem da sessão (`requireRole`), nunca da
URL; o nome da tabela é derivado do que está instalado (`lib/modulos/dados/tabela.ts`), e o que não
casa é 404. Como a tabela é server-only, esta rota é o **único** caminho de leitura — o filtro por
organização existe só ali, no código.

**Falta (1b):**

```
POST   /api/v1/modulos/{modulo}/{objeto}            cria (Idempotency-Key)
PATCH  /api/v1/modulos/{modulo}/{objeto}/{id}       altera (precondição por revisão)
DELETE /api/v1/modulos/{modulo}/{objeto}/{id}       remove
```

Todas resolvem a organização do **cookie ou do token**, nunca do corpo; conferem concessão e papel;
validam contra o schema declarado; auditam com o ator `module` e o módulo nomeado; e aplicam a cota em
**bytes**, atomicamente na escrita (o plano gratuito tem 500 MB para a instalação inteira). Cursor
opaco na listagem também é 1b.

---

## 5. LGPD, export e varreduras

**O mecanismo existe — e é anterior a esta spec.** A 0485 (28/09) criou `modulo_secoes_lgpd` e o
gatilho `trg_lgpd_secoes_de_modulo` (`after update of is_anonymized` em `contacts`), que redige as
seções que cada módulo declara, sem reescrever a função de cascata (ADR-0002 D8). O módulo oficial
`financeiro` já registra a sua seção ali.

```bash
grep -n 'create table if not exists public.modulo_secoes_lgpd' -A10 supabase/baseline.sql
grep -n 'create trigger trg_lgpd_secoes_de_modulo' -A4 supabase/baseline.sql
```

**Falta (1b), e é lacuna aberta da onda 1:**

- o compilador **não registra** seção nenhuma em `modulo_secoes_lgpd`. Os campos `pessoal` de um
  módulo de dados **hoje não são anonimizados** quando o contato é. (Apagar o contato apaga as fichas,
  pela FK `cascata`; anonimizar não apaga.) A correção é o compilador registrar a seção dos campos
  `pessoal` no mesmo passo em que cria a tabela;
- **limite de nome:** `modulo_secoes_lgpd.tabela` aceita no máximo 41 caracteres e **não aceita `-`**
  (`^[a-z][a-z0-9_]{1,40}$`), menos que os 63 que `m_<pub>_<mod>_<obj>` pode alcançar — e o slug do objeto pode trazer `-`. A 1b resolve as duas coisas juntas (sanitizar e truncar, ou alargar o CHECK). Ou o
  truncamento do §3 corta em 41, ou uma migration alarga o CHECK — a escolha é feita junto com o
  truncamento;
- **export** que não conseguir ler uma seção de módulo marca o resultado como **parcial**, nunca como
  completo;
- as varreduras de RLS, de `security definer` e da cascata rodam também sobre um banco **com módulos
  instalados**, senão tabela compilada fica fora delas. E a varredura por **DDL em `security definer`**
  precisa alcançar `fn_modulo_dados_compilar` — a atual só alcança `fn_*_provisionar`.

---

## 6. Sistema vivo

| Invariante | Hoje (1a) | Falta (1b) |
|---|---|---|
| Entrada | instalar o artefato `data` pelo caminho das extensões (e remover, preservando os dados) | ativar e consentir por organização; criar registro pela tela |
| Saída | painel na ficha do contato; `GET` da rota de módulos | telas e painéis declarados, eventos em `event_log`, ferramenta de IA de leitura, ações |
| Registro | recibo da instalação em `extension_operations` | auditoria com ator `module`, atividade na linha do tempo |
| Tela | painel dentro da ficha do contato (porta = a ficha) | grupo "Módulos" na navegação, com porta declarada em `lib/navigation/registry.ts` |
| Anti-morte | artefato que não compila **não instala** (o compilador roda na transação do recibo) | conferência pós-provisionamento, módulo suspenso com aviso na Central, interruptor local |
| Laço de retorno | tipo/entidade desconhecido levanta e a instalação inteira volta | módulo que falha na atualização suspende e avisa, sem derrubar o núcleo |

---

## 7. Como isto é provado

1. **Invariantes em Postgres real.** Existe: `tests/invariants/modulo-de-dados-compilador.test.ts`
   (tabela com nome prefixado, server-only e isolada por organização; cada tipo vira a coluna do
   vocabulário; FK composta recusando contato de outra organização; tabelas criadas na mesma
   transação do recibo; o nome que a rota resolve é a tabela que o compilador criou). Falta: nome de 63 bytes, sabotagem da validação do serviço para a
   do banco pegar, cota em bytes, recompilação idempotente, recusa de mudança incompatível,
   anonimização alcançando o campo `pessoal` e passando sem erro onde o módulo não existe.
2. **Pela tela, em ambiente fresco estilo VPS** (banco do `baseline.sql` + `bootstrap-owner`). Existe:
   `tests/e2e/modulo-de-dados-na-ficha-do-contato.spec.ts` — a ficha mostra o painel com o rótulo do
   autor; com o módulo removido, o painel sai e a ficha segue inteira. O módulo é semeado (artefato +
   instalação); a admissão pelo catálogo é provada em `extensoes-declarativas.spec.ts`. Falta: ativar
   numa organização, criar um registro pela tela e atualizar o módulo.
3. **A prova dura (1b):** o módulo de honorários portado para artefato declarado, instalado num banco
   onde ele não existe como código, com os mesmos dados funcionando. Honorários continua como código
   (migration 0480, `fn_honorarios_provisionar`, `fn_honorarios_parcela_pagar`, rotas e ferramentas
   MCP).

### 7.3 As lacunas que a prova dura já tem

Medido contra o schema de honorários
(`grep -n 'references\|constraint\|numeric' supabase/migrations/*_0480_*.sql`). Nem o vocabulário da
1b, como escrito no §2.1, expressa tudo isto:

| Honorários precisa de | Onde entra |
|---|---|
| FK entre objetos do módulo (`parcelas.contrato_id → contratos`) | vocabulário 1b: `refs` para objeto do próprio módulo |
| FK para `crm_leads` com `on delete set null` | entidade `lead` + `ao_apagar: anula` (1b) |
| FK para `financial_entries` com `on delete set null` | entidade nova na allowlist, ou a ação `lancar_no_caixa` guarda o vínculo |
| `numeric(5,2)` para percentuais | tipo `decimal` (1b) |
| CHECK condicional entre campos ("o modelo tem o campo") | **não expresso** — ou restrição declarativa nova, ou validação da ação |
| Pagar a parcela uma vez e lançar no caixa | ação do host `lancar_no_caixa` com pagamento único |

A ADR-0002 D9 já dizia que "vocabulário declarativo não expressa as funções PL/pgSQL do módulo". Se o
passo 3 exigir qualquer mudança no Core além do que está nesta tabela, a lacuna que ele revelar entra
aqui antes de a onda ser considerada pronta — é para isso que ele existe.
