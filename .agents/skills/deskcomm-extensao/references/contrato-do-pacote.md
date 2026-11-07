# O contrato do pacote, campo a campo

O pacote é **um arquivo JSON**. Não há ZIP, pasta, `package.json`, build nem instalação de
dependência. A autoridade é `lib/extensions/manifest.ts` — este documento é a leitura dele, e
quando os dois discordarem, o código está certo:

```bash
grep -n "EXTENSION_LIMITS" -A 16 lib/extensions/manifest.ts   # os limites numéricos
sed -n '/^const manifestSchema/,/^  .strict();/p' lib/extensions/manifest.ts   # o schema
cat lib/extensions/capacidades.ts                             # portas e permissões
```

## O JSON antes dos campos

O parser é estrito, e recusa **o pacote inteiro** — nunca um campo:

- UTF-8, sem comentários, sem chave repetida no mesmo objeto, sem `__proto__`, `prototype` ou
  `constructor` como chave.
- Sem HTML, script, SQL, CSS, expressão ou URL de asset. **Todo texto é renderizado como texto** —
  escrever `<b>` mostra `<b>` na tela.
- Sem NUL e sem Unicode malformado.
- Limites estruturais (`EXTENSION_LIMITS`): profundidade **12**, **20.000** nós, **32**
  propriedades por objeto, **65.536 bytes** (64 KiB) de pacote.
- Transporte comprimido é recusado neste perfil.

## Campos do manifesto

Nenhum campo é opcional, e **chave desconhecida recusa o pacote**. A ordem não importa; a grafia,
sim.

| Campo | Regra | Observação |
|---|---|---|
| `format_version` | exatamente `1` | é a versão do **formato**, não a sua |
| `profile` | `"declarative"` para este guia | o host admite também `data` e `connected`, cada um com contrato próprio: `grep -n 'profile: z.enum' lib/extensions/manifest.ts` |
| `publisher` | slug `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 2 a 64 caracteres | quem publica; sem maiúscula, acento ou espaço |
| `name` | mesmo formato de slug | `publisher` + `name` + `version` é a identidade |
| `version` | SemVer `x.y.z`, inteiros sem zero à esquerda, até 64 caracteres | sem `-beta`, sem `+build` |
| `license` | exatamente `"MIT"` | |
| `host_api` | `{ "min": n, "max": n }`, inteiros positivos, `min <= max` | a janela que **você** garante; veja abaixo |
| `permissions` | lista não vazia, sem repetição, do vocabulário fechado | é o que a tela mostra a quem vai aceitar |
| `dependencies` | exatamente `[]` | extensão que depende de extensão não existe |
| `data` | exatamente `{ "mode": "none" }` | o pacote não guarda dado; é a única opção |
| `display.title` | texto localizado, até **100** caracteres | aparece na lista e no topo do guia |
| `display.summary` | texto localizado, até **400** caracteres | |
| `display.category` | `productivity`, `sales` ou `service` | |
| `display.icon` | `ListChecks`, `BookOpen` ou `Lightbulb` | a lista é fechada; imagem própria é recusada |
| `configuration` | `{ "density": "comfortable" \| "compact", "show_description": bool }` | são os **padrões iniciais**; quem administra a organização muda depois |
| `contributions.crm_cards` | até **4** cards, `id` único entre eles | pode ser lista vazia, e um pacote assim não faz nada |

### Texto localizado

```json
{ "pt-BR": "obrigatório", "es": "opcional" }
```

Só estas duas chaves. Sem `en`, sem `pt`, sem `pt_BR`. O texto precisa ter conteúdo depois de
tirar os espaços, e o limite conta **caracteres** (não bytes). Sem `es`, quem usa o CRM em espanhol
vê o pt-BR com a marca de que não há tradução.

### `host_api` — a janela que você garante

O host atual é a constante `HOST_API_VERSION` de `lib/extensions/manifest.ts`
(`grep -n "HOST_API_VERSION =" lib/extensions/manifest.ts`). Um pacote é compatível quando
`min <= host <= max`.

A janela é uma **declaração sua**, não um enfeite: dizer `{"min":1,"max":1}` é dizer "eu garanto
isto até a versão 1 do contrato", e num host mais novo o pacote fica incompatível — o que está
correto. Pacotes escritos para o vocabulário de portas múltiplas declaram `min` 2.

Um guia ativo que fica incompatível **não some calado**: a tela avisa e aponta a gestão.

### `permissions` e `capability` — o par que precisa fechar

O vocabulário está em `lib/extensions/capacidades.ts`, e é fechado nos dois lados:

| `permissions` (o que você declara) | `capability` (o que o botão do card pede) | Abre |
|---|---|---|
| `navigation.tasks` | `tasks.open` | Tarefas |
| `navigation.inbox` | `inbox.open` | Conversas |
| `navigation.kanban` | `kanban.open` | Funil |
| `navigation.contacts` | `contacts.open` | Contatos |
| `navigation.agenda` | `agenda.open` | Agenda |
| `navigation.radar` | `radar.open` | Radar |

**Toda capacidade usada num card tem de estar coberta por uma permissão declarada.** Usar
`inbox.open` sem declarar `navigation.inbox` é recusado — na instalação, na ativação e na leitura.
A razão não é burocracia: a lista de permissões é o que a tela mostra **antes** de alguém aceitar a
extensão, e uma porta usada sem estar declarada esconde exatamente a informação que essa tela
existe para dar.

Declarar uma permissão que nenhum card usa é permitido e é ruído — quem instala lê uma porta a
mais do que a extensão abre.

**O pacote nunca informa um endereço.** Ele nomeia a porta; o host traduz o nome num destino que é
constante do código. Não existe campo de URL, nem prefixo, nem "destino customizado" — e não vai
existir: a ADR-0003 recusa endereço livre "para sempre", porque ele alcançaria as telas onde a
instalação guarda segredo com todos os testes verdes.

### Um card

```json
{
  "id": "slug-estavel",
  "title": { "pt-BR": "até 100 caracteres" },
  "description": { "pt-BR": "até 400 caracteres" },
  "icon": "BookOpen",
  "blocks": [{ "heading": { "pt-BR": "até 100" }, "body": { "pt-BR": "até 2.000" } }],
  "action": { "label": { "pt-BR": "até 100" }, "capability": "inbox.open" }
}
```

- `id` é **identidade estável entre versões**: é o que a URL do guia carrega. Renomear o `id` na
  versão 1.1 quebra o link que alguém deixou aberto (`409 extension_card_unavailable`).
- Até **8** blocos por card. A lista pode ser vazia — o card fica só com título, descrição e botão.
- O botão é obrigatório: todo card tem uma `action`.

## A entrada de catálogo

O catálogo é outro arquivo, e é ele que quem administra a instalação admite pela tela. Cada entrada
repete parte do manifesto e acrescenta o que prova os bytes:

```json
{
  "publisher": "…", "name": "…", "version": "…", "license": "MIT",
  "host_api": { "min": 2, "max": 2 },
  "display": { … },
  "permissions": ["…"],
  "sha256": "64 hex do arquivo do pacote",
  "byte_length": 3246
}
```

A conferência é **byte a byte**, e a lista de permissões é comparada **na ordem**. Reformatar o
JSON do pacote depois de publicar (um espaço, uma quebra de linha) muda o `sha256` e o download é
recusado com `extension_digest_mismatch`. Publicar a mesma versão com bytes diferentes é
`extension_version_conflict` — versão nova pede número novo.

`.agents/skills/deskcomm-extensao/scripts/validar-pacote.sh` imprime a entrada pronta, com o digest e o tamanho calculados dos bytes
que você acabou de validar.

## Tetos que não estão em `EXTENSION_LIMITS`

Vivem na migration `0271` e no cliente de download. Os comandos, porque os números envelhecem:

```bash
grep -n ">= 8\|>= 128" supabase/migrations/*_0271_*.sql   # catálogos, preparações, ativas por organização
grep -n "DOWNLOAD_TIMEOUT_MS" lib/extensions/download.ts  # prazo total do download
```
