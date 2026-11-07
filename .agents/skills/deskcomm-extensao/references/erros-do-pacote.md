# Por que o pacote foi recusado

O parser recusa **o pacote inteiro** e não diz qual campo errou — de propósito: a mensagem pública
nunca incorpora bytes nem texto do pacote. Então a depuração é por eliminação, e o
`.agents/skills/deskcomm-extensao/scripts/validar-pacote.sh` é o caminho curto: ele roda o mesmo schema, do seu lado, antes de
qualquer envio.

## `extension_invalid_package` — o schema recusou

Em ordem de frequência esperada (a lista sai da leitura do schema, não de uma medição de campo —
não há pacote de terceiro publicado ainda):

| Causa | Como aparece | Conserto |
|---|---|---|
| Chave que o schema não conhece | qualquer campo extra no topo ou dentro de `display`, `configuration`, card, bloco ou `action` | tire. Autoria, site, etiqueta e imagem **não** moram no pacote |
| `"en"` num texto localizado | `{ "pt-BR": …, "en": … }` | só `pt-BR` (obrigatório) e `es` (opcional) |
| Texto vazio ou só espaços | `{ "pt-BR": "" }` | todo texto localizado precisa de conteúdo |
| Estouro de caractere | título com 101, corpo com 2.001 | conte **caracteres**, não bytes |
| Slug com maiúscula, acento, espaço ou `_` | `publisher: "Minha_Clínica"` | `minha-clinica` |
| Versão com sufixo | `"1.0.0-beta"`, `"v1.0.0"` | `x.y.z`, inteiros, sem zero à esquerda |
| `permissions` vazia, repetida ou com nome inventado | `["navigation.tarefas"]` | o vocabulário está em `lib/extensions/capacidades.ts` |
| `dependencies` com algo dentro | `["outra-extensao"]` | exatamente `[]` |
| Dois cards com o mesmo `id` | | `id` é único dentro do pacote |
| Mais de 4 cards, mais de 8 blocos | | corte, ou divida em dois pacotes |
| Chave repetida no mesmo objeto, comentário `//`, vírgula final | JSON que o seu editor aceita e o parser não | JSON estrito |

## `extension_incompatible` — o schema passou, o host recusou

O motivo vem nomeado. Os seis:

| Motivo | O que houve |
|---|---|
| `host_api_unsupported` | a sua janela não contém o host atual. `{"min":1,"max":1}` num host 2 é o caso típico — e é o comportamento correto: você declarou até onde garantia |
| `permission_unsupported` | permissão fora do vocabulário, **ou** um card usa uma porta que você não declarou |
| `capability_unsupported` | `capability` fora do vocabulário |
| `format_version_unsupported` | `format_version` diferente de 1 |
| `profile_unsupported` | `profile` fora da lista que o host aceita (`grep -n 'profile: z.enum' lib/extensions/manifest.ts`) |
| `dependency_unsupported` | `dependencies` não vazia |

A cobertura permissão × capacidade é a que mais pega gente honesta: acrescentar um card novo com uma
porta nova exige acrescentar a permissão **junto**, na mesma versão.

## Erros que só aparecem depois, com o catálogo

| Código | O que houve |
|---|---|
| `extension_digest_mismatch` | os bytes baixados não batem com o `sha256` do catálogo. Quase sempre: o arquivo foi reformatado (um espaço, uma quebra de linha, um editor que salva com BOM) depois de o digest ser calculado |
| `extension_version_conflict` | a mesma versão já existe com bytes diferentes. Versão publicada é imutável; mudou o conteúdo, mudou o número |
| `extension_payload_too_large` | passou de 64 KiB, ou estourou profundidade, nós ou propriedades por objeto |
| `extension_unsafe_origin` | a origem do catálogo não é permitida (endereço especial, redirect, credencial na URL) |
| `extension_card_unavailable` | alguém clicou num card que a versão instalada não tem mais — você renomeou um `id` entre versões |

## Erros que não são seus

- **`extension_active_limit`, `extension_catalog_limit`, `extension_installation_limit`**: tetos da
  instalação, não do pacote (`grep -n ">= 8\|>= 128" supabase/migrations/*_0271_*.sql`).
- **`extension_core_update_in_progress`**: o CRM está se atualizando. Publicar espera o sistema;
  tirar não espera.
- **`extension_removed`**: quem administra a instalação removeu a extensão. A configuração das
  organizações continua guardada, e uma reinstalação traz os vínculos **desativados** — a
  plataforma não reativa uma decisão que é da organização.
