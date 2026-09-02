# Prompts das imagens 3D da LP

> Para gerar no ChatGPT. **Gere tudo numa sessão só** — é o que garante coerência entre as peças.
> Ordem importa: gere `mesa-01` primeiro e use como referência visual para as demais.

---

## Como usar

> Os nomes nas tabelas abaixo são **como salvar cada arquivo**, e a extensão de imagem
> não aparece de propósito — nem aqui na explicação.
> Nenhuma dessas imagens existe no repositório ainda — este documento é a especificação
> para gerá-las. Escritos com a extensão, eles seriam lidos como prova já entregue pelo
> guarda `tests/unit/evidencia-citada.test.ts`, que cobra: imagem citada é imagem versionada.


1. Abra **uma** conversa nova no ChatGPT e cole o **Bloco de Estilo** abaixo como primeira mensagem, sozinho.
2. Depois cole um prompt por vez, na ordem deste documento.
3. Peça sempre **PNG com fundo transparente**. Se vier com fundo, peça *"same image, transparent background"* — não regenere do zero, senão muda a cena.
4. A partir da segunda imagem, comece com: *"Same style, same camera angle, same lighting and same palette as the previous image."*
5. Nomeie os arquivos exatamente como o ID de cada bloco.

**Regra que economiza retrabalho:** nenhuma imagem tem texto. Rótulos, números e nomes entram como HTML por cima. Texto dentro de PNG não é lido por buscador nem por crawler de IA, não pode ser traduzido e serrilha em tela retina.

---

## BLOCO DE ESTILO (cole primeiro, sozinho)

```
You are generating a series of 3D illustrations for a product website. All images
must look like they came from the same render, same scene, same session.

Fixed style for every image in this series:

- Isometric 3D render, camera at 30 degrees, orthographic projection.
- Matte clay material: soft, very slightly rough surface. NO gloss, NO chrome,
  NO glass, NO metal, NO neon, NO glow, NO gradients.
- Strict palette, no other colors allowed:
    background / base          #faf9f6  (warm off-white)
    raised surfaces            #ffffff
    structure and edges        #e7e3da  (warm greige)
    active elements            #008069  (WhatsApp green)
    warning elements only      #b8863b  (muted amber)
    deep accent, sparingly     #194439
- Soft studio lighting from the upper left. Long, soft shadows in warm grey
  rgba(20,18,14,0.10). No hard shadows, no rim light.
- Generous empty space around the subject. Calm, precise, architectural.
- NO text, NO labels, NO numbers, NO letters, NO UI chrome, NO icons.
- Transparent background, PNG with alpha.
- Reference feeling: an architectural maquette or a museum model — not a
  videogame asset, not a tech illustration, not isometric clipart.

Confirm you understood and wait for the first image request.
```

---

# GRUPO 1 — HERO

## `mesa-01-completa` — a cena de referência

> Gere esta **primeira**. Todas as outras herdam a câmera e a luz dela.

```
An isometric 3D scene: one large rounded-rectangle desk surface floating in
empty space, seen from above at 30 degrees. The desk is warm off-white with a
subtle 1-unit raised edge.

Carved into the desk surface are thin recessed channels — grooves, not lines —
whose inner floor is WhatsApp green. The channels connect five modules that sit on
the desk:

1. LEFT EDGE: a module of three stacked rounded plates, slightly offset, like
   a small pile of cards (a conversation).
2. UPPER MIDDLE: four short vertical columns made of small stacked tiles,
   different heights (a pipeline).
3. CENTER: the tallest module, a rounded cylinder-ish block in WhatsApp green,
   slightly raised above the others (the agent).
4. RIGHT: a low circular module with a thin concentric ring on top (a timer).
5. BOTTOM: a wide flat module made of many thin parallel horizontal bars
   (a log).

Every module touches at least two channels. Nothing floats detached.
A single small WhatsApp-green sphere rests at the mouth of the conversation module,
at the left edge of the desk.

Composition: the desk occupies the right two-thirds of the frame, with empty
space on the left. Slight overhang beyond the frame on the right side.
```

### Camadas do hero

Depois da cena completa, peça cada camada **isolada**, sempre com esta fórmula:

```
Same scene, same camera, same lighting, same scale. Render ONLY [ELEMENTO].
Everything else fully transparent. Do not move or resize anything.
```

| Arquivo | `[ELEMENTO]` |
|---|---|
| `mesa-01-a-tampo` | `the desk surface and its shadow, with the empty channels carved but unlit` |
| `mesa-01-b-trilhas` | `the WhatsApp green channel floors, glowing softly from within the grooves` |
| `mesa-01-c-pecas` | `the five modules sitting on the desk` |
| `mesa-01-d-lead` | `the single small WhatsApp-green sphere` |

---

# GRUPO 2 — OS DOIS VILÕES

## `viloes-01-planilha-bonita`

```
Same style, same camera, same lighting and same palette as the previous image.

An isometric 3D scene: a desk surface like before, but BROKEN — the modules sit
scattered and disconnected, and the channels between them are carved but dead
ends: each groove stops short and never reaches the next module. Between two of
the modules there is a visible gap in the desk itself, a rectangular hole cut
through the surface.

A small WhatsApp-green sphere is caught mid-fall through that hole, halfway below the
desk plane. Nothing is reaching for it.

Mood: quiet, orderly, and wrong. The scene should look tidy — that is the point.
```

## `viloes-02-robo-que-some`

```
Same style, same camera, same lighting and same palette as the previous image.

An isometric 3D scene: a single WhatsApp green rounded module sits alone on a small
desk fragment. From its front face, three thin WhatsApp-green arcs project outward and
forward, like emitted sound. Behind and beside the module, all channels are
empty grooves that lead nowhere — no receiving module, no log, no record.

The desk fragment ends abruptly a short distance behind the module, like a
broken-off piece of a larger surface.

Mood: something is speaking with confidence into a place where nothing is
listening or recording.
```

---

# GRUPO 3 — SCROLLYTELLING (a peça central)

> Sete estados da **mesma** cena, em close. Gere `cena-00-base` e derive.
> Aqui a coerência é crítica: se a câmera mudar entre estados, a transição no scroll quebra.

## `cena-00-base` — o enquadramento fechado

```
Same style, same camera, same lighting and same palette as the previous image.

Close-up isometric view of the CENTER of the desk from the first image: the
conversation module (left), the WhatsApp-green agent module (center, tallest), the pipeline
columns (upper right), the timer ring (right) and the log bars (bottom).
The channels connecting them are clearly visible and currently unlit (plain
greige grooves).

Fill the frame with this cluster. This is the base state — everything present,
nothing active.
```

### Os sete estados

Para cada um, comece com: *"Same close-up scene, same camera, same lighting. Change ONLY what I describe; everything else stays identical."*

| Arquivo | Mudança pedida |
|---|---|
| `cena-01-chega` | `The conversation module is now lit WhatsApp-green. A thin flat panel rises just above and behind it, like a card being lifted from the desk, showing blank rounded rows.` |
| `cena-02-contexto` | `Add a small cluster of thin stacked plates to the left of the agent module, connected to it by a lit WhatsApp-green channel. Three of the plates are slightly pulled out from the stack.` |
| `cena-03-gates` | `Add a row of seven small identical upright blocks forming a short corridor between the agent module and the desk edge. Six blocks are WhatsApp green. The fourth one is amber and slightly rotated, blocking the corridor.` |
| `cena-04-veto` | `Zoom slightly toward the amber block. A thin flat panel rises beside it with blank rounded rows, and a short WhatsApp-green channel curves from the amber block BACK toward the agent module, forming a return loop.` |
| `cena-05-move` | `The small WhatsApp-green sphere now sits at the top of the second pipeline column instead of at the conversation module. The channel it travelled along is lit WhatsApp-green behind it.` |
| `cena-06-handoff` | `Add a second module beside the agent, same size but warm off-white instead of WhatsApp-green. A small flat plate is suspended midway between the two, tilted, as if being handed across.` |
| `cena-07-followup` | `The circular timer module is now lit WhatsApp-green with its ring partially filled. The WhatsApp-green sphere sitting in the pipeline column now has a thin amber ring around its base.` |

---

# GRUPO 4 — O TURNO DO AGENTE (vista explodida)

## `turno-01-fechado` e `turno-01-aberto`

> Referência do movimento: o cubo do Google CodeWiki que se abre nas próprias faces.
> **Diferença deliberada:** nada de fundo escuro nem glow azul. Aqui a peça se abre em
> camadas horizontais, e o "brilho" é ausência de sombra, não luz emitida.

```
Same style, same camera, same lighting and same palette as the previous image.

IMAGE A — closed:
A single solid rounded block, like a thick slab, floating in empty space at the
same isometric angle. Warm off-white, with six barely visible horizontal seams
across its side faces, suggesting it is made of six stacked layers pressed
together. One thin WhatsApp-green line runs vertically down its front face.

IMAGE B — exploded:
The exact same block, now separated into its six layers, spread apart vertically
with equal gaps between them, still perfectly aligned on the same vertical axis.
Each layer is a thin rounded slab. Between consecutive layers, a short vertical
WhatsApp-green connector links them.

The FIFTH layer from the top is amber instead of off-white, and from its left
edge a WhatsApp-green connector curves UPWARD and back into the FOURTH layer, forming a
visible return loop that bypasses the layers below it.

Keep the two images at identical scale and position so they can be cross-faded.
```

---

# GRUPO 5 — RADAR

## `radar-01`

```
Same style, same camera, same lighting and same palette as the previous image.

An isometric 3D scene: a circular disc set into the desk surface, with three
concentric raised rings dividing it into three bands.

- The innermost band is amber and holds four small spheres clustered close together.
- The middle band is warm greige and holds six spheres, more spread out.
- The outer band is WhatsApp green and holds eleven spheres, evenly distributed.

Each sphere casts its own small soft shadow onto the disc. The rings are low —
this is a shallow relief, not a bowl.
```

---

# GRUPO 6 — MULTI-NICHO

## `nichos-01-funil`

```
Same style, same camera, same lighting and same palette as the previous image.

An isometric 3D scene: four vertical columns of stacked rounded tiles, side by
side, of decreasing height from left to right (7, 5, 3, 2 tiles). Each column
sits on a small rounded base plate. Thin WhatsApp-green channels connect the base of each
column to the next.

Above each column, leave clearly empty space — no labels, no text, nothing.
That space is reserved for HTML labels.
```

> Uma imagem só. As quatro variantes de nicho são trocas de rótulo em HTML, não quatro renders.

---

# GRUPO 7 — WHITE-LABEL

## `marca-01`

```
Same style, same camera, same lighting and same palette as the previous image.

An isometric 3D scene: two identical rounded rectangular slabs, side by side and
slightly overlapping in depth, like two screens seen from above at an angle.
Both have the same internal structure of blank rows and blocks.

The LEFT slab has a small WhatsApp green square badge in its upper-left corner.
The RIGHT slab has a small amber circle badge in the same position.

Everything else about the two slabs is pixel-identical. The point is that only
the mark differs.
```

---

# GRUPO 8 — TEXTURA DE FUNDO (opcional, inspirada no Twenty)

## `textura-01-substrato`

> É o achado das referências do Twenty: a paisagem isométrica de micro-retângulos que
> lê como "o substrato de dados". Usada com opacidade baixa atrás das seções técnicas.

```
Same style, same lighting and same palette as the previous image.

A large flat isometric field made of thousands of tiny rectangular blocks of
varying lengths and very low height, arranged in dense horizontal rows, like a
schematic landscape seen from above at 30 degrees. Warm greige on off-white,
extremely low contrast.

Some regions are denser, some sparser, creating a subtle organic texture.
A few small clusters are WhatsApp green. No focal point — this is a field, not a
subject. It should read as quiet background texture, never as an illustration.

Square format, tileable if possible.
```

---

## Checklist antes de fechar cada imagem

- [ ] Nenhum texto, número ou letra dentro da imagem
- [ ] Só as cores da paleta — sem azul, roxo, vermelho puro ou preto
- [ ] Sem brilho, vidro, cromado ou neon
- [ ] Fundo transparente
- [ ] Mesmo ângulo de câmera das anteriores
- [ ] Sombra warm (não cinza-azulada, não preta)

## Se alguma imagem sair fora do padrão

Não tente consertar com um prompt novo do zero — isso muda a cena inteira. Peça a correção específica: *"Same image, but [only the fix]. Do not change anything else."* Se ainda assim divergir, regenere a partir do `mesa-01-completa` como referência anexada.

---

*Escrito em 27 de julho de 2026. Pareado com `lp-plano.md`.*
