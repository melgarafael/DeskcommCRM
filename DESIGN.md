# Visitors — Style Reference
> white engineering blueprint

**Theme:** light

Visitors is a bright white-canvas analytics product with a restrained grayscale spine and a single lavender accent (#918df6) that does the heavy lifting as a CTA color. Typography is confident and geometric — OpenRunde at heavy display weights with tight negative tracking, creating headlines that feel engineered rather than editorial. The interface lives flat: hairline borders, subtle surface tinting, minimal elevation, and pill-shaped controls that read as light and fast. Color appears as functional punctuation — green for positive deltas, amber for neutral data, pink and blue for feature categories — never as decoration on chrome.

## Tokens — Colors

| Name | Value | Token | Role |
|------|-------|-------|------|
| Carbon | `#181925` | `--color-carbon` | Primary text, headings, nav links — near-black with the faintest cool tint gives type a deliberate, engineered weight without pure-black harshness |
| Paper White | `#ffffff` | `--color-paper-white` | Page canvas, card surfaces, button fills — the base layer everything sits on |
| Linen | `#fafafa` | `--color-linen` | Subtle background sections, table rows, secondary surfaces — separates content bands from pure white without introducing a visible gray |
| Mist | `#f5f5f5` | `--color-mist` | Primary page canvas and white card surfaces. Do not promote it to the primary CTA color |
| Fog | `#e8e8e8` | `--color-fog` | Table gridlines, hairline borders, divider lines — the structural 1px that defines table cells and card edges |
| Ash | `#999999` | `--color-ash` | Muted body text, placeholder text, inactive nav items — secondary information that recedes |
| Graphite | `#666666` | `--color-graphite` | Secondary text, button text on light fills, captions — readable but clearly subordinate to Carbon |
| Lavender | `#918df6` | `--color-lavender` | Violet action color for filled buttons, selected navigation states, and focused conversion moments. |
| Iris | `#9580ff` | `--color-iris` | Register button and gradient endpoint — a slightly deeper lavender for secondary action emphasis |
| Mint | `#33c758` | `--color-mint` | Green text accent for links, tags, and emphasized short phrases. Use as a supporting accent, not as a status color |
| Mint Wash | `#def6e4` | `--color-mint-wash` | Soft section background, alternate surface, and quiet card fill. Use as a supporting accent, not as a status color |
| Amber | `#ffa600` | `--color-amber` | Yellow text accent for links, tags, and emphasized short phrases |
| Sky | `#2c78fc` | `--color-sky` | Violet text accent for links, tags, and emphasized short phrases. |
| Magenta | `#d6409f` | `--color-magenta` | Visitor profiles category, icon accents — vivid pink that earns its place by mapping to one specific feature domain |
| Ember | `#ff3e00` | `--color-ember` | Chart fill accents, decorative illustration — warm orange that breaks the cool palette inside data visualizations |

## Tokens — Typography

### OpenRunde — Single typeface across all UI — geometric humanist sans with tight apertures and slightly compressed proportions. Display headlines at 60px/600 with -3px tracking feel engineered; body at 16px/400 with -0.32px tracking reads crisp without feeling clinical. · `--font-openrunde`
- **Substitute:** Inter, DM Sans, or Geist Sans
- **Weights:** 400, 500, 600, 700
- **Sizes:** 12px, 13px, 14px, 16px, 18px, 20px, 24px, 36px, 48px, 60px
- **Line height:** 1.00–1.56
- **Letter spacing:** -0.007em at 48px, -0.017em at 36px, -0.013em at 24px, -0.016em at 20px, -0.018em at 18px, -0.020em at 16px, -0.023em at 14px, -0.025em at 13px, -0.027em at 12px, -0.050em at 60px
- **Role:** Single typeface across all UI — geometric humanist sans with tight apertures and slightly compressed proportions. Display headlines at 60px/600 with -3px tracking feel engineered; body at 16px/400 with -0.32px tracking reads crisp without feeling clinical.

### Type Scale

| Role | Size | Line Height | Letter Spacing | Token |
|------|------|-------------|----------------|-------|
| caption | 12px | 1.33 | -0.32px | `--text-caption` |
| body | 16px | 1.5 | -0.32px | `--text-body` |
| subheading | 18px | 1.33 | -0.32px | `--text-subheading` |
| heading-sm | 24px | 1.17 | -0.31px | `--text-heading-sm` |
| heading | 36px | 1.22 | -0.61px | `--text-heading` |
| heading-lg | 48px | 1 | -0.34px | `--text-heading-lg` |
| display | 60px | 1.13 | -3px | `--text-display` |

## Tokens — Spacing & Shapes

**Base unit:** 4px

**Density:** comfortable

### Spacing Scale

| Name | Value | Token |
|------|-------|-------|
| 4 | 4px | `--spacing-4` |
| 8 | 8px | `--spacing-8` |
| 12 | 12px | `--spacing-12` |
| 16 | 16px | `--spacing-16` |
| 20 | 20px | `--spacing-20` |
| 24 | 24px | `--spacing-24` |
| 32 | 32px | `--spacing-32` |
| 48 | 48px | `--spacing-48` |
| 64 | 64px | `--spacing-64` |

### Border Radius

| Element | Value |
|---------|-------|
| tags | 9999px |
| cards | 16px |
| images | 8px |
| inputs | 8px |
| tables | 24px |
| buttons | 9999px |

### Shadows

| Name | Value | Token |
|------|-------|-------|
| subtle | `rgba(0, 0, 0, 0.08) 0px 1px 1px 1px, rgba(0, 0, 0, 0.06) ...` | `--shadow-subtle` |
| subtle-2 | `rgba(0, 0, 0, 0.08) 0px 1px 1px 0px, rgba(0, 0, 0, 0.05) ...` | `--shadow-subtle-2` |
| subtle-3 | `rgba(0, 0, 0, 0.06) 0px 1px 3px 0px, rgba(0, 0, 0, 0.06) ...` | `--shadow-subtle-3` |

### Layout

- **Page max-width:** 1200px
- **Section gap:** 64px
- **Card padding:** 32px
- **Element gap:** 16px

## Components

### Primary Action Button (Filled)
**Role:** Main conversion CTA — Start trial, Register

Pill shape (9999px radius), Lavender (#918df6) fill, white text, OpenRunde 14px weight 500, letter-spacing -0.32px, padding 10px 20px, no border. Subtle shadow: rgba(0,0,0,0.08) 0px 1px 1px 1px + rgba(0,0,0,0.06) 0px 0px 0px 0.5px.

### Register Button (Deeper Lavender)
**Role:** Secondary emphasis CTA in nav

Pill shape, Iris (#9580ff) fill, white text, OpenRunde 14px weight 500, padding 6px 10px. Slightly deeper saturation differentiates from the main CTA.

### Ghost Button
**Role:** See demo, secondary nav actions

Transparent fill, Graphite (#666666) text, no border, pill shape (9999px radius), OpenRunde 14px weight 500, padding 10px 20px. Relies on whitespace and contrast alone.

### Text Link Button
**Role:** Inline nav links, Login

Transparent fill, Carbon (#181925) text, 12px horizontal padding, no border, no radius. Hairline underline on hover. Weight 500, 14px.

### Announcement Chip
**Role:** Top banner — 'NEW We hit $1K MRR'

White fill, Sky (#2c78fc) 'NEW' tag text + Carbon (#181925) body text, thin border, pill shape (9999px radius), inline icon. 14px weight 500.

### Navigation Pill
**Role:** Top nav bar with Features dropdown

White fill, Carbon text, full pill container (9999px radius) wrapping nav items. Active state shows Lavender underline or fill. Padding 8px internal.

### Tab Bar (Dashboard Tabs)
**Role:** Dashboard sub-navigation — Dashboard, Profiles, Funnels, Performance, Realtime

Horizontal tab row, white fill, Ash (#999999) inactive text, Carbon active text with Lavender underline indicator. 14px weight 500, no background fill change.

### Feature Card
**Role:** Three-column feature grid — Lightweight, 5-minute, Independent

Transparent fill (or very light wash), no border, no shadow, Lavender icon circle (40px) above Carbon bold heading + Graphite body. Center-aligned, 32px vertical padding.

### Pricing Tier Card
**Role:** Subscription plan container

White fill, 1px Fog (#e8e8e8) border, 24px radius, 64px vertical / 32px horizontal padding, no shadow. Carbon heading, Graphite feature list.

### Metric Callout Card
**Role:** Dashboard stat tiles — People, Revenue, Views, etc.

White fill, 1px Fog border, 16px radius, tight padding (12px). Mint (#33c758) for positive delta text, Ember (#ff3e00) for negative. Label in Ash, value in Carbon bold.

### Dashboard Panel Card
**Role:** Chart container — 28 people, Experience Score, Revenue

White fill, 1px Fog border, 16px radius, 20px padding. Carbon heading, small Ash caption. Soft inner shadow for depth: rgba(0,0,0,0.06) 0px 1px 3px + rgba(0,0,0,0.06) 0px 8px 16px.

### Data Table
**Role:** Analytics data grid

White fill, 1px Fog (#e8e8e8) gridlines, 24px container radius, no row striping. OpenRunde 12-14px weight 400-500. Header row in Carbon bold, body in Graphite.

### Avatar Circle
**Role:** User identification in dashboard

40px circle, photographic fill, no border or 1px white ring. Used sparingly in nav and dashboard header.

## Do's and Don'ts

### Do
- Use Lavender (#918df6) exclusively for the primary action button — never for body text, borders, or decorative elements.
- Set display headlines at 60px/600 with -3px letter-spacing; the tight tracking is what makes the type feel engineered.
- Use 9999px radius on every button, chip, and tag — the pill shape is a signature.
- Apply 1px solid Fog (#e8e8e8) borders on cards and tables; avoid heavy box-shadows for surface definition.
- Pair Mint (#33c758) with Mint Wash (#def6e4) backgrounds for positive metric callouts; never use green text on white without the pastel fill.
- Use OpenRunde weight 500 for all headings and buttons; reserve weight 400 for body and captions.
- Center the hero headline and CTA stack; let the whitespace below the 60px display do the work.

### Don't
- Don't use Iris (#9580ff) for body CTAs — it's reserved for the Register nav button to differentiate from the main Lavender CTA.
- Don't apply elevation shadows larger than the three-layer stack — dramatic drop shadows break the flat aesthetic.
- Don't mix multiple accent colors in one component — each feature category gets exactly one color (Sky for realtime, Amber for performance, Magenta for profiles).
- Don't set heading text in pure black (#000000) — use Carbon (#181925) for the slight cool tint.
- Don't use Ember (#ff3e00) for UI chrome — it's decorative-only, for chart fills and illustration.
- Don't break the pill-radius convention with rectangular buttons or sharp-cornered tags.
- Don't add background colors to feature card containers — they should sit on pure white with only icon + text.

## Surfaces

| Level | Name | Value | Purpose |
|-------|------|-------|---------|
| 0 | Canvas | `#ffffff` | Base page background, hero area, dashboard cards |
| 1 | Linen Band | `#fafafa` | Subtle alternating sections, feature rows, secondary content bands |
| 2 | Mist Fill | `#f5f5f5` | Ghost button backgrounds, input fields, disabled states |
| 3 | Mint Wash | `#def6e4` | Positive metric callout backgrounds, growth indicator surfaces |

## Elevation

- **Primary Action Button:** `rgba(0, 0, 0, 0.08) 0px 1px 1px 1px, rgba(0, 0, 0, 0.06) 0px 0px 0px 0.5px`
- **Secondary Button / Ghost:** `rgba(0, 0, 0, 0.08) 0px 1px 1px 0px, rgba(0, 0, 0, 0.05) 0px 0px 0px 1px`
- **Elevated Card / Dashboard Panel:** `rgba(0, 0, 0, 0.06) 0px 1px 3px 0px, rgba(0, 0, 0, 0.06) 0px 8px 16px 0px, rgba(0, 0, 0, 0.02) 0px 0px 0px 1px`

## Imagery

Minimal product photography — no lifestyle imagery, no people. Visual content is dominated by dashboard screenshots rendered as hero artwork (the analytics UI mockup in the gradient band) and small grayscale partner logos (Temple, inbound, Buildkite, etc.) used as social proof. Decorative gradients in the blue-to-lavender spectrum appear as atmospheric bands behind product imagery. Iconography is flat, single-color, circular containers — no outlined or illustrated icons, just solid filled glyphs in a 40px Lavender circle.

## Layout

Full-width sections stacked vertically with max-width ~1200px content centered. Hero is a centered text stack (announcement chip → 60px headline → subtext → dual CTA → partner logos) on white, followed immediately by a full-bleed atmospheric gradient band (blue-to-lavender) containing a floating dashboard mockup in a white card with rounded corners. Feature sections alternate between centered 3-column icon grids and alternating 2-column text+product layouts. All sections use generous 64px+ vertical breathing room. Navigation is a single centered pill-bar floating at the top with no sticky behavior visible. Footer is minimal, multi-column link grid.

## Agent Prompt Guide

## Quick Color Reference
- text (primary): #181925 Carbon
- text (secondary): #666666 Graphite
- text (muted): #999999 Ash
- background: #ffffff Paper White
- border: #e8e8e8 Fog
- accent / primary action: #918df6 (filled action)
- primary action: #918df6 (filled action)

## 3-5 Example Component Prompts

1. Create a Primary Action Button: #918df6 background, #181925 text, 9999px radius, compact pill padding. Use this filled treatment for the main CTA.

2. **Dashboard Metric Card**: White (#ffffff) fill, 1px solid #e8e8e8 border, 16px radius, padding 12px. Label 'Revenue' at 12px weight 400, color #999999. Value 'A$750' at 24px weight 500, color #181925. Delta '+20%' at 12px weight 500, color #33c758.

3. **Feature Card (3-column grid)**: White background, no border, no shadow. Lavender (#918df6) icon in 40px circle, fill #918df6, white glyph centered. Heading at 18px weight 500, color #181925, letter-spacing -0.32px. Body at 16px weight 400, color #666666. Center-aligned text, 32px vertical padding.

4. **Announcement Chip**: White (#ffffff) fill, 1px border #e8e8e8, 9999px radius, padding 6px 12px. 'NEW' tag in #2c78fc weight 500 12px, body text in #181925 weight 500 14px, arrow icon in #181925.

5. **Tab Bar**: Horizontal row, white background, no border between tabs. Inactive tab text at 14px weight 500, color #999999. Active tab text at 14px weight 500, color #181925, with 2px solid #918df6 underline indicator.

## Gradient System

Four gradients detected, used as atmospheric bands rather than UI fills:
1. Sky→Lavender: linear-gradient(to right in oklab, #2c78fc 0%, #918df6 100%) — primary hero band behind dashboard mockup
2. Shimmer gray: linear-gradient(90deg, #b3b3b3 25%, #666666 50%, #b3b3b3 75%) — skeleton loading state
3. Pale sky progression: linear-gradient(to right in oklab, #bed5fe 0%, #bed5fe 50%, #00c4ff 100%) — chart fill
4. Pale sky→lavender: linear-gradient(to right in oklab, #bed5fe 0%, #ebf2ff 50%, #918df6 100%) — decorative accent

Use gradients only as full-bleed section backgrounds or chart fills — never on buttons, cards, or text.

## Similar Brands

- **Plausible Analytics** — Same white-canvas analytics aesthetic with a single vivid accent color for CTAs, generous spacing, and pill-shaped controls
- **Linear** — Same hairline-border-on-white surface treatment, tight geometric type with negative tracking, and minimal elevation philosophy
- **Fathom Analytics** — Same privacy-first SaaS pattern: monochrome spine with one brand color doing CTA duty, flat cards, and tight typographic scale
- **Vercel** — Same engineering-blueprint visual language: white canvas, subtle gray borders, single accent gradient for hero bands, geometric sans-serif type
- **Cal.com** — Same pill-button convention, pastel accent surfaces for positive states, and flat minimal-elevation card aesthetic

## Quick Start

### CSS Custom Properties

```css
:root {
  /* Colors */
  --color-carbon: #181925;
  --color-paper-white: #ffffff;
  --color-linen: #fafafa;
  --color-mist: #f5f5f5;
  --color-fog: #e8e8e8;
  --color-ash: #999999;
  --color-graphite: #666666;
  --color-lavender: #918df6;
  --color-iris: #9580ff;
  --color-mint: #33c758;
  --color-mint-wash: #def6e4;
  --color-amber: #ffa600;
  --color-sky: #2c78fc;
  --color-magenta: #d6409f;
  --color-ember: #ff3e00;

  /* Typography — Font Families */
  --font-openrunde: 'OpenRunde', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  /* Typography — Scale */
  --text-caption: 12px;
  --leading-caption: 1.33;
  --tracking-caption: -0.32px;
  --text-body: 16px;
  --leading-body: 1.5;
  --tracking-body: -0.32px;
  --text-subheading: 18px;
  --leading-subheading: 1.33;
  --tracking-subheading: -0.32px;
  --text-heading-sm: 24px;
  --leading-heading-sm: 1.17;
  --tracking-heading-sm: -0.31px;
  --text-heading: 36px;
  --leading-heading: 1.22;
  --tracking-heading: -0.61px;
  --text-heading-lg: 48px;
  --leading-heading-lg: 1;
  --tracking-heading-lg: -0.34px;
  --text-display: 60px;
  --leading-display: 1.13;
  --tracking-display: -3px;

  /* Typography — Weights */
  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;

  /* Spacing */
  --spacing-unit: 4px;
  --spacing-4: 4px;
  --spacing-8: 8px;
  --spacing-12: 12px;
  --spacing-16: 16px;
  --spacing-20: 20px;
  --spacing-24: 24px;
  --spacing-32: 32px;
  --spacing-48: 48px;
  --spacing-64: 64px;

  /* Layout */
  --page-max-width: 1200px;
  --section-gap: 64px;
  --card-padding: 32px;
  --element-gap: 16px;

  /* Border Radius */
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-2xl: 16px;
  --radius-3xl: 24px;
  --radius-3xl-2: 32px;

  /* Named Radii */
  --radius-tags: 9999px;
  --radius-cards: 16px;
  --radius-images: 8px;
  --radius-inputs: 8px;
  --radius-tables: 24px;
  --radius-buttons: 9999px;

  /* Shadows */
  --shadow-subtle: rgba(0, 0, 0, 0.08) 0px 1px 1px 1px, rgba(0, 0, 0, 0.06) 0px 0px 0px 0.5px;
  --shadow-subtle-2: rgba(0, 0, 0, 0.08) 0px 1px 1px 0px, rgba(0, 0, 0, 0.05) 0px 0px 0px 1px;
  --shadow-subtle-3: rgba(0, 0, 0, 0.06) 0px 1px 3px 0px, rgba(0, 0, 0, 0.06) 0px 8px 16px 0px, rgba(0, 0, 0, 0.02) 0px 0px 0px 1px;

  /* Surfaces */
  --surface-canvas: #ffffff;
  --surface-linen-band: #fafafa;
  --surface-mist-fill: #f5f5f5;
  --surface-mint-wash: #def6e4;
}
```

### Tailwind v4

```css
@theme {
  /* Colors */
  --color-carbon: #181925;
  --color-paper-white: #ffffff;
  --color-linen: #fafafa;
  --color-mist: #f5f5f5;
  --color-fog: #e8e8e8;
  --color-ash: #999999;
  --color-graphite: #666666;
  --color-lavender: #918df6;
  --color-iris: #9580ff;
  --color-mint: #33c758;
  --color-mint-wash: #def6e4;
  --color-amber: #ffa600;
  --color-sky: #2c78fc;
  --color-magenta: #d6409f;
  --color-ember: #ff3e00;

  /* Typography */
  --font-openrunde: 'OpenRunde', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  /* Typography — Scale */
  --text-caption: 12px;
  --leading-caption: 1.33;
  --tracking-caption: -0.32px;
  --text-body: 16px;
  --leading-body: 1.5;
  --tracking-body: -0.32px;
  --text-subheading: 18px;
  --leading-subheading: 1.33;
  --tracking-subheading: -0.32px;
  --text-heading-sm: 24px;
  --leading-heading-sm: 1.17;
  --tracking-heading-sm: -0.31px;
  --text-heading: 36px;
  --leading-heading: 1.22;
  --tracking-heading: -0.61px;
  --text-heading-lg: 48px;
  --leading-heading-lg: 1;
  --tracking-heading-lg: -0.34px;
  --text-display: 60px;
  --leading-display: 1.13;
  --tracking-display: -3px;

  /* Spacing */
  --spacing-4: 4px;
  --spacing-8: 8px;
  --spacing-12: 12px;
  --spacing-16: 16px;
  --spacing-20: 20px;
  --spacing-24: 24px;
  --spacing-32: 32px;
  --spacing-48: 48px;
  --spacing-64: 64px;

  /* Border Radius */
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-2xl: 16px;
  --radius-3xl: 24px;
  --radius-3xl-2: 32px;

  /* Shadows */
  --shadow-subtle: rgba(0, 0, 0, 0.08) 0px 1px 1px 1px, rgba(0, 0, 0, 0.06) 0px 0px 0px 0.5px;
  --shadow-subtle-2: rgba(0, 0, 0, 0.08) 0px 1px 1px 0px, rgba(0, 0, 0, 0.05) 0px 0px 0px 1px;
  --shadow-subtle-3: rgba(0, 0, 0, 0.06) 0px 1px 3px 0px, rgba(0, 0, 0, 0.06) 0px 8px 16px 0px, rgba(0, 0, 0, 0.02) 0px 0px 0px 1px;
}
```
