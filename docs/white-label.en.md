<!-- traduzido-de: docs/white-label.md@c5a80f6317f8 -->

[🇧🇷 Português](white-label.md) · 🇺🇸 English

# Installing for clients (agencies and resellers)

A guide for whoever installs SonghaiCRM **for other companies** — agency, consultancy, reseller — and charges for it.

The license is MIT: you may modify it, host it for third parties, resell it and charge whatever you want. There is no royalty, no clause forbidding commercial hosting, and there is no paid edition that locks features away from your client.

---

## Changing the brand

**From the screen, and without restarting anything.** In `/admin/marca` you change the **system name** and the **brand color**. You save, you reload, and the whole interface is already repainted — the sidebar, the buttons, the focus ring, the tab title and the browser icon.

The color is **derived**, not applied raw: one hex yields eleven shades in both themes (light and dark), with a contrast floor computed per role and per surface. If the color you picked would be illegible as button text in the dark theme, the system walks the steps it needs and the screen **shows you** which shade each thing will land on, before you save. None of that "I picked yellow and the button turned white on white".

**The logo too.** On the same screen you **upload the file** — PNG or JPG, up to 512 KB. It goes to your own installation's storage and takes effect right away, with no restart and without you hosting an image anywhere. Fixed height, free width, so that artwork of any proportion is not distorted; with no logo, the name shows up as text.

The file is accepted **by its bytes, not by its extension**. Renaming an `.svg` to `.png` fools nothing: the system reads the content, refuses it and says why. This is not fussiness — SVG is XML and can carry script, which would run if someone opened the image directly by its address, in a bucket that is public by necessity.

If you would rather host it yourself, you still can, through the `.env`:

```bash
APP_LOGO_URL=https://cdn.yourcompany.com/logo.svg
```

Between the two, **the file uploaded from the screen beats the `.env` URL** — whoever uploaded it expressed the more recent choice. And removing an organization's logo **gives back the installation's**, not "none": the layers fall back onto one another instead of erasing.

### The three `.env` variables, and what they really do

```bash
APP_NAME=Turbo Sales CRM
APP_LOGO_URL=https://cdn.yourcompany.com/logo.svg
APP_ACCENT_HEX=#7a5cd6
```

`install.sh` asks for **two** of them and writes them down: `APP_NAME` (Enter keeps the default) and `APP_ACCENT_HEX` (Enter uses the system color). It does not ask for `APP_LOGO_URL` — the normal path for the logo is uploading the file from the screen, and this key exists for whoever would rather host it themselves.

> The color is asked with a validator: only `#` + 6 digits gets through. That is narrower than what the screen accepts, and deliberately so — the **access e-mails** (account confirmation and password recovery) read this key from the `.env`, and they recognize that form only. A `#abc` or a `7a5cd6` would paint the interface with your color and leave the product's green in the first e-mail your client opens.

> ⚠️ **Changing the color from the screen afterwards does NOT rewrite the access e-mails.** Their text lives inside Supabase (GoTrue), not in the CRM, and what pushes it there is `marca-emails.sh` — which reads the **`.env`**, not the database. For the e-mails to follow a color changed in `/admin/marca`: adjust `APP_ACCENT_HEX` in the `.env` as well and run `bash self-host-kit/marca-emails.sh`. This is why the installer interview matters: it is the only moment when both ends are born identical without anyone having to know about this.

What these variables are, exactly: **seed and rollback floor.**

- **Seed** — on the first read, whatever is in the `.env` is written to the database. That is how a new installation is born already carrying your name.
- **Rollback floor** — if you roll back to an earlier version of the system, `agent.sh` reverts the **image**, not the **database**. The brand that survives any rollback is the one in the `.env`.

After the first read, **the database rules**. Changing the color from the screen does not ask for `docker compose up -d`, does not ask for a restart, does not ask for anything: the read happens on every page load, with a short cache that the screen itself invalidates on save.

### Why this is configuration, and not a code edit

Changing the brand by editing the source files works **once**. On the next `bash update.sh`, the new image overwrites the patch and your client's brand becomes ours again — usually without anyone noticing, until the client does.

Configuration survives every update. That is why the brand is read at runtime and never baked into the build: **a single Docker image serves any brand**. For the same reason there is no "image with your brand": `update.sh` rewrites the `APP_IMAGE` line of the `.env` on every update, and your image would be silently replaced by ours, in a routine update.

---

## Brand per organization

**One installation serves several organizations, and each one may have its own brand.** The admin of each organization opens `Configurações → Marca` (`/app/settings/marca`) and defines its **name**, **color** and **logo** — without needing you, and without seeing the others.

The boundary, which is deliberate:

| Where | Which brand shows up |
|---|---|
| `/login`, sign-up, password recovery, two-step verification | The **installation's** (yours) |
| Inside the system (`/app/...`), after signing in | The **organization's**, if it has one; otherwise the installation's |
| Access e-mails (account confirmation, password recovery) | The **installation's** |
| Team invite, LGPD e-mails | The **organization's** that sent them |

The reason login is left out is not a limitation: **before the person signs in, the system does not know which organization they belong to.** Painting the login with the color of one of them would be picking one in the dark.

This does not make the dedicated installation obsolete — see the comparison below, which still holds on infrastructure, isolation and sales pitch.

### What is not configurable yet

Straight to the point, so that you do not find out in front of the client. Each line carries the measured reason, not the excuse:

- **Domain per organization.** One installation, one domain. There is no domain column in the schema, the host-based branching in `proxy.ts` is a declared NOOP (it exists only as documentation of the intended topology), and at the Edge there is no database to query before deciding whom that host belongs to. A client who demands their own domain is asking for a **dedicated installation**.
- **Font.** Typography is the same in every installation. `next/font` resolves at **build** time, and the image your VPS downloads already arrives built — a font picker in the panel would save a value that nothing would read. (The font is Atkinson Hyperlegible, chosen by the Braille Institute for legibility; swapping it does not change brand perception and makes reading worse for whoever spends the day inside the system.)
- **Theme.** The light/dark pair belongs to the design system. Your brand moves the **accent** — what is action, highlight and focus — and deliberately does **not** move the page background: the background is the same under every brand, and that is why the browser bar color is too.
- **The LGPD data-subject report does not carry your brand — and that is on purpose.** See its own section below.
- **The AI budget alarm** still goes out with our brand. It is the only known leak, and it stays: today that alarm has no schedule wired to it at all, so fixing its brand would change nothing anyone sees. It goes out when the alarm gets a real cron.
- **Two technical names do not change**: the `X-Deskcomm-Signature` header of outbound webhooks and the session cookie. The first is a contract with third-party systems that already check that name; renaming it would break a client's integration **silently** — the receiver raises no error, it merely stops recognizing.

---

## The e-mails

### The access e-mails — the first artifact your client's client receives

Account confirmation and password recovery **are not sent by the system**: what assembles and fires them is Supabase's authentication service. No code of ours runs in there — it is text that has to be **pushed** over there by API.

That is why the kit ships a script of its own:

```bash
bash self-host-kit/marca-emails.sh
```

It uploads the subject and the body of both e-mails with **your** name and **your** color, and on top of that configures the link's return address (which no script configured before, and which is a prerequisite for the link to work at all). `install.sh` calls it by itself, right after creating the Supabase project; `update.sh` calls it too, so that an old installation receives this on its first update.

**If it does not have the Supabase API access key** (`SUPABASE_ACCESS_TOKEN`), it does not fail and does not take the installation down: it prints exactly what to do by hand in the Supabase dashboard and exits successfully. That is the case of whoever created the project from the dashboard and pasted the credentials, instead of letting the installer create it.

> ⚠️ **If you are going to do it by hand, mind the character.** The template link must carry `&token_hash=`, with **`&`**, never `?`. With `?` the address ends up with two question marks, the system loses the token and the user lands on a screen saying the link expired — when the problem is the template. In that case the system now **names the cause** instead of merely saying "invalid link".

### Team invite and LGPD e-mails

They go out with the brand of the **organization** that originated them — because whoever processed the request, inside your client's product, is your client's system.

To send them, fill in the two variables (`install.sh` asks for both):

```bash
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=no-reply@yourcompany.com
```

**The address has to belong to a domain verified in YOUR Resend account.** That is the one piece the brand does not solve: the name that shows up in the inbox is the brand; the address belongs to whoever hosts.

**Leaving them blank is a supported choice, not a defect.** Without them the system does not try to send and does not fail silently: the invite shows the acceptance link **on the screen itself**, for you to copy and send however you like, and the LGPD export stays pending review instead of vanishing. Before, a blank address made every send fail over at Resend with an opaque message, and the operator would go hunting network, container and key because of an empty variable.

### The support address your clients see

```bash
SUPPORT_EMAIL=support@yourcompany.com
```

It shows up on the suspended-account and billing screens. **Empty means empty:** the screen simply shows no address at all — it never falls back to ours. On a suspended-account screen that matters: whoever suspended it was you, not us.

---

## The data-protection report is the only thing that does NOT carry your brand

When a data subject exercises their access right — the report cites **Law No. 3/2017 (Mozambique)**, the product's actual legal basis; internal identifiers (`lgpd_*`, `/lgpd` routes) keep that name only as technical inheritance from the original Brazil-built template — the system generates a PDF report. That document **carries no brand at all** — not ours, not yours, no logo, no color. It names the **controller**: the organization's legal name, plus the data protection officer (DPO).

This is a product decision, not a forgotten item. In a document that answers a legal right, whoever is named answers for the data. **You are the processor, not the controller.** Changing the name there to your brand would not be "completing the whitelabel" — it would make things worse: today the name that appeared was obviously the software's, and afterwards it would look like the declaration of who is legally liable for those people's data.

**What that asks of you at install time:** check the **Razão social** — the legal name — of each organization in `Configurações → Empresa`. It is born equal to the trade name (that is what the installer has to give it), and a trade name printed as legal name in a legal document is the kind of error that only shows up when somebody complains.

The e-mail that delivers the export link is a different thing and does carry the organization's brand: it says who **operated**. The PDF says who **answers**. They are different roles, and that is why the two carry different names.

---

## One client per installation, or all of them in one?

The system is multi-tenant from the first line: one installation serves several organizations, and the isolation between them is verified in CI on every change — a user of one organization sees no row of another. This is not a marketing promise: it is the test `tests/invariants/rls-isolation.test.ts`, which creates two organizations and proves the non-leak through the same authentication path production uses.

Even so, the two models serve different purposes:

| | One installation per client | One installation for everyone |
|---|---|---|
| **Brand** | Each client's, including on the sign-in screen | Yours at login; each organization's inside the system |
| **Infrastructure cost** | One VPS per client | One VPS |
| **Failure** | Isolated | Hits everyone |
| **Update** | One at a time, can be staggered | Everyone at once |
| **Client data** | Physically separated | Separated by RLS |
| **Best for** | Reselling under the client's brand | Your own operation serving several accounts |

If your client asks "where does my data live?", the dedicated installation has the simpler answer to give — and to defend.

---

## The legal argument for a Mozambican client

The legal basis the product uses internally (data-request receipt, export PDF, default privacy policy) is **Law No. 3/2017** of Mozambique — not Brazil's LGPD. Code identifiers (`lgpd_*`, `/lgpd` routes) keep that name only as technical inheritance from the original template; what the data subject reads in the document is the Mozambican law.

⚠️ **Do not sell this as "installed in Mozambique = automatic compliance with Law No. 3/2017".** That is just as false as the Brazilian equivalent: compliance depends on legal basis, purpose, security and data-subject rights — not just on where the server sits. The product provides the mechanism (export, anonymization, audit trail, data protection officer); full compliance of your client's operation remains your client's responsibility.

If your client is Brazilian (the product's original base market, still supported), the same caution applies to the LGPD: **Resolution CD/ANPD nº 19/2024** made standard contractual clauses mandatory for **international transfers of personal data** (compliance deadline closed 23 August 2025) — hosting on a VPS in Brazil avoids that specific transfer, but does not replace the LGPD or Law No. 3/2017 as the legal basis declared to the data subject. Adjust the privacy policy and export PDF (`/legal/privacy`, `lib/lgpd/pdf-renderer.tsx`) to cite whichever law actually applies to your client's installation before selling into any market.

---

## Operation

Every installation ships the scripts in `self-host-kit/`:

| Command | What it does |
|---|---|
| `bash update.sh` | Updates. Backs up the database **first**, reapplies the schema idempotently and checks health at the end |
| `bash backup.sh` / `restore.sh` | Backup and restore |
| `bash reset-password.sh` | Resets a user's password |
| `bash reset-mfa.sh` | Removes two-step verification from whoever lost the device |
| `bash healthcheck.sh` | Diagnoses the installation |

`reset-mfa.sh` is the one you will use the most: two-step verification is mandatory for administrators, and changing phones without saving the recovery codes is the most common support call.

---

## Requirements per installation

**4 GB of RAM recommended** (the stack comes up with 2 GB, but runs at the limit — WAHA uses ~150 MB per WhatsApp session), ports 80 and 443, Docker Compose v2 and a domain with an A record pointing to the IP. The VPS compiles nothing — it downloads a ready-made image. The HTTPS certificate is issued automatically on first access.

Full installation guide: [`self-host-kit/README.md`](../self-host-kit/README.md).

---

*Last updated: 14 August 2026 — full revision after the own-brand epic. The two most quoted sentences in this document ("colors, fonts and theme are not configurable" and "the brand is per installation, not per organization") stopped being true and were rewritten with today's honest limit.*

*This document exists in three languages, and the prerequisite that the previous version of this footer named has been paid for: the translations carry, on their first line, a seal with the hash of the original, and editing `docs/white-label.md` without re-sealing fails `pnpm test:unit`. After translating, re-seal with `pnpm exec tsx scripts/selar-traducao.ts --todas`.*

*The three READMEs were deliberately left **out** of the seal. They are the most edited file in the repository: with a seal, every fix would become a PR blocked until ~490 lines were re-translated twice — and the realistic outcome of that is not up-to-date translations, it is somebody re-sealing without translating, which is the only way for the seal to die. They come in when someone chooses to pay that cost with their eyes open.*
