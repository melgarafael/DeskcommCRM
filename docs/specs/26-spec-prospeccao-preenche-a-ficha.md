---
title: "Spec Técnica 26 — A prospecção preenche a ficha do cliente (links) e a ficha passa a mostrá-los"
parent: 00-prd-master.md
type: spec
scope: prospecção, contatos
status: approved
version: 0.3.1
owner: arquitetura
created_at: 2026-10-23
related:
  - 02-spec-customer-360.md
  - 24-spec-enriquecimento-site-prospeccao.md
  - 25-spec-receitas-banco-externo.md
---

# Spec 26 — A prospecção preenche a ficha do cliente

> **Aprovada pelo dono em 28/10/2026.** Números medidos em 23/10/2026; peças de código reconferidas em 28/10/2026 na main `f13d26f6b`
> (código: `origin/main` em `e9a01b5dd`; dados: instalação oficial 1.87.0, só a organização PLJR,
> consultas somente leitura com filtro de organização).

## 1. O que está errado, medido

A prospecção descobre o endereço do site, as redes sociais e o link do Google Maps de cada empresa,
guarda tudo em `prospecting_candidates.data` e **só mostra isso no painel "Sobre a empresa" do
Inbox** (`components/inbox/LeadEnrichment.tsx`, lendo o candidato ao vivo em
`app/api/v1/contacts/[id]/crm-summary/route.ts`). **Nada é copiado para o contato.** A aba "Links"
do dossiê (Instagram, Site, Google Meu Negócio, Facebook, LinkedIn, TikTok, YouTube, Outro) lê e grava
em `contacts.custom_fields`, chaves `link_<tipo>` (`lib/leads/links-de-contato.ts`), e fica vazia.

| Medido na oficial (PLJR), candidatos que já viraram contato | Valor |
|---|---|
| Candidatos com contato | 197 (e 214 ainda sem contato, que ganham contato na hora da abordagem) |
| Sabem o `website` | 125 |
| ...dos quais o `website` é um **Instagram** | 41 |
| ...dos quais é Facebook | 2 |
| ...dos quais é agregador (linktr.ee, wa.me, forms etc.) | 10 |
| ...site próprio | 72 |
| Têm redes no campo `socials` | 73 (Instagram 61, Facebook 33, LinkedIn 8) |
| Têm link do Maps | 197 (guardado em `source_metadata.maps_url`, sem aparecer na aba) |
| **Fichas com algum `link_*`** | **1 de 197** |

Consequência para o desenho: **copiar o campo `website` direto para "Site" colocaria um Instagram no
lugar do site em 41 fichas (33%)**. O mapeamento tem de olhar o endereço.

**Classificação:** lacuna de desenho, não defeito de código. A aba Links nasceu em 19/09/2026
(commit `219cdea7a`) para preenchimento por pessoa e por agente; a prospecção promete só exibir (nota de
versão, crédito @saraivabr; Spec 24). Nenhum documento promete copiar. Fere o invariante 1 do Sistema
Vivo ("nada é ilha"): o que a prospecção coleta alimenta uma tela e não o registro do cliente.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**
1. Todo contato criado pela prospecção nasce com os links que a busca achou, nas chaves certas.
2. A ficha do contato (`/app/contacts/[id]`) mostra os links; hoje só o card do funil e o dossiê mostram.
3. Os contatos já criados são completados, sem sobrescrever o que uma pessoa digitou.

**Não-objetivos (de propósito)**
- **E-mail do candidato.** `contacts.email` tem índice único por organização
  (`uniq_contacts_org_email`, `supabase/baseline.sql`): copiar poderia derrubar a criação do contato.
  Medido hoje: 20 e-mails de candidatos, 0 colisões, mas nada garante o futuro. E o e-mail achado é o
  da empresa, não o da pessoa. Continua só em "Sobre a empresa".
- **Nota, avaliações, endereço e categoria.** São dados da empresa; onde moram é a pergunta da issue
  #3198 (a prospecção deve criar Empresa?), aberta em 21/10 e sem resposta. Esta spec não decide isso.
- TikTok e YouTube: a busca não os coleta. Seguem manuais.
- Texto da descrição do negócio ("Campanha: X / Qualificação: Y"): não muda aqui.

**Anti-objetivos (falha mesmo que "funcione")**
- Sobrescrever link que uma pessoa editou.
- Gravar endereço que não seja http(s) ou que passe de 1000 caracteres.
- Qualquer chamada de rede nova (esta spec não faz fetch de nada).

## 3. Desenho

### 3.1 Função pura `linksDoCandidato(data)` — `lib/prospecting/links-do-candidato.ts` (novo)
Entrada: o `data` do candidato. Saída: `LinksDoContato` (o tipo que já existe). Regras, nesta ordem:

| De onde | Vira | Regra |
|---|---|---|
| `socials[]` | `instagram`, `facebook`, `linkedin` | o **primeiro** endereço de cada rede, reconhecida pelo host (`hostDeSite`, `lib/prospecting/site-classify.ts`) |
| `website` | `instagram` / `facebook` / `linkedin` | **testado primeiro**: se o host for essa rede e `socials` não trouxe uma (a rede de `socials` vence) |
| `website` | `outro` | se for agregador **que não é rede** (linktr.ee, wa.me, forms.gle etc.). Atenção: `DOMINIOS_AGREGADORES` já contém `instagram.com` e `facebook.com`, e `ehAgregador` devolve `true` para endereço sem host; por isso a rede é testada antes, e endereço sem host não vira nada |
| `website` | `site` | só se o host existir e **não** for rede nem agregador |
| `maps_url` | `google_meu_negocio` | direto |

Todo valor passa por `normalizarLink` (`lib/leads/links-de-contato.ts`): só http(s), com ponto no host,
até 1000 caracteres. O que a função recusar simplesmente não entra. Lista de hosts: reaproveita
`DOMINIOS_AGREGADORES` e acrescenta o LinkedIn **no mesmo arquivo**. *Ponto de atenção:* o JSDoc de
`normalizarLink` (`links-de-contato.ts`) diz que o código "não nomeia host de terceiro"; `site-classify.ts` já nomeia
`instagram.com` e `facebook.com`. Esta spec segue o precedente e o submete ao mantenedor (ver §8).

### 3.2 Onde gravar — uma função, dois caminhos dentro dela
`criarPegadaDoCandidato` (`lib/prospecting/store.ts`) tem dois caminhos, e os dois gravam:
- **Contato novo** (`if (!contactId)`): o `createContactHandler` recebe
  `custom_fields: aplicarLinks({}, linksDoCandidato(p.data))` (`aplicarLinks`, em
  `lib/leads/links-de-contato.ts`, é o que monta as chaves `link_<tipo>`). `createContactHandler` só
  confere os padrões que o funil define para o escopo "contato" e pula chave sem definição
  (`recusasDePadrao`), então `link_*` não é recusada.
- **Contato reaproveitado** (`contatoDaCampanha ?? p.contact_id`): NÃO é tocado na abordagem; nada é
  gravado nele ao enviar. O `createContactHandler` não roda, e o SQL da §3.3 não entra aqui. Motivo: um
  link que a pessoa apagou voltaria a cada envio. Ele só recebe os links que faltam pelo botão
  "Completar fichas" (§3.3, decisão §7.1).

O SQL da §3.3 vira um helper único (ex.: `completarLinksDoContato(db, org, contactId, links)`), nascido
no commit 1 e reusado pela ação do commit 3. Os dois chamadores de `criarPegadaDoCandidato` (modo
`on_start` em `enfileirarCandidatos` e modo `on_send` em `prepararCandidatoNoEnvio`) passam por ela.
Falha do mapeador ou do helper **não** derruba a criação do contato (fail-open, registra no log). Sem
migration, sem baseline, sem rota nova.

### 3.3 Contato que já existe: o botão "Completar fichas" (decisão do dono, 23/10/2026)
Regra única: **só entra o `link_<tipo>` que está ausente**; o que existe não é tocado.

**Por que não pelo `updateContactHandler`:** o PATCH de contato **substitui** o `custom_fields` inteiro
(`app/api/v1/contacts/_handler.ts`, "SUBSTITUIÇÃO, não merge"). Ler o contato, somar os links e gravar
abre uma janela em que uma edição humana feita no meio é apagada. A forma segura é **uma instrução SQL
atômica**, em que o que já existe vence o que entra:

```sql
update contacts
   set custom_fields = $links::jsonb || coalesce(custom_fields, '{}'::jsonb), updated_at = now()
 where organization_id = $org and id = $contato
   and not is_anonymized and is_merged_into is null
   and not (coalesce(custom_fields,'{}'::jsonb) ?& $chaves::text[])
```

No `||` a chave da direita vence, então a que a pessoa digitou fica; a que falta entra. A cláusula
`not (… ?& …)` pula quem já tem todas as chaves (rodada vazia não escreve), e o critério é a
**existência** da chave, não o valor: com `@>`, um link que a pessoa digitou com outro endereço nunca
"batia" com o da busca, e a ficha seria regravada a cada clique. `$chaves` são as chaves de `$links`.
O botão traz de volta um link que a pessoa apagou (a chave some quando o campo fica vazio); é o
significado de "completar", e acontece só quando alguém clica. `updated_at = now()` é necessário:
a aba Links remonta o formulário por `contato.updated_at` (`ContatoDoNegocio.tsx`).

**A ação:** `completar_fichas` em `app/api/v1/prospecting/route.ts`, pelo mesmo caminho das vizinhas
(`verificar_sites`, `reanalisar_site`): entrada `{ action: "completar_fichas", id: <campanha> }` no
`prospectingInputSchema` (`lib/prospecting/schema.ts`, `.strict()`); o `POST` já exige
`requireSupportWrite()`, papel `admin` e **fecha a ação a token** (fora de `ACOES_ABERTAS_AO_TOKEN`, que
é lista de permissão); roda dentro de `withProspectingLock`. Varre os candidatos da campanha que têm
`contact_id`, calcula `linksDoCandidato(data)` e aplica o SQL acima a quem tem link faltando, no máximo
**100 por clique**. Devolve `{ completadas, ja_completas, sem_links, faltam }`; `faltam > 0` faz a tela
dizer "clique de novo". Audita `prospecting.changed` com `{ operation, completadas, ja_completas,
sem_links }`, sem endereços no log. Toda leitura e escrita filtra `organization_id`.

**A tela:** botão "Completar fichas" ao lado de "Verificar agora" (`app/app/prospecting/_client.tsx`),
pelo mesmo `perform(...)`, com mensagem "Fichas completadas: N". Sem contador (o servidor é quem sabe
quem falta). Textos novos entram nas traduções que o teste de cobertura exigir.

O contato reaproveitado em `criarPegadaDoCandidato` (`contatoDaCampanha` / `p.contact_id`) **não**
passa por este SQL na abordagem (§3.2, §7.1): só pelo botão. Não há migration: nada de SQL de dados
que duplique em SQL a regra de hosts.

### 3.4 A ficha mostra os links
`app/app/contacts/[id]/_client.tsx`, aba "Visão geral", dentro do `<dl>`, logo depois do bloco
"Telefone": uma linha "Links" que lê `linksParaExibir(contact.custom_fields)`
(`lib/leads/links-de-contato.ts`). Os botões do card (`components/kanban/ContatoNoCard.tsx`) são do
cartão (recebem o lead, fazem `stopPropagation`): extrair deles um componente só de apresentação da
lista de links e usar nos dois lugares, sem mudar o que o card mostra. Sem links → a linha não
aparece. O `GET /api/v1/contacts/{id}` já devolve `custom_fields` (`SELECT_COLS`): **sem mudança de
API**. (O #3259, que tocava este arquivo, já entrou na main.)

## 4. Segurança e LGPD
- Dado raspado da web é **terceiro não confiável**. Aqui só entra como endereço normalizado; nunca vai
  para prompt de sistema nem é seguido pelo servidor (sem fetch).
- O valor vira `<a href>`: a trava de `javascript:`/`data:` mora em `normalizarLink` e na leitura
  (`linksParaExibir`), como o cabeçalho de `links-de-contato.ts` exige.
- Anonimização: `contacts.custom_fields` é limpo pela cascata por gatilho de estado, e o invariante
  `tests/invariants/lgpd-alcanca-campos-personalizados-do-contato.test.ts` guarda isso (conforme o
  cabeçalho do teste; não rodado). Os links entram pela mesma coluna e são limpos junto.
- Dado velho: o link é só endereço; "Sobre a empresa" continua mostrando a data da busca. A origem
  (campanha e lugar) já está em `source_metadata`.

## 5. Living System Checklist
1. **Quem me alimenta:** `prospecting_candidates.data` (`website`, `socials`, `maps_url`), gravado por `normalizeProspect` (`lib/prospecting/schema.ts`).
2. **Quem eu alimento:** aba Links (`ContatoDoNegocio.tsx`), botões do card (`ContatoNoCard.tsx`) e, novo, a linha de links da ficha (`_client.tsx`).
3. **Registro:** a criação já emite `contact.created` + auditoria; o botão audita `prospecting.changed` com as contagens (a ação é um gesto da pessoa, como `verificar_sites`).
4. **Na tela:** as três acima.
5. **Porta:** nenhuma tela nova.
6. **Anti-morte:** não se aplica (cópia de dado de referência, sem demanda); justificativa registrada.
7. **Configuração:** nenhum interruptor novo; a pessoa corrige na própria aba Links. Falha do mapeador = ficha sem links, nunca bloqueia a criação (fail-open).
8. **Continuidade IA↔humano:** a pessoa que assume o atendimento passa a ver site e redes sem sair do card. O briefing da passagem não lê links; fica fora de escopo.
9. **Laço de retorno:** nenhum — não há decisão automática; a edição humana prevalece sempre. Justificativa registrada.
10. **Mapa:** em `docs/architecture/prospeccao-nativa.architecture.json` a aresta `candidates → crm` ("ativação autorizada") já existe; o rótulo passa a dizer que o contato nasce com os links.

## 6. Testes e prova
- **Unit do mapeador** (`lib/prospecting/links-do-candidato.test.ts`): website Instagram → `instagram` e **não** `site`; site próprio → `site`; agregador → `outro`; `socials` vence o `website`; `javascript:` e endereço >1000 caracteres descartados; `data` vazio → `{}`; Maps → `google_meu_negocio`.
- **Ligação** (`tests/unit/prospeccao-funil-no-envio.test.ts`, bloco `criarPegadaDoCandidato`): o `createContactHandler` recebe `custom_fields` com os links. Sabotar **o mapeador, a regra de hosts E cada ponto de chamada** (os dois chamadores), um por vez, e prever os vermelhos antes.
- **Completar, no banco (invariante, `pnpm test:db` no CI):** o SQL atômico da §3.3 com (a) chave que a pessoa digitou preservada, (b) chave ausente adicionada, (c) segunda rodada sem escrever nada (`updated_at` não muda), (d) contato **anonimizado** intocado, (e) contato de **outra organização** intocado, (f) o `custom_fields` com campos que não são `link_*` preservados, (g) contato **mesclado** intocado. Sabotar o operador `||` (inverter a ordem) e prever o vermelho de (a).
- **A ação:** rota recusa `completar_fichas` por token (403) e aceita por sessão; devolve as contagens; audita sem endereços; `faltam` > 0 quando passa de 100.
- **A tela:** o botão chama a ação e mostra a mensagem; fica desabilitado enquanto ocupado.
- **Dados reais, sem escrita:** rodar o mapeador sobre os 197 candidatos da PLJR e conferir a contagem esperada: site próprio ≈ 72, Instagram **no mínimo 61** (as redes de `socials` mais os 41 `website` que são Instagram, menos a sobreposição), Facebook no mínimo 33, LinkedIn 8, Maps 197. Os números de site, Instagram e agregador da §1 vêm de uma classificação aproximada por expressão no SQL, não do código TypeScript; este teste é o que os confirma.
- **Prova pela tela (DoD 12):** banco fresco do `baseline.sql`, provedor de teste (`lib/prospecting/provedor-teste.ts`), ativar uma campanha e abrir a ficha, o card e o dossiê.

## 7. Decisões do dono (23/10/2026)
1. **Completar os 197 existentes: botão manual "Completar fichas"** (§3.3). Fica de fora o passo automático no tick: ninguém passa a ter fichas alteradas sem clicar.
2. **Fatiamento: um PR só**, em três commits separados para facilitar a revisão: (1) mapeador + gravação na criação (§3.1–3.2); (2) a ficha mostra os links (§3.4); (3) ação e botão "Completar fichas" (§3.3).
3. **Não esperar a #3198.** Se o mantenedor decidir que a prospecção cria Empresa, o site e o endereço podem preferir morar na Empresa. Os links do contato continuam valendo (a aba Links é do contato), mas o Site pode ficar duplicado. Fica registrado no corpo do PR.

## 8. Riscos e conflitos
- **#3198** (issue do dono, sem resposta): ver §7.3.
- **#3259** (@webtecnica, aberto): toca `_client.tsx`; conflito pequeno no PR B.
- **Nome de host no código**: ver §3.1; deixar a pergunta ao mantenedor no corpo do PR.
- **Exportação LGPD** (`lib/lgpd/campos-personalizados.ts`, `camposLegiveis`): o campo sem pergunta de roteiro sai com o rótulo derivado da chave ("Link instagram"), não com a chave crua. Aceitável; fica registrado no PR.
- **Destino (DoD 18):** núcleo. A prospecção não é módulo opcional; se nenhuma organização a usa, nada muda.
- **Fragmento de release:** `.changes/prospeccao-preenche-os-links-da-ficha.md`, `impacto: capacidade_nova`, `secao: adicionado` (nada a fazer na VPS).
