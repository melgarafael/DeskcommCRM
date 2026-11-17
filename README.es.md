<div align="center">

[🇧🇷 Português](README.md) · [🇺🇸 English](README.en.md) · 🇪🇸 Español

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/deskcomm-logo-dark.svg">
  <img src="docs/brand/deskcomm-logo.svg" alt="Deskcomm CRM" width="420">
</picture>

# 🛠️ DeskcommCRM — el Sistema Operativo de Ventas con IA, open source, para WhatsApp

**Agentes de IA que atienden, califican y venden en WhatsApp — dentro de un CRM open source que corre en tu propio servidor.**
**Sin mensualidad, sin funciones bloqueadas, tus datos siguen siendo tuyos. La alternativa abierta a Kommo, Octadesk e Intercom.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![Self-hosted](https://img.shields.io/badge/self--hosted-1%20comando-orange)](hostgator-setup-kit/)
[![CI](https://github.com/melgarafael/DeskcommCRM/actions/workflows/ci.yml/badge.svg)](https://github.com/melgarafael/DeskcommCRM/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/melgarafael)
<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-206-orange.svg?style=flat-square)](#contributors-)
<!-- ALL-CONTRIBUTORS-BADGE:END -->
[**⚡ Instalar**](#-instalar-en-tu-vps-el-camino-principal) · [**🔄 Actualizar**](#-actualizar) · [**🧭 Visión**](VISION.md) · [**🏗️ Arquitectura**](ARCHITECTURE.md) · [**🤝 Contribuir**](CONTRIBUTING.md) · [**🗺️ Roadmap**](#%EF%B8%8F-roadmap)

<img src="docs/assets/demo-deskcomm.gif" alt="Demostración de DeskcommCRM: agentes de IA, embudo de ventas y prospección" width="800">

</div>

---

> ### ☁️ Corre este CRM en producción con 1 comando
>
> DeskcommCRM se desarrolla en **alianza con HostGator**: el [`hostgator-setup-kit/`](hostgator-setup-kit/)
> instala el CRM completo (app + WhatsApp + base de datos) en un VPS con un único comando, y el
> [runbook de producción](docs/runbooks/waha-hostgator.md) ya asume ese entorno.
>
> **[👉 Contratar el VPS de HostGator con el descuento de la alianza](https://www.hostgator.com.br/52708-141-3-52.html)** —
> datacenter en São Paulo, ideal para WhatsApp funcionando 24/7. *(enlace de partner — contratar por él apoya el proyecto y te sale más barato)*
>
> **¿Todavía no tienes servidor?** Ejecuta esto **en tu propia computadora** (macOS, Linux o WSL).
> Te dice qué plan contratar — con los números reales del runbook, no un "depende" — y te
> devuelve el comando exacto para tu caso:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/hostgator-setup-kit/comecar.sh | bash
> ```
>
> *(¿prefieres leer antes de ejecutar? clona el repo y corre `bash hostgator-setup-kit/comecar.sh` —
> no instala nada sin que confirmes.)*

---

## ⚡ Instalar en tu VPS (el camino principal)

### 1. Entra a tu VPS

Abre la **Terminal** en tu computadora (en Windows, **PowerShell**; en Mac o Linux, la
**Terminal**) y conéctate con la IP y el puerto que tu hosting te envió por correo:

```bash
ssh -p PUERTO root@TU_IP
```

Reemplaza `PUERTO` y `TU_IP` por los tuyos. Si tu hosting no mencionó ningún puerto, es el que
viene por defecto (22) y puedes omitirlo: `ssh root@TU_IP`.

Te va a pedir la contraseña. **Mientras escribes, no aparece nada en pantalla — ni asteriscos.**
Eso no es que se haya trabado: la terminal está ocultando tu contraseña. Escríbela (o pégala) y
presiona Enter.

> En la primera conexión pregunta `Are you sure you want to continue connecting?` — responde
> `yes`. Es el servidor presentándose por primera vez.

### 2. Ejecuta el instalador

Ya dentro del VPS:

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git
cd DeskcommCRM
bash hostgator-setup-kit/install.sh
```

Eso es todo. **No instalas Node, ni pnpm, ni compilas nada** — la imagen de la app ya viene
lista. Si falta Docker, el instalador pregunta y lo instala solo.

### Lo que necesitas tener a mano

| Ítem | Dónde conseguirlo |
|---|---|
| **VPS con Docker** | [HostGator](https://www.hostgator.com.br/52708-141-3-52.html) (alianza) — o cualquier VPS con Docker. 4 GB de RAM recomendados |
| **Dominio** | Un registro **A** apuntando a la IP del VPS (ej.: `crm.tuempresa.com`) |
| **Base de datos** | Cuenta gratis en [supabase.com](https://supabase.com) — 3 claves + la cadena de conexión del **Session pooler** |
| **IA** | Una clave de **OpenRouter**, **Anthropic** u **OpenAI** — el instalador pregunta cuál quieres |
| **WhatsApp** | Tu número, conectado por código QR en el onboarding (o el canal oficial de Meta) |

> 💡 **Supabase puede crearlo el propio instalador.** Exporta un `SUPABASE_ACCESS_TOKEN` antes
> de ejecutarlo y él crea el proyecto, espera a que la base quede saludable, busca las 4
> credenciales y descubre el host del pooler probando una conexión real — sin copiar y pegar.

### Lo que el instalador hace por ti

**Pregunta solo lo que es tuyo** (dominio, claves, contraseña del admin), **valida cada
respuesta antes de seguir** — una clave equivocada la rechaza en el momento, no tres pasos
después — y se encarga del resto:

1. Genera todos los secretos técnicos solo (tú no inventas ninguna contraseña).
2. Crea las extensiones de Postgres y aplica el schema completo (`supabase/baseline.sql`).
3. Crea el primer admin con el correo y la contraseña que elegiste.
4. Levanta toda la stack con **HTTPS automático** y verifica la salud al final.
5. Instala el **cron de las automatizaciones** (sin él, las reglas CUANDO/SI/ENTONCES se
   acumulan en la cola) y el **agente de actualización**, que es lo que hace existir el botón
   "Actualizar ahora" en pantalla.

**Volver a ejecutarlo no rompe nada** — `install.sh` es idempotente: no duplica el cron, no
recrea el usuario y retoma donde se quedó.

> **Modo no interactivo:** copia `.env.hostgator.example` a `.env`, complétalo y ejecuta
> `bash hostgator-setup-kit/install.sh --yes`.

### ¿Otro hosting? (Hostinger, Coolify, Dokploy, CapRover…)

Funciona. Si tu VPS ya viene con un **proxy inverso propio** ocupando los puertos 80/443, el
instalador **lo detecta solo** y publica el CRM a través de él, en vez de intentar levantar un
Caddy que no cabría. En un caso específico — proxy en `--network host`, como hace Hostinger —
**pregunta en vez de adivinar**, porque publicar detrás del proxy equivocado instala "con éxito"
un sitio mudo. Detalles en [`hostgator-setup-kit/README.md`](hostgator-setup-kit/README.md).

### Primer acceso

Abre `https://<tu-dominio>` (el candado tarda ~1 min en aparecer), entra con el admin y ten a
mano **Google Authenticator** o **Authy** *si* querés activar la verificación en dos pasos — es **opcional** y está en Configuración › Seguridad; el primer inicio de sesión **no** la exige. En el
onboarding, escanea el código QR con el WhatsApp de tu número.

### 🤖 ¿Prefieres que una IA lo instale por ti?

Suelta la carpeta `hostgator-setup-kit/` en el chat de **Claude Code** corriendo dentro del VPS
y dile *"instálame el DeskcommCRM"*. Lee el [`CLAUDE.md`](hostgator-setup-kit/CLAUDE.md) del kit
— que trae el paso a paso y las trampas ya mapeadas — y conduce todo.

---

## 🔄 Actualizar

¿Salió versión nueva? Hay dos caminos, y el primero **no exige terminal**.

### Desde la pantalla (recomendado)

Cuando existe versión nueva, el pie del menú lateral enciende **"Nova versão"** — solo para el
dueño del servidor, porque avisarle a quien no puede actualizar es ruido. Haz clic y llegas a
**Configuración → Actualización**, que muestra qué cambia, **hace backup de la base sola** y
acompaña cada fase (backup → código → base → en línea) hasta terminar. Nada de SSH.

Si la versión nueva levanta rota, el agente **vuelve a la imagen anterior solo** y graba esa
vuelta en el `.env` — sin eso, el siguiente reinicio traería la app rota de nuevo, en silencio.

> Por debajo: la app solo registra el pedido; quien ejecuta es el agente que `install.sh` dejó
> en tu VPS, en un cron que revisa **cada 5 minutos** — así que la actualización empieza dentro
> de los 5 minutos del clic. Si ese agente está caído, la pantalla avisa **"Atualização
> automática indisponível"** y muestra el comando de abajo — nunca finge que funcionó.

### Desde la terminal

```bash
cd /ruta/al/DeskcommCRM
bash hostgator-setup-kit/update.sh
```

El comando hace, en este orden: (1) verifica si de verdad hay versión nueva — si no, sale de
inmediato; (2) **hace backup de la base antes de tocar nada**; (3) baja el código nuevo;
(4) actualiza la base re-aplicando `baseline.sql`, que es idempotente y **auto-curativo**
(repara datos que versiones viejas dejaron inconsistentes); (5) baja la imagen nueva de la app;
(6) verifica la salud al final.

**El objetivo es la última versión publicada** (`v1.2.3`), no la punta de `main` — actualizar
siempre lleva a una versión etiquetada y descrita en [`CHANGELOG.md`](CHANGELOG.md), nunca a un
commit sin probar. **Se niega** a volver a una versión anterior a la instalada (eso apagaría
cosas que ya tienes); para eso existe `--force`, a propósito.

**Cosas normales que vas a ver:** un montón de `already exists` / `multiple primary keys` en la
parte de la base — **es esperado e inofensivo**, son cosas que ya existían. El script filtra ese
ruido y muestra `✓ banco atualizado`. Si la base está ocupada con el CRM atendiendo, la aplica de
nuevo sola (hasta 3 pasadas) y lo dice en pantalla — esto vale desde la actualización siguiente a la
que instale esta corrección. Si aparece `⚠ Apareceram avisos no banco que NÃO são os esperados`, ahí sí guarda el
mensaje: el **final** de la salida dice qué hacer en cada caso (repetir con `--force` cuando la base
estaba ocupada, declarar `SUPABASE_DB_ADMIN_URL` cuando fue permiso).

**¿Salió mal?** Guarda el mensaje y pide ayuda. El `restore.sh` **no** vuelve el backup sobre la
base de datos en uso: solo restaura en una base de datos vacía (ver [`hostgator-setup-kit/README.md`](hostgator-setup-kit/README.md)).
**¿Solo quieres diagnosticar?** `bash hostgator-setup-kit/healthcheck.sh`.

> ⚠️ **En una instalación vieja que todavía no tiene el agente de la pantalla**, ejecuta
> `update.sh` **dos veces**: la primera es todavía el script viejo (que baja el nuevo); la
> segunda instala el agente y enciende el botón.

### Otros comandos del kit

| Script | Función |
|---|---|
| `install.sh` | Instala todo (idempotente — puedes volver a ejecutarlo) |
| `update.sh` | Actualiza a la versión nueva, con backup automático |
| `backup.sh` | Backup de la base + sesiones de WhatsApp |
| `restore.sh` | Restaura un backup |
| `reset-password.sh` | Redefine la contraseña de un usuario |
| `reset-mfa.sh` | Quita el MFA de quien perdió el celular |
| `healthcheck.sh` | Diagnóstico de todos los servicios de una vez |

> **El backup importa:** el plan gratis de Supabase **no hace backup solo**. Vale la pena
> agendar `backup.sh` diariamente en el cron. `update.sh` ya hace uno antes de cada
> actualización.

---

## ✨ Qué es

**Deskcomm** viene de **Desk** (escritorio) + **comm** (comercio): toda la operación de ventas de tu negocio en un solo escritorio, operada por personas y agentes de IA trabajando juntos.

El proyecto nació como CRM de e-commerce y la comunidad lo llevó mucho más lejos: hoy corre en **clínicas, inmobiliarias, infoproductos, agencias, tiendas y prestadores de servicios** — cualquier negocio que venda por WhatsApp. El producto acompañó ese giro y se convirtió en un **sistema operativo de ventas**: agentes de IA con RAG por tenant atienden, califican, mueven leads en el embudo, disparan automatizaciones y saben cuándo pasarle la conversación a una persona — con todo el CRM expuesto vía **MCP** para que los agentes lo operen de verdad. La historia completa está en [`VISION.md`](VISION.md).

### Diferenciales

- 🤖 **Agentes de IA que operan el CRM** — RAG por tenant, skills que el agente ejecuta solo durante la atención, memoria de la operación, análisis de sentimiento, handoff IA→humano auditado, IA como responsable de primera clase y tope de gasto por organización. No es un chatbot decorativo: el agente atiende, califica y mueve el embudo.
- 🔁 **Nada muere en silencio** — follow-up que retoma la conversación enfriada (con tiempo adaptativo y disparadores por etapa), radar de lo que corre riesgo de morir sin respuesta, y central de avisos para lo que necesita una decisión humana.
- 🧠 **Agentes que se automejoran** — las conversaciones resueltas se vuelven conocimiento nuevo; la pantalla de **Evolución de la IA** muestra si el agente está mejorando, dónde falla y qué falta enseñarle; **Propuestas** son mejoras que la IA sugiere para sí misma, aplicables como versión nueva — siempre con gate humano.
- 🧩 **Multinicho por diseño** — vocabulario configurable por embudo: lead se vuelve *Cliente*, *Paciente* o *Comprador*; "ganado" se vuelve *Pagado*, *Agendado* o *Cerrado*. El mismo core sirve a e-commerce (nuestra cuna, con integración Nuvemshop), clínicas, inmobiliarias o infoproductos.
- 💬 **WhatsApp de dos formas** — por **código QR** (WAHA, multinúmero, con anti-baneo: throttle + jitter + ventana horaria) o por el **canal oficial de Meta** (Cloud API, con plantillas aprobadas y sincronizadas). Medios vía Storage, detección de STOP.
- 🔀 **Elige tu IA** — OpenRouter, Anthropic u OpenAI, decidido en la instalación y cambiable después desde la pantalla, **por parte del sistema** (lo que conversa no tiene que ser lo que indexa).
- 👥 **Gobernanza de atención** — RBAC server-side de verdad, asignación/transferencia auditada, cola con rotación, enrutamiento automático por intención y alcance de visualización por rol.
- 🏢 **Multi-tenant + privacidad por diseño (LGPD)** — RLS en toda tabla tenant-aware con test de aislamiento como gate de CI; anonimización preferida sobre borrado; audit log append-only con retención de 5 años.
- 🖥️ **Self-hosted de verdad** — tus datos en tu VPS; instalación y actualización con 1 comando (o 1 clic); sin versión paga, sin funciones bloqueadas.

### 🔌 Webhooks y Automatizaciones

Cada tenant puede crear **fuentes de captación**: una dirección pública (`/api/v1/webhooks/in/<token>`) que recibe leads de landing pages, formularios propios o herramientas como Zapier/n8n vía POST (JSON o `application/x-www-form-urlencoded`) y entra directo al embudo/etapa elegida — sin código, sin integración a medida por tenant. Sobre esas fuentes (y los demás eventos del CRM — el lead cambió de etapa, ganó una etiqueta, llegó un mensaje de WhatsApp), el tenant arma **automatizaciones**: reglas CUANDO/SI/ENTONCES que agregan etiquetas, mueven el lead, lo asignan a alguien, mandan un mensaje de WhatsApp o avisan a otro sistema vía webhook de salida.

En la UI todo vive en **Webhooks** en la barra lateral (visible solo para roles `manager`/`admin`). Tres pestañas: **Recibir datos** (crear fuente, copiar la dirección/formulario listo, disparar un lead de prueba, ver las últimas recepciones), **Automatizaciones** (armar la regla, que siempre nace pausada hasta que la revises y la enciendas) y **Actividad** (línea de tiempo de cada ejecución, con el resultado de cada acción y reenvío manual cuando una llamada externa falla).

Por debajo, cada evento se vuelve una fila en `event_log` — ningún trigger de base de datos hace llamadas HTTP. Quien drena esa cola es la ruta `/api/v1/cron/event-log-drain`, llamada cada minuto. **`install.sh`/`update.sh` ya configuran ese cron solos** — sin él, las automatizaciones se crean normalmente pero nunca corren.

---

## 🖥️ Lo que operas (las pantallas)

| Grupo | Pantallas |
|---|---|
| **Atención** | **Inbox** (conversaciones de WhatsApp, tú y la IA lado a lado) · **Radar** (quién se enfrió y sigue abierto) · **Respuestas rápidas** |
| **CRM** | **Kanban** (dónde está cada negocio en el embudo) · **Contactos** · **Embudos** (etapas, vocabulario del negocio y motivos de pérdida) |
| **Agente de IA** | **Agentes** · **Follow-ups** · **Enrutadores** · **Proveedores** y **Credenciales** · **Conocimiento** (RAG) · **Memoria** · **Skills** · **Casos** · **Alertas** · **Propuestas** · **Ejecuciones** · **Uso y presupuesto** |
| **Canales** | **Conexiones** (QR o canal oficial de Meta, con salud, reconexión y plantillas) · **Nuvemshop** · **Webhooks** |
| **Análisis** | **Desempeño** (embudo y rendimiento por agente) · **Evolución de la IA** · **Audit Log** |
| **Organización** | **Equipo** · **Distribución de atención** · **Organización** · **LGPD** · **API Tokens** · **Seguridad** (MFA, códigos de recuperación, sesiones) · Perfil, Notificaciones, Billing |

Toda pantalla tiene puerta en la navegación — el CI reprueba una pantalla que existe pero a la que solo se llega escribiendo la URL.

---

## 🧱 Stack

| Capa | Elección | Por qué |
|---|---|---|
| **Frontend** | Next.js 16 App Router (Turbopack) + React 19 + TypeScript 6 estricto | Server Components + Route Handlers en el mismo repo |
| **Estilo** | Tailwind + shadcn/ui (`new-york`, neutral) | Personalizable sin lock-in |
| **DB** | Supabase (Postgres + RLS + `vector`) | Multi-tenant nativo, embeddings para RAG |
| **Auth** | Supabase Auth vía `@supabase/ssr` | Cookie SameSite=Strict, HttpOnly |
| **Realtime** | Supabase Realtime | postgres_changes + broadcast |
| **Storage** | Supabase Storage (URLs firmadas) | Bucket privado `whatsapp-media` |
| **WhatsApp** | WAHA Plus (motor NOWEB) + Meta Cloud API | QR para empezar rápido; canal oficial para escalar |
| **Colas** | Tabla `event_log` + workers (cron) | Un trigger de base nunca hace HTTP |
| **Rate limit** | Upstash Redis (sliding window) | Serverless, el free tier alcanza |
| **IA** | Vercel AI SDK v7 — OpenRouter, Requesty, Anthropic, OpenAI y Google | El instalador pregunta cuál; se cambia después desde la pantalla |
| **Validación** | Zod | Input externo, env, payloads |
| **Observabilidad** | Sentry (scrub en error, transacción, span y breadcrumb) | Telemetría opt-in en la instalación |
| **Hosting** | Cualquier VPS con Docker (HostGator/SP en la alianza) | App + WhatsApp + workers en tu propia máquina |

Detalles: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 🧑‍💻 Desarrollo (solo para contribuir al código)

> ⚠️ **Si quieres USAR el CRM, no es acá** — usa el [instalador del VPS](#-instalar-en-tu-vps-el-camino-principal).
> Esta sección es para quien va a tocar el código.

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git
cd DeskcommCRM

nvm use                     # Node 22
npm install -g pnpm && pnpm install

cp .env.example .env.local  # guía completa en docs/SETUP.md

docker compose up -d        # WAHA local (opcional en dev sin WhatsApp)

# Schema: aplica el baseline, NO las migrations.
# Las migrations 0001-0009 y 0013 son stubs `SELECT 1;` — la cadena no sube desde cero.
# El schema real vive en baseline.sql, el mismo que install.sh aplica en el VPS.
# `supabase db push` "pasa" y te deja la base vacía.
supabase link --project-ref <tu-ref>
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql

pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

[`docs/SETUP.md`](docs/SETUP.md) es el tutorial completo de **todas las integraciones** (Supabase, WAHA, proveedores de IA, Upstash, Sentry, Resend, Nuvemshop) — ~60–90 min de cero a la app corriendo. *(La documentación está en portugués de Brasil; ¡las traducciones son bienvenidas!)*

---

## 🧪 Tests

```bash
pnpm typecheck     # tsc --noEmit (estricto)
pnpm lint          # eslint next/core-web-vitals
pnpm test:unit     # Vitest (NO incluye tests/invariants/**)
pnpm test:db       # Postgres efímero + baseline install/update + invariantes
pnpm test:e2e      # Playwright (requiere dev server)
```

**Estos checks son obligatorios** para mergear en `main`. Esta lista ya dijo "cuatro" y después "cinco" — **medí, no confíes en ella**:

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection \
  --jq '.required_status_checks.contexts|join(", ")'
# el 2026-08-14: verify, build-and-size, invariants, e2e, imagens-ok
```


| Check | Qué hace |
|---|---|
| `verify` | typecheck + lint + `lint:channels` + `test:unit` + `test:shell` |
| `invariants` | levanta un Postgres limpio, aplica `baseline.sql` en modo **install** (`ON_ERROR_STOP=1`) y después en modo **update** (probando idempotencia), y corre **618 invariantes en 98 archivos** — RBAC, asignación, alcance, enrutamiento, follow-up, webhooks y automatizaciones |
| `build-and-size` | `pnpm build` en Node 22 |
| `e2e` | levanta un Supabase local, aplica `baseline.sql` y corre por el frontend todas las specs de Playwright menos las que declara `FORA_DO_CI` |

Cuáles specs quedan fuera es pregunta de comando, no de lectura — esta línea llegó a afirmar que la única era `vps-fresh-onboarding`, y desde el PR #983 ella corre en el CI:

```bash
git show origin/main:.github/workflows/e2e.yml | python3 -c "import sys,re; y=sys.stdin.read(); print(sorted({s for _,c in re.findall(r'(FORA_DO_CI):\s*>-\n((?:[ ]{8,}.*\n)+)',y) for s in re.findall(r'[a-z0-9-]+\.spec\.ts',c)}))"
```

`vps-fresh-onboarding` sigue siendo la **P0** de nuestra doctrina de QA visual, porque la instalación fresca es el producto que se vende. Tener gate no reemplaza la prueba por pantalla: el gate prueba que no hubo regresión, no que la experiencia quedó buena.

Entre los invariantes está el **test de aislamiento RLS**: crea 2 organizaciones, simula los claims JWT por el mismo camino `auth.uid()` / `fn_user_org_ids()` que usan las policies de producción, y prueba que un usuario de la org A ve **cero filas** de la org B en `conversations`, `messages`, `contacts` y `crm_leads`. Antes, un caso de control prueba que las filas de la org B realmente existen — sin él, el test pasaría con la tabla vacía.

---

## 📚 Documentación

| Doc | Qué tiene |
|---|---|
| [`hostgator-setup-kit/README.md`](hostgator-setup-kit/README.md) | **Instalación self-host** — el kit, los scripts, los hostings con proxy propio |
| [`docs/ATUALIZANDO.md`](docs/ATUALIZANDO.md) | **Cómo actualizar** tu instalación, en lenguaje simple |
| [`VISION.md`](VISION.md) | **Visión y posicionamiento** — qué es el proyecto, en qué cree y hacia dónde va |
| [`CHANGELOG.md`](CHANGELOG.md) | Qué cambió en cada versión — **lee la sección de tu versión antes de actualizar** |
| [`docs/SETUP.md`](docs/SETUP.md) | Setup de desarrollo, paso a paso, de todas las integraciones |
| [`docs/white-label.es.md`](docs/white-label.es.md) | **Instalar para clientes** — cambiar la marca, una instalación por cliente vs compartida, reventa |
| [`docs/runbooks/waha-hostgator.md`](docs/runbooks/waha-hostgator.md) | Runbook de WAHA en producción (dimensionamiento, recuperación) |
| [`CLAUDE.md`](CLAUDE.md) | Convenciones no negociables (lectura obligatoria para contribuir) |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Visión de 1 página de la arquitectura |
| [`docs/index.md`](docs/index.md) | Índice de los 157 documentos, con regla de precedencia |
| [`docs/prd/`](docs/prd/) · [`docs/specs/`](docs/specs/) | PRDs y specs técnicas (schema SQL, payloads, MCP, gobernanza) |

> La mayor parte de la documentación está en portugués de Brasil — nuestra comunidad principal. Las contribuciones de traducción son muy bienvenidas.

---

## 🤝 Contribuir

Este proyecto es open source para la comunidad. Toda contribución es bienvenida — desde arreglar un typo en la documentación hasta una función nueva.

1. Lee [`CLAUDE.md`](CLAUDE.md) (~5 min) — convenciones no negociables (multi-tenancy, RLS, audit, privacidad).
2. Lee [`CONTRIBUTING.md`](CONTRIBUTING.md) — flujo de branches, commits.
3. Sigue el [Código de Conducta](CODE_OF_CONDUCT.md).

**Flujo corto:**

```bash
git checkout -b feat/short-slug
# implementa + tests
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build
pnpm test:db   # necesita Docker — es el job `invariants`, obligatorio para mergear
git commit -m "feat(alcance): descripción"
```

Esas dos líneas son **todo lo que podés correr en tu máquina**, a propósito: correr solo la mitad y descubrir el resto como sorpresa roja después de horas de espera es la peor primera experiencia que este repositorio sabe entregar.

Dos gates obligatorios **no** entran ahí y solo corren en CI: `e2e` (necesita un Supabase local) y `imagens-ok` (construye las tres imágenes Docker). Verde en tu máquina no es verde en el merge.

**Definition of Done:** typecheck en cero, lint en cero, tests relevantes verdes, RLS testeada si toca una tabla tenant-aware, audit log emitido en mutaciones, migration versionada **+ apéndice idempotente en `baseline.sql`** si cambia el schema (si no, el cambio nunca llega a quien se auto-hospeda).

---

<a id="contributors-"></a>

## 🙌 Quienes construyen DeskcommCRM

Gracias a cada persona que ya contribuyó con código, un bug bien reportado, una idea, documentación o una traducción. Para entrar en esta lista, mira [cómo contribuir](CONTRIBUTING.md) ([leyenda de los íconos](https://allcontributors.org/docs/en/emoji-key)).

¿Quieres apoyar el proyecto de otra forma? [Patrocínalo en GitHub Sponsors](https://github.com/sponsors/melgarafael).

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/melgarafael"><img src="https://avatars.githubusercontent.com/u/119944436?v=4?s=64" width="64px;" alt="Rafael Melgaço"/><br /><sub><b>Rafael Melgaço</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=melgarafael" title="Code">💻</a> <a href="#maintenance-melgarafael" title="Maintenance">🚧</a> <a href="#ideas-melgarafael" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/webtecnica"><img src="https://avatars.githubusercontent.com/u/75556242?v=4?s=64" width="64px;" alt="webtecnica"/><br /><sub><b>webtecnica</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=webtecnica" title="Code">💻</a> <a href="https://github.com/melgarafael/DeskcommCRM/commits?author=webtecnica" title="Documentation">📖</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/paulolimajr77"><img src="https://avatars.githubusercontent.com/u/60278689?v=4?s=64" width="64px;" alt="Paulo Lima Jr"/><br /><sub><b>Paulo Lima Jr</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=paulolimajr77" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/jmpo"><img src="https://avatars.githubusercontent.com/u/23352109?v=4?s=64" width="64px;" alt="Marcelo Pompa"/><br /><sub><b>Marcelo Pompa</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=jmpo" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Tong-bit-art"><img src="https://avatars.githubusercontent.com/u/239565928?v=4?s=64" width="64px;" alt="ordinary being"/><br /><sub><b>ordinary being</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Tong-bit-art" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/JowaniOrantes"><img src="https://avatars.githubusercontent.com/u/99059532?v=4?s=64" width="64px;" alt="Jowani Orantes"/><br /><sub><b>Jowani Orantes</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=JowaniOrantes" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/joaopaulomirandamatias"><img src="https://avatars.githubusercontent.com/u/37987074?v=4?s=64" width="64px;" alt="João Paulo"/><br /><sub><b>João Paulo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=joaopaulomirandamatias" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/IanCouto"><img src="https://avatars.githubusercontent.com/u/48738352?v=4?s=64" width="64px;" alt="Ian Couto"/><br /><sub><b>Ian Couto</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=IanCouto" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rafaelbatistazz"><img src="https://avatars.githubusercontent.com/u/173963432?v=4?s=64" width="64px;" alt="rafaelbatistazz"/><br /><sub><b>rafaelbatistazz</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rafaelbatistazz" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/423313"><img src="https://avatars.githubusercontent.com/u/175169448?v=4?s=64" width="64px;" alt="423313"/><br /><sub><b>423313</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=423313" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vitorlacerdadigital"><img src="https://avatars.githubusercontent.com/u/328979566?v=4?s=64" width="64px;" alt="vitorlacerdadigital"/><br /><sub><b>vitorlacerdadigital</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vitorlacerdadigital" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/maugarciasa"><img src="https://avatars.githubusercontent.com/u/290142000?v=4?s=64" width="64px;" alt="maugarciasa"/><br /><sub><b>maugarciasa</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=maugarciasa" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ozzure"><img src="https://avatars.githubusercontent.com/u/4605101?v=4?s=64" width="64px;" alt="ozzure"/><br /><sub><b>ozzure</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ozzure" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/hiro-nikaitou"><img src="https://avatars.githubusercontent.com/u/249086173?v=4?s=64" width="64px;" alt="hiro-nikaitou"/><br /><sub><b>hiro-nikaitou</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=hiro-nikaitou" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/maclevison"><img src="https://avatars.githubusercontent.com/u/1932636?v=4?s=64" width="64px;" alt="Mac Silva"/><br /><sub><b>Mac Silva</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=maclevison" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/bossprt"><img src="https://avatars.githubusercontent.com/u/316014294?v=4?s=64" width="64px;" alt="bossprt"/><br /><sub><b>bossprt</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=bossprt" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gustavorodcruz96"><img src="https://avatars.githubusercontent.com/u/221748661?v=4?s=64" width="64px;" alt="Gustavo Rodrigues"/><br /><sub><b>Gustavo Rodrigues</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=gustavorodcruz96" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/LuckasBrito-Dev"><img src="https://avatars.githubusercontent.com/u/188809167?v=4?s=64" width="64px;" alt="Lucas Brito"/><br /><sub><b>Lucas Brito</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=LuckasBrito-Dev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/FabioMundoDigital"><img src="https://avatars.githubusercontent.com/u/136749579?v=4?s=64" width="64px;" alt="Fabio Kortex"/><br /><sub><b>Fabio Kortex</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=FabioMundoDigital" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/automatikpg-ux"><img src="https://avatars.githubusercontent.com/u/313559075?v=4?s=64" width="64px;" alt="automatikpg-ux"/><br /><sub><b>automatikpg-ux</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=automatikpg-ux" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/nsbastosconsultoria"><img src="https://avatars.githubusercontent.com/u/221592931?v=4?s=64" width="64px;" alt="Leandro Nogueira de Souza Bastos"/><br /><sub><b>Leandro Nogueira de Souza Bastos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=nsbastosconsultoria" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vgamkt"><img src="https://avatars.githubusercontent.com/u/62725454?v=4?s=64" width="64px;" alt="VANDER GUSTAVO ALVES"/><br /><sub><b>VANDER GUSTAVO ALVES</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vgamkt" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rafaelcesardev"><img src="https://avatars.githubusercontent.com/u/108206396?v=4?s=64" width="64px;" alt="Rafael César"/><br /><sub><b>Rafael César</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rafaelcesardev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/SnoopyHuman"><img src="https://avatars.githubusercontent.com/u/175789268?v=4?s=64" width="64px;" alt="SnoopyHuman"/><br /><sub><b>SnoopyHuman</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=SnoopyHuman" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/saraivabr"><img src="https://avatars.githubusercontent.com/u/243859142?v=4?s=64" width="64px;" alt="Saraiva"/><br /><sub><b>Saraiva</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=saraivabr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/valterhjr"><img src="https://avatars.githubusercontent.com/u/10075011?v=4?s=64" width="64px;" alt="Valter"/><br /><sub><b>Valter</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=valterhjr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/omayklourenco"><img src="https://avatars.githubusercontent.com/u/75747871?v=4?s=64" width="64px;" alt="Mayk Lourenço"/><br /><sub><b>Mayk Lourenço</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=omayklourenco" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Draven9"><img src="https://avatars.githubusercontent.com/u/99404696?v=4?s=64" width="64px;" alt="Eric Azevedo"/><br /><sub><b>Eric Azevedo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Draven9" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Gervanno"><img src="https://avatars.githubusercontent.com/u/189672957?v=4?s=64" width="64px;" alt="Gervànno"/><br /><sub><b>Gervànno</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Gervanno" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/felipebnt"><img src="https://avatars.githubusercontent.com/u/56138438?v=4?s=64" width="64px;" alt="Felipe Oliveira"/><br /><sub><b>Felipe Oliveira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=felipebnt" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/flaviosiq"><img src="https://avatars.githubusercontent.com/u/24714170?v=4?s=64" width="64px;" alt="flaviosiq"/><br /><sub><b>flaviosiq</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=flaviosiq" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/brunowatz"><img src="https://avatars.githubusercontent.com/u/156392074?v=4?s=64" width="64px;" alt="Bruno Jakowatz "/><br /><sub><b>Bruno Jakowatz </b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=brunowatz" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/fillipe-felix"><img src="https://avatars.githubusercontent.com/u/39422542?v=4?s=64" width="64px;" alt="fillipe-felix"/><br /><sub><b>fillipe-felix</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=fillipe-felix" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/claude"><img src="https://avatars.githubusercontent.com/u/81847?v=4?s=64" width="64px;" alt="Claude"/><br /><sub><b>Claude</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=claude" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/sprakashsurya-debug"><img src="https://avatars.githubusercontent.com/u/319809785?v=4?s=64" width="64px;" alt="sprakashsurya-debug"/><br /><sub><b>sprakashsurya-debug</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=sprakashsurya-debug" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/luka1601"><img src="https://avatars.githubusercontent.com/u/134978198?v=4?s=64" width="64px;" alt="luka1601"/><br /><sub><b>luka1601</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=luka1601" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/samirhvbr"><img src="https://avatars.githubusercontent.com/u/123646616?v=4?s=64" width="64px;" alt="Samir Hanna Verza"/><br /><sub><b>Samir Hanna Verza</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=samirhvbr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/advglauberpires"><img src="https://avatars.githubusercontent.com/u/329235513?v=4?s=64" width="64px;" alt="advglauberpires"/><br /><sub><b>advglauberpires</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=advglauberpires" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Tanderakkkj"><img src="https://avatars.githubusercontent.com/u/86134641?v=4?s=64" width="64px;" alt="Tanderakkkj"/><br /><sub><b>Tanderakkkj</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Tanderakkkj" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vagnerrm122"><img src="https://avatars.githubusercontent.com/u/142553039?v=4?s=64" width="64px;" alt="vagnerrm122"/><br /><sub><b>vagnerrm122</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vagnerrm122" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/betoarts"><img src="https://avatars.githubusercontent.com/u/43428188?v=4?s=64" width="64px;" alt="Humberto Moura Neto DEV"/><br /><sub><b>Humberto Moura Neto DEV</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=betoarts" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/italopabloferreria"><img src="https://avatars.githubusercontent.com/u/163482370?v=4?s=64" width="64px;" alt="Ítalo Pablo Ferreira"/><br /><sub><b>Ítalo Pablo Ferreira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=italopabloferreria" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Wyllams"><img src="https://avatars.githubusercontent.com/u/98239020?v=4?s=64" width="64px;" alt="Wyllams Bione"/><br /><sub><b>Wyllams Bione</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Wyllams" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/opp4s"><img src="https://avatars.githubusercontent.com/u/85846969?v=4?s=64" width="64px;" alt="opp4s"/><br /><sub><b>opp4s</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=opp4s" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/nusretbayindir-stack"><img src="https://avatars.githubusercontent.com/u/243019259?v=4?s=64" width="64px;" alt="nusretbayindir-stack"/><br /><sub><b>nusretbayindir-stack</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=nusretbayindir-stack" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/thiagobaltuilhe"><img src="https://avatars.githubusercontent.com/u/255193626?v=4?s=64" width="64px;" alt="thiagobaltuilhe"/><br /><sub><b>thiagobaltuilhe</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=thiagobaltuilhe" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/fabianmartinelli-fm"><img src="https://avatars.githubusercontent.com/u/214162846?v=4?s=64" width="64px;" alt="Fabian Martinelli"/><br /><sub><b>Fabian Martinelli</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=fabianmartinelli-fm" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Elevstudio-Dev"><img src="https://avatars.githubusercontent.com/u/276807577?v=4?s=64" width="64px;" alt="Elevstudio-Dev"/><br /><sub><b>Elevstudio-Dev</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Elevstudio-Dev" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/felipedelvan"><img src="https://avatars.githubusercontent.com/u/24362133?v=4?s=64" width="64px;" alt="felipedelvan"/><br /><sub><b>felipedelvan</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=felipedelvan" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/in100tiva"><img src="https://avatars.githubusercontent.com/u/160179103?v=4?s=64" width="64px;" alt="Luan Oliveira Dos Santos"/><br /><sub><b>Luan Oliveira Dos Santos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=in100tiva" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/mauriciobera1990-droid"><img src="https://avatars.githubusercontent.com/u/318639880?v=4?s=64" width="64px;" alt="mauriciobera1990-droid"/><br /><sub><b>mauriciobera1990-droid</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=mauriciobera1990-droid" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/SerusoNakamoto"><img src="https://avatars.githubusercontent.com/u/347560292?v=4?s=64" width="64px;" alt="SerusoNakamoto"/><br /><sub><b>SerusoNakamoto</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=SerusoNakamoto" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/jostoz"><img src="https://avatars.githubusercontent.com/u/150358190?v=4?s=64" width="64px;" alt="josuetoz"/><br /><sub><b>josuetoz</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=jostoz" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Drmachado0"><img src="https://avatars.githubusercontent.com/u/129681341?v=4?s=64" width="64px;" alt="Drmachado0"/><br /><sub><b>Drmachado0</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Drmachado0" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rogercampel"><img src="https://avatars.githubusercontent.com/u/281720644?v=4?s=64" width="64px;" alt="Roger Campel"/><br /><sub><b>Roger Campel</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rogercampel" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/raphaelmartins"><img src="https://avatars.githubusercontent.com/u/100216897?v=4?s=64" width="64px;" alt="Raphael Martins"/><br /><sub><b>Raphael Martins</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=raphaelmartins" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/matheuspedro360"><img src="https://avatars.githubusercontent.com/u/247238489?v=4?s=64" width="64px;" alt="matheuspedro360"/><br /><sub><b>matheuspedro360</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=matheuspedro360" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lzandonadi"><img src="https://avatars.githubusercontent.com/u/132299432?v=4?s=64" width="64px;" alt="Lucas Falqueto Zandonadi"/><br /><sub><b>Lucas Falqueto Zandonadi</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lzandonadi" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/LeonardoMarcelo"><img src="https://avatars.githubusercontent.com/u/94540229?v=4?s=64" width="64px;" alt="leonardo marcelo santana da paz"/><br /><sub><b>leonardo marcelo santana da paz</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=LeonardoMarcelo" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/cabindaferreira"><img src="https://avatars.githubusercontent.com/u/64534090?v=4?s=64" width="64px;" alt="João Ferreira"/><br /><sub><b>João Ferreira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=cabindaferreira" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/claudioghirellifh"><img src="https://avatars.githubusercontent.com/u/42969756?v=4?s=64" width="64px;" alt="Claudio Ghirelli Filho"/><br /><sub><b>Claudio Ghirelli Filho</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=claudioghirellifh" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/xxfabioxx12"><img src="https://avatars.githubusercontent.com/u/215034747?v=4?s=64" width="64px;" alt="xxfabioxx12"/><br /><sub><b>xxfabioxx12</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=xxfabioxx12" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rafaeskytrabalho"><img src="https://avatars.githubusercontent.com/u/273271440?v=4?s=64" width="64px;" alt="Renan Rafaesky"/><br /><sub><b>Renan Rafaesky</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rafaeskytrabalho" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/andersontomazi-ctrl"><img src="https://avatars.githubusercontent.com/u/308762107?v=4?s=64" width="64px;" alt="andersontomazi-ctrl"/><br /><sub><b>andersontomazi-ctrl</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=andersontomazi-ctrl" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/agencyspeedagend-del"><img src="https://avatars.githubusercontent.com/u/246169724?v=4?s=64" width="64px;" alt="agencyspeedagend-del"/><br /><sub><b>agencyspeedagend-del</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=agencyspeedagend-del" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vanksestevao"><img src="https://avatars.githubusercontent.com/u/14091195?v=4?s=64" width="64px;" alt="vanksestevao"/><br /><sub><b>vanksestevao</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vanksestevao" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/xxjjjj"><img src="https://avatars.githubusercontent.com/u/49385833?v=4?s=64" width="64px;" alt="URNOTKRYSTALXU"/><br /><sub><b>URNOTKRYSTALXU</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=xxjjjj" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/kocaemre"><img src="https://avatars.githubusercontent.com/u/110906681?v=4?s=64" width="64px;" alt="Emre K."/><br /><sub><b>Emre K.</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=kocaemre" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/arthurbarreto07"><img src="https://avatars.githubusercontent.com/u/273399227?v=4?s=64" width="64px;" alt="arthurbarreto07"/><br /><sub><b>arthurbarreto07</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=arthurbarreto07" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/dilneiss"><img src="https://avatars.githubusercontent.com/u/4564667?v=4?s=64" width="64px;" alt="Dilnei"/><br /><sub><b>Dilnei</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=dilneiss" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/resdasilva"><img src="https://avatars.githubusercontent.com/u/210542727?v=4?s=64" width="64px;" alt="resdasilva"/><br /><sub><b>resdasilva</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=resdasilva" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/hampikamayuq"><img src="https://avatars.githubusercontent.com/u/179255165?v=4?s=64" width="64px;" alt="Diego Galvez"/><br /><sub><b>Diego Galvez</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=hampikamayuq" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/andradevander"><img src="https://avatars.githubusercontent.com/u/4044621?v=4?s=64" width="64px;" alt="Vanderson Andrade"/><br /><sub><b>Vanderson Andrade</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=andradevander" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Thibaultjaigu"><img src="https://avatars.githubusercontent.com/u/84420566?v=4?s=64" width="64px;" alt="Thibault Jaigu"/><br /><sub><b>Thibault Jaigu</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Thibaultjaigu" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rodrigotxt"><img src="https://avatars.githubusercontent.com/u/7013329?v=4?s=64" width="64px;" alt="Rodrigo Martins"/><br /><sub><b>Rodrigo Martins</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rodrigotxt" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/GGBueno"><img src="https://avatars.githubusercontent.com/u/152066770?v=4?s=64" width="64px;" alt="Giovane Bueno"/><br /><sub><b>Giovane Bueno</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=GGBueno" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/erikyudi"><img src="https://avatars.githubusercontent.com/u/55798120?v=4?s=64" width="64px;" alt="erikyudi"/><br /><sub><b>erikyudi</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=erikyudi" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/eudanielhenrique"><img src="https://avatars.githubusercontent.com/u/24281146?v=4?s=64" width="64px;" alt="Daniel Henrique"/><br /><sub><b>Daniel Henrique</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=eudanielhenrique" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Clalber"><img src="https://avatars.githubusercontent.com/u/54963815?v=4?s=64" width="64px;" alt="Clalber Pereira"/><br /><sub><b>Clalber Pereira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Clalber" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/AllisonFABRASoftware"><img src="https://avatars.githubusercontent.com/u/143289500?v=4?s=64" width="64px;" alt="Allison FABRA Software"/><br /><sub><b>Allison FABRA Software</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=AllisonFABRASoftware" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/allisonwilliancandido"><img src="https://avatars.githubusercontent.com/u/77209255?v=4?s=64" width="64px;" alt="Allison Willian"/><br /><sub><b>Allison Willian</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=allisonwilliancandido" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Alencaf"><img src="https://avatars.githubusercontent.com/u/95728740?v=4?s=64" width="64px;" alt="Alencaf"/><br /><sub><b>Alencaf</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Alencaf" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Sandersono"><img src="https://avatars.githubusercontent.com/u/42549260?v=4?s=64" width="64px;" alt="Sanderson Palmeira de Oliveira"/><br /><sub><b>Sanderson Palmeira de Oliveira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Sandersono" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/victor-will"><img src="https://avatars.githubusercontent.com/u/217840268?v=4?s=64" width="64px;" alt="victor-will"/><br /><sub><b>victor-will</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=victor-will" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/salomaobatistamkt"><img src="https://avatars.githubusercontent.com/u/265253308?v=4?s=64" width="64px;" alt="salomaobatistamkt"/><br /><sub><b>salomaobatistamkt</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=salomaobatistamkt" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gaberaldo-svg"><img src="https://avatars.githubusercontent.com/u/300506992?v=4?s=64" width="64px;" alt="gaberaldo-svg"/><br /><sub><b>gaberaldo-svg</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=gaberaldo-svg" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vinicoretecnologia-svg"><img src="https://avatars.githubusercontent.com/u/297014955?v=4?s=64" width="64px;" alt="vinicoretecnologia-svg"/><br /><sub><b>vinicoretecnologia-svg</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vinicoretecnologia-svg" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/RafaelBarbosaBR"><img src="https://avatars.githubusercontent.com/u/295654727?v=4?s=64" width="64px;" alt="RafaelBarbosaBR"/><br /><sub><b>RafaelBarbosaBR</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=RafaelBarbosaBR" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/pedroscharrff"><img src="https://avatars.githubusercontent.com/u/8728421?v=4?s=64" width="64px;" alt="pedroscharrff"/><br /><sub><b>pedroscharrff</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=pedroscharrff" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/LuigiMDev"><img src="https://avatars.githubusercontent.com/u/161367522?v=4?s=64" width="64px;" alt="Luigi Matheus"/><br /><sub><b>Luigi Matheus</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=LuigiMDev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/tatarevick"><img src="https://avatars.githubusercontent.com/u/5930817?v=4?s=64" width="64px;" alt="tatarevick"/><br /><sub><b>tatarevick</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=tatarevick" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/anarkaike"><img src="https://avatars.githubusercontent.com/u/583356?v=4?s=64" width="64px;" alt="Junio de Almeida Vitorino"/><br /><sub><b>Junio de Almeida Vitorino</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=anarkaike" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/JonathasmpDEV"><img src="https://avatars.githubusercontent.com/u/99084233?v=4?s=64" width="64px;" alt="Jonathas Micael de Paulo"/><br /><sub><b>Jonathas Micael de Paulo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=JonathasmpDEV" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Frank-zhu2000"><img src="https://avatars.githubusercontent.com/u/332350688?v=4?s=64" width="64px;" alt="jack"/><br /><sub><b>jack</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Frank-zhu2000" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/CristianoFF43"><img src="https://avatars.githubusercontent.com/u/111487334?v=4?s=64" width="64px;" alt="CristianoFF43"/><br /><sub><b>CristianoFF43</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=CristianoFF43" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/obrunogonzaga"><img src="https://avatars.githubusercontent.com/u/6759972?v=4?s=64" width="64px;" alt="Bruno Gonzaga Santos"/><br /><sub><b>Bruno Gonzaga Santos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=obrunogonzaga" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/brastramidia"><img src="https://avatars.githubusercontent.com/u/308168479?v=4?s=64" width="64px;" alt="José Oliveira"/><br /><sub><b>José Oliveira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=brastramidia" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/AlecsanderAbreu"><img src="https://avatars.githubusercontent.com/u/14840357?v=4?s=64" width="64px;" alt="Alecsander Abreu"/><br /><sub><b>Alecsander Abreu</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=AlecsanderAbreu" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/careis-junior"><img src="https://avatars.githubusercontent.com/u/38914210?v=4?s=64" width="64px;" alt="careis-junior"/><br /><sub><b>careis-junior</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=careis-junior" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/dajiaohuang"><img src="https://avatars.githubusercontent.com/u/108231307?v=4?s=64" width="64px;" alt="Wu Shuwen"/><br /><sub><b>Wu Shuwen</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=dajiaohuang" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lauropilatti-c01"><img src="https://avatars.githubusercontent.com/u/239239929?v=4?s=64" width="64px;" alt="lauropilatti-c01"/><br /><sub><b>lauropilatti-c01</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lauropilatti-c01" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/AngelaHelloKittyBaby"><img src="https://avatars.githubusercontent.com/u/220612323?v=4?s=64" width="64px;" alt="AngelaHelloKittyBaby"/><br /><sub><b>AngelaHelloKittyBaby</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=AngelaHelloKittyBaby" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/mbiero"><img src="https://avatars.githubusercontent.com/u/34111676?v=4?s=64" width="64px;" alt="mbiero"/><br /><sub><b>mbiero</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=mbiero" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/peterkeussen"><img src="https://avatars.githubusercontent.com/u/54675621?v=4?s=64" width="64px;" alt="Peter Keussen de Souza"/><br /><sub><b>Peter Keussen de Souza</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=peterkeussen" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/profpeque"><img src="https://avatars.githubusercontent.com/u/248962333?v=4?s=64" width="64px;" alt="profpeque"/><br /><sub><b>profpeque</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=profpeque" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/scavio-ai"><img src="https://avatars.githubusercontent.com/u/264839281?v=4?s=64" width="64px;" alt="Scavio AI"/><br /><sub><b>Scavio AI</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=scavio-ai" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/wellpelomundo"><img src="https://avatars.githubusercontent.com/u/88757007?v=4?s=64" width="64px;" alt="Wellington Ribeiro"/><br /><sub><b>Wellington Ribeiro</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=wellpelomundo" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ygorebos"><img src="https://avatars.githubusercontent.com/u/178900847?v=4?s=64" width="64px;" alt="Ygor E O Silva"/><br /><sub><b>Ygor E O Silva</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ygorebos" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/DissonADSon"><img src="https://avatars.githubusercontent.com/u/254525408?v=4?s=64" width="64px;" alt="Anderson Simão"/><br /><sub><b>Anderson Simão</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=DissonADSon" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/carloshmlima"><img src="https://avatars.githubusercontent.com/u/144650334?v=4?s=64" width="64px;" alt="Carlos Lima"/><br /><sub><b>Carlos Lima</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=carloshmlima" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lucasa15"><img src="https://avatars.githubusercontent.com/u/129917152?v=4?s=64" width="64px;" alt="lucasa15"/><br /><sub><b>lucasa15</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lucasa15" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ajsaranetaeu"><img src="https://avatars.githubusercontent.com/u/265983391?v=4?s=64" width="64px;" alt="ajsaranetaeu"/><br /><sub><b>ajsaranetaeu</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ajsaranetaeu" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/SrPascoa"><img src="https://avatars.githubusercontent.com/u/64105691?v=4?s=64" width="64px;" alt="Fábio Páscoa"/><br /><sub><b>Fábio Páscoa</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=SrPascoa" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/felpzGondim"><img src="https://avatars.githubusercontent.com/u/149640165?v=4?s=64" width="64px;" alt="felpzGondim"/><br /><sub><b>felpzGondim</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=felpzGondim" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/HigorLira"><img src="https://avatars.githubusercontent.com/u/241835983?v=4?s=64" width="64px;" alt="HigorLira"/><br /><sub><b>HigorLira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=HigorLira" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/joaoalexsandroed"><img src="https://avatars.githubusercontent.com/u/290192057?v=4?s=64" width="64px;" alt="joaoalexsandroed"/><br /><sub><b>joaoalexsandroed</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=joaoalexsandroed" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lucasprestes1"><img src="https://avatars.githubusercontent.com/u/315875467?v=4?s=64" width="64px;" alt="lucasprestes1"/><br /><sub><b>lucasprestes1</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lucasprestes1" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/matheussouzasantos"><img src="https://avatars.githubusercontent.com/u/118771606?v=4?s=64" width="64px;" alt="Matheus Santos"/><br /><sub><b>Matheus Santos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=matheussouzasantos" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/RenanzitoIA"><img src="https://avatars.githubusercontent.com/u/210782324?v=4?s=64" width="64px;" alt="Renan Alves"/><br /><sub><b>Renan Alves</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=RenanzitoIA" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rominparekh"><img src="https://avatars.githubusercontent.com/u/3831468?v=4?s=64" width="64px;" alt="Romin Parekh"/><br /><sub><b>Romin Parekh</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rominparekh" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/xxgamesxx14"><img src="https://avatars.githubusercontent.com/u/38382596?v=4?s=64" width="64px;" alt="xxgamesxx14"/><br /><sub><b>xxgamesxx14</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=xxgamesxx14" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/chiliec"><img src="https://avatars.githubusercontent.com/u/982358?v=4?s=64" width="64px;" alt="Vladimir Babin"/><br /><sub><b>Vladimir Babin</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=chiliec" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Aleshan-dev"><img src="https://avatars.githubusercontent.com/u/274909599?v=4?s=64" width="64px;" alt="Aleshan-dev"/><br /><sub><b>Aleshan-dev</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Aleshan-dev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/faxamkt"><img src="https://avatars.githubusercontent.com/u/271869890?v=4?s=64" width="64px;" alt="faxa marketing"/><br /><sub><b>faxa marketing</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=faxamkt" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/mentitaa"><img src="https://avatars.githubusercontent.com/u/218529152?v=4?s=64" width="64px;" alt="Mentita"/><br /><sub><b>Mentita</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=mentitaa" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/luiscgc91"><img src="https://avatars.githubusercontent.com/u/167824274?v=4?s=64" width="64px;" alt="luiscgc91"/><br /><sub><b>luiscgc91</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=luiscgc91" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lucivan212"><img src="https://avatars.githubusercontent.com/u/126484896?v=4?s=64" width="64px;" alt="lucivan212"/><br /><sub><b>lucivan212</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lucivan212" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/leadframeassessoria-lab"><img src="https://avatars.githubusercontent.com/u/246556712?v=4?s=64" width="64px;" alt="leadframeassessoria-lab"/><br /><sub><b>leadframeassessoria-lab</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=leadframeassessoria-lab" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gabigurgeldev"><img src="https://avatars.githubusercontent.com/u/217263330?v=4?s=64" width="64px;" alt="GABRIEL MORAIS GURGEL"/><br /><sub><b>GABRIEL MORAIS GURGEL</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=gabigurgeldev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/actions-user"><img src="https://avatars.githubusercontent.com/u/65916846?v=4?s=64" width="64px;" alt="actions-user"/><br /><sub><b>actions-user</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=actions-user" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/fillipeagra-cyber"><img src="https://avatars.githubusercontent.com/u/334704227?v=4?s=64" width="64px;" alt="fillipeagra-cyber"/><br /><sub><b>fillipeagra-cyber</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=fillipeagra-cyber" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/carlospaivabr"><img src="https://avatars.githubusercontent.com/u/225022566?v=4?s=64" width="64px;" alt="Carlos Paiva"/><br /><sub><b>Carlos Paiva</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=carlospaivabr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/caiofacchinato"><img src="https://avatars.githubusercontent.com/u/22156666?v=4?s=64" width="64px;" alt="caiofacchinato"/><br /><sub><b>caiofacchinato</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=caiofacchinato" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/alexneverland"><img src="https://avatars.githubusercontent.com/u/219037244?v=4?s=64" width="64px;" alt="Lazaros Avramidis"/><br /><sub><b>Lazaros Avramidis</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=alexneverland" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/scademir"><img src="https://avatars.githubusercontent.com/u/17762455?v=4?s=64" width="64px;" alt="Ademir Santos"/><br /><sub><b>Ademir Santos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=scademir" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/patronotech"><img src="https://avatars.githubusercontent.com/u/107273923?v=4?s=64" width="64px;" alt="patronotech"/><br /><sub><b>patronotech</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=patronotech" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rabbitkleber"><img src="https://avatars.githubusercontent.com/u/201826597?v=4?s=64" width="64px;" alt="rabbitkleber"/><br /><sub><b>rabbitkleber</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rabbitkleber" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rafaelbatistak"><img src="https://avatars.githubusercontent.com/u/333355664?v=4?s=64" width="64px;" alt="rafaelbatistak"/><br /><sub><b>rafaelbatistak</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rafaelbatistak" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ragaspaleilao"><img src="https://avatars.githubusercontent.com/u/237982352?v=4?s=64" width="64px;" alt="ragaspaleilao"/><br /><sub><b>ragaspaleilao</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ragaspaleilao" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/realLoganLuo"><img src="https://avatars.githubusercontent.com/u/157785179?v=4?s=64" width="64px;" alt="Logan-Luo"/><br /><sub><b>Logan-Luo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=realLoganLuo" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/renatofortal"><img src="https://avatars.githubusercontent.com/u/253097215?v=4?s=64" width="64px;" alt="renatofortal"/><br /><sub><b>renatofortal</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=renatofortal" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rgisjr"><img src="https://avatars.githubusercontent.com/u/192881385?v=4?s=64" width="64px;" alt="rgisjr"/><br /><sub><b>rgisjr</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rgisjr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/stivanellidrop-dotcom"><img src="https://avatars.githubusercontent.com/u/252956995?v=4?s=64" width="64px;" alt="stivanellidrop-dotcom"/><br /><sub><b>stivanellidrop-dotcom</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=stivanellidrop-dotcom" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/tratham-oficial"><img src="https://avatars.githubusercontent.com/u/194640682?v=4?s=64" width="64px;" alt="tratham-oficial"/><br /><sub><b>tratham-oficial</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=tratham-oficial" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vitor-licassali"><img src="https://avatars.githubusercontent.com/u/279541725?v=4?s=64" width="64px;" alt="vitor-licassali"/><br /><sub><b>vitor-licassali</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vitor-licassali" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/w4rlockem"><img src="https://avatars.githubusercontent.com/u/306561836?v=4?s=64" width="64px;" alt="w4rlockem"/><br /><sub><b>w4rlockem</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=w4rlockem" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/xofrd"><img src="https://avatars.githubusercontent.com/u/132912940?v=4?s=64" width="64px;" alt="William"/><br /><sub><b>William</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=xofrd" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Agenciatektus"><img src="https://avatars.githubusercontent.com/u/176332039?v=4?s=64" width="64px;" alt="Agência Tektus"/><br /><sub><b>Agência Tektus</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Agenciatektus" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/codex"><img src="https://avatars.githubusercontent.com/u/267193182?v=4?s=64" width="64px;" alt="Codex"/><br /><sub><b>Codex</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=codex" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/EduFkn"><img src="https://avatars.githubusercontent.com/u/203916739?v=4?s=64" width="64px;" alt="Eduardo Almeida"/><br /><sub><b>Eduardo Almeida</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=EduFkn" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/edaben"><img src="https://avatars.githubusercontent.com/u/36493350?v=4?s=64" width="64px;" alt="edaben"/><br /><sub><b>edaben</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=edaben" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/thinhnx128"><img src="https://avatars.githubusercontent.com/u/300279120?v=4?s=64" width="64px;" alt="Gau·Beo"/><br /><sub><b>Gau·Beo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=thinhnx128" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gyanu2507"><img src="https://avatars.githubusercontent.com/u/81113356?v=4?s=64" width="64px;" alt="Gyanu Mayank"/><br /><sub><b>Gyanu Mayank</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=gyanu2507" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/hamiltonviana"><img src="https://avatars.githubusercontent.com/u/10765079?v=4?s=64" width="64px;" alt="hamiltonviana"/><br /><sub><b>hamiltonviana</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=hamiltonviana" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Hefesto25"><img src="https://avatars.githubusercontent.com/u/259682362?v=4?s=64" width="64px;" alt="Hefesto25"/><br /><sub><b>Hefesto25</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Hefesto25" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/holive"><img src="https://avatars.githubusercontent.com/u/6090596?v=4?s=64" width="64px;" alt="holive"/><br /><sub><b>holive</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=holive" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/oianmaxdev"><img src="https://avatars.githubusercontent.com/u/273223021?v=4?s=64" width="64px;" alt="oianmaxdev"/><br /><sub><b>oianmaxdev</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=oianmaxdev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/KauaAmaral"><img src="https://avatars.githubusercontent.com/u/105084991?v=4?s=64" width="64px;" alt="Kauã Amaral"/><br /><sub><b>Kauã Amaral</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=KauaAmaral" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/kristhianlumai-lgtm"><img src="https://avatars.githubusercontent.com/u/240210983?v=4?s=64" width="64px;" alt="kristhianlumai-lgtm"/><br /><sub><b>kristhianlumai-lgtm</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=kristhianlumai-lgtm" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/devmonisat"><img src="https://avatars.githubusercontent.com/u/114448312?v=4?s=64" width="64px;" alt="Monisat"/><br /><sub><b>Monisat</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=devmonisat" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lcsilvestrini"><img src="https://avatars.githubusercontent.com/u/47918106?v=4?s=64" width="64px;" alt="Luiz Carlos Silvestrini"/><br /><sub><b>Luiz Carlos Silvestrini</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lcsilvestrini" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lmarceloc"><img src="https://avatars.githubusercontent.com/u/10298381?v=4?s=64" width="64px;" alt="Marcelo"/><br /><sub><b>Marcelo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lmarceloc" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/marcelovolei15"><img src="https://avatars.githubusercontent.com/u/273241567?v=4?s=64" width="64px;" alt="marcelovolei15"/><br /><sub><b>marcelovolei15</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=marcelovolei15" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/murilloimparavel"><img src="https://avatars.githubusercontent.com/u/114107747?v=4?s=64" width="64px;" alt="Murillo Alves"/><br /><sub><b>Murillo Alves</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=murilloimparavel" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/pljrcombr"><img src="https://avatars.githubusercontent.com/u/246193933?v=4?s=64" width="64px;" alt="pljrcombr"/><br /><sub><b>pljrcombr</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=pljrcombr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Teowfb"><img src="https://avatars.githubusercontent.com/u/197986058?v=4?s=64" width="64px;" alt="Teowfb"/><br /><sub><b>Teowfb</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Teowfb" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/terceiroregiss"><img src="https://avatars.githubusercontent.com/u/244394977?v=4?s=64" width="64px;" alt="Terceiro Régis"/><br /><sub><b>Terceiro Régis</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=terceiroregiss" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/PiahDoNeumann"><img src="https://avatars.githubusercontent.com/u/56264244?v=4?s=64" width="64px;" alt="Valdecir Neumann"/><br /><sub><b>Valdecir Neumann</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=PiahDoNeumann" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ViktorHugodev"><img src="https://avatars.githubusercontent.com/u/85125378?v=4?s=64" width="64px;" alt="Victor H Correa"/><br /><sub><b>Victor H Correa</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ViktorHugodev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ygorl"><img src="https://avatars.githubusercontent.com/u/105249488?v=4?s=64" width="64px;" alt="ygorl"/><br /><sub><b>ygorl</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ygorl" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/bfs2021"><img src="https://avatars.githubusercontent.com/u/101915083?v=4?s=64" width="64px;" alt="zgy"/><br /><sub><b>zgy</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=bfs2021" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ricagui"><img src="https://avatars.githubusercontent.com/u/63175361?v=4?s=64" width="64px;" alt="Ricardo Mendes"/><br /><sub><b>Ricardo Mendes</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ricagui" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ZvisionAutomations"><img src="https://avatars.githubusercontent.com/u/263388721?v=4?s=64" width="64px;" alt="ZvisionAutomations"/><br /><sub><b>ZvisionAutomations</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ZvisionAutomations" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/jhometal"><img src="https://avatars.githubusercontent.com/u/86752996?v=4?s=64" width="64px;" alt="jhometal"/><br /><sub><b>jhometal</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Ajhometal" title="Bug reports">🐛</a> <a href="#ideas-jhometal" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/juniorpagedown"><img src="https://avatars.githubusercontent.com/u/81428565?v=4?s=64" width="64px;" alt="juniorpagedown"/><br /><sub><b>juniorpagedown</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Ajuniorpagedown" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/nemyasalmeida"><img src="https://avatars.githubusercontent.com/u/298016233?v=4?s=64" width="64px;" alt="nemyasalmeida"/><br /><sub><b>nemyasalmeida</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Anemyasalmeida" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/hudson-souza-mkt"><img src="https://avatars.githubusercontent.com/u/173297369?v=4?s=64" width="64px;" alt="hudson-souza-mkt"/><br /><sub><b>hudson-souza-mkt</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=hudson-souza-mkt" title="Code">💻</a> <a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Ahudson-souza-mkt" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/NeroSued"><img src="https://avatars.githubusercontent.com/u/250192521?v=4?s=64" width="64px;" alt="Nero Sued"/><br /><sub><b>Nero Sued</b></sub></a><br /><a href="#ideas-NeroSued" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/aerosuiteapp"><img src="https://avatars.githubusercontent.com/u/284125218?v=4?s=64" width="64px;" alt="Danilo Costa"/><br /><sub><b>Danilo Costa</b></sub></a><br /><a href="#ideas-aerosuiteapp" title="Ideas, Planning, & Feedback">🤔</a> <a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Aaerosuiteapp" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/frankjohann"><img src="https://avatars.githubusercontent.com/u/184155572?v=4?s=64" width="64px;" alt="Frank Johann"/><br /><sub><b>Frank Johann</b></sub></a><br /><a href="#ideas-frankjohann" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/tec7alex"><img src="https://avatars.githubusercontent.com/u/101949364?v=4?s=64" width="64px;" alt="tec7alex"/><br /><sub><b>tec7alex</b></sub></a><br /><a href="#ideas-tec7alex" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/shu-chen-dot-ca"><img src="https://avatars.githubusercontent.com/u/338845574?v=4?s=64" width="64px;" alt="Shu Chen"/><br /><sub><b>Shu Chen</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=shu-chen-dot-ca" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/renatomprado"><img src="https://avatars.githubusercontent.com/u/216311270?v=4?s=64" width="64px;" alt="Renato Prado"/><br /><sub><b>Renato Prado</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=renatomprado" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Villa-Nova-Cont"><img src="https://avatars.githubusercontent.com/u/216889679?v=4?s=64" width="64px;" alt="Villa-Nova-Cont"/><br /><sub><b>Villa-Nova-Cont</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Villa-Nova-Cont" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://seax.com.br/"><img src="https://avatars.githubusercontent.com/u/344303443?v=4?s=64" width="64px;" alt="Seax"/><br /><sub><b>Seax</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=seax-trophy" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/routeti"><img src="https://avatars.githubusercontent.com/u/150551659?v=4?s=64" width="64px;" alt="routeti"/><br /><sub><b>routeti</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=routeti" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://codenome.com/"><img src="https://avatars.githubusercontent.com/u/7620822?v=4?s=64" width="64px;" alt="Ricardo Souza"/><br /><sub><b>Ricardo Souza</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Riicksouzaa" title="Code">💻</a> <a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3ARiicksouzaa" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rglucchini-ai"><img src="https://avatars.githubusercontent.com/u/294623315?v=4?s=64" width="64px;" alt="rglucchini-ai"/><br /><sub><b>rglucchini-ai</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rglucchini-ai" title="Code">💻</a> <a href="#ideas-rglucchini-ai" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://asishkumar.com/"><img src="https://avatars.githubusercontent.com/u/87874775?v=4?s=64" width="64px;" alt="Asish Kumar"/><br /><sub><b>Asish Kumar</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=officialasishkumar" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/mindflowai1"><img src="https://avatars.githubusercontent.com/u/212163253?v=4?s=64" width="64px;" alt="mindflowai1"/><br /><sub><b>mindflowai1</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=mindflowai1" title="Code">💻</a> <a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Amindflowai1" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/jay23606"><img src="https://avatars.githubusercontent.com/u/4602056?v=4?s=64" width="64px;" alt="Jay"/><br /><sub><b>Jay</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=jay23606" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://hanbintan.com/"><img src="https://avatars.githubusercontent.com/u/48960067?v=4?s=64" width="64px;" alt="Hanbin Tan"/><br /><sub><b>Hanbin Tan</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=hskl18" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/felipehenriquess"><img src="https://avatars.githubusercontent.com/u/141957140?v=4?s=64" width="64px;" alt="Felipe Henrique"/><br /><sub><b>Felipe Henrique</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=felipehenriquess" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/betoloko1970"><img src="https://avatars.githubusercontent.com/u/204420278?v=4?s=64" width="64px;" alt="betoloko1970"/><br /><sub><b>betoloko1970</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=betoloko1970" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/berrub00"><img src="https://avatars.githubusercontent.com/u/269054991?v=4?s=64" width="64px;" alt="berrub00"/><br /><sub><b>berrub00</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=berrub00" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/zeroaiproject"><img src="https://avatars.githubusercontent.com/u/355486270?v=4?s=64" width="64px;" alt="Zero AI"/><br /><sub><b>Zero AI</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=zeroaiproject" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/World2576"><img src="https://avatars.githubusercontent.com/u/202460698?v=4?s=64" width="64px;" alt="World2576"/><br /><sub><b>World2576</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=World2576" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/wanjinhao1"><img src="https://avatars.githubusercontent.com/u/34562501?v=4?s=64" width="64px;" alt="Kratos"/><br /><sub><b>Kratos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=wanjinhao1" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Denispds"><img src="https://avatars.githubusercontent.com/u/151410339?v=4?s=64" width="64px;" alt="Denis pereira dos santos Araújo"/><br /><sub><b>Denis pereira dos santos Araújo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Denispds" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gabriel-lima-git-hub"><img src="https://avatars.githubusercontent.com/u/306846636?v=4?s=64" width="64px;" alt="gabriel-lima-git-hub"/><br /><sub><b>gabriel-lima-git-hub</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=gabriel-lima-git-hub" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lucas-nobrega"><img src="https://avatars.githubusercontent.com/u/38710249?v=4?s=64" width="64px;" alt="Lucas"/><br /><sub><b>Lucas</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Alucas-nobrega" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/WaldineyGodoy"><img src="https://avatars.githubusercontent.com/u/163134445?v=4?s=64" width="64px;" alt="WaldineyGodoy"/><br /><sub><b>WaldineyGodoy</b></sub></a><br /><a href="#ideas-WaldineyGodoy" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/brunno-soaress"><img src="https://avatars.githubusercontent.com/u/318511864?v=4?s=64" width="64px;" alt="brunno-soaress"/><br /><sub><b>brunno-soaress</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Abrunno-soaress" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gleisaum"><img src="https://avatars.githubusercontent.com/u/4007202?v=4?s=64" width="64px;" alt="Gleison Neves"/><br /><sub><b>Gleison Neves</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Agleisaum" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/amexgestao"><img src="https://avatars.githubusercontent.com/u/211154203?v=4?s=64" width="64px;" alt="amexgestao"/><br /><sub><b>amexgestao</b></sub></a><br /><a href="#ideas-amexgestao" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/InvestidorDiversificado"><img src="https://avatars.githubusercontent.com/u/336340817?v=4?s=64" width="64px;" alt="InvestidorDiversificado"/><br /><sub><b>InvestidorDiversificado</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3AInvestidorDiversificado" title="Bug reports">🐛</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 🐛 Reportar bugs

Abre un [issue](https://github.com/melgarafael/DeskcommCRM/issues/new/choose) — la plantilla pide lo que necesitamos (entorno, `/api/v1/health`, pasos). Correr `bash hostgator-setup-kit/healthcheck.sh` y pegar la salida ayuda mucho.

Para **vulnerabilidades de seguridad**, **NO abras un issue público** — usa el [reporte privado de vulnerabilidades](https://github.com/melgarafael/DeskcommCRM/security/advisories/new). Detalles en [`SECURITY.md`](SECURITY.md).

---

## 🗺️ Roadmap

### ✅ Entregado

- **Fundación y plataforma** — auth (MFA para admin), multi-tenancy con RLS + test de aislamiento, RBAC de 4 roles, audit log append-only, onboarding de tenant.
- **Atención WhatsApp** — inbox de 3 paneles en tiempo real, conexiones multinúmero por **QR (WAHA)** o **canal oficial de Meta** (plantillas aprobadas y sincronizadas), medios vía Storage, anti-baneo (throttle + jitter + ventana horaria), detección de STOP.
- **CRM y pedidos** — kanban con vocabulario configurable por nicho (fractional indexing), gestión de embudos desde la pantalla, customer 360, contactos, etiquetas, integración Nuvemshop.
- **IA nativa** — agentes con RAG por tenant (pgvector), **skills** que el agente ejecuta solo, **memoria de la organización**, enrutador de intención por número, análisis de sentimiento, handoff IA→humano, tope de gasto por org, servidor MCP interno.
- **Elección de proveedor de IA** — OpenRouter, Anthropic u OpenAI, decidido en la instalación y cambiable por parte del sistema desde la pantalla.
- **Follow-up vivo** — retomar conversaciones enfriadas con tiempo adaptativo, disparadores por etapa y por caso, cola con rotación, y el Radar de lo que corre riesgo de morir sin respuesta.
- **LGPD** — export y redact vía workers, anonimización en cascada, consentimiento auditado.
- **Self-host** — `hostgator-setup-kit` (app + WhatsApp + base con 1 comando), `baseline.sql` auto-curativo, **actualización desde la pantalla** con backup automático, runbook de producción.
- **Webhooks y automatización** — fuentes de captación + reglas CUANDO/SI/ENTONCES + disparadores para sistemas externos.
- **Gobernanza de atención** — RBAC server-side en toda la API, asignación y transferencia auditadas (IA como responsable de 1ª clase), visualización por rol (RLS) + métricas por agente, enrutamiento automático con cola y panel de gestión, y contrato de gobernanza para agentes de IA externos ([`docs/specs/14`](docs/specs/14-contrato-governanca-agentes-externos.md)).
- **Operación visible** — motivo de la retención anti-baneo traducido en la conversación, central de avisos con severidad, aviso de mensaje trabada, control de protección de envío (ventana/ritmo/tope), capacidades declaradas del agente y propuestas del flywheel aplicables como versión nueva (con gate humano).

### 🔮 Próximo

- **MCP público** — capacidades del CRM expuestas al ecosistema de agentes: enchufa el agente que quieras y opera el Deskcomm.
- **Plantillas por nicho** — embudos y vocabularios listos para clínicas, inmobiliarias, infoproductos y servicios (e-commerce ya entregado).
- **Integraciones** — VTEX y Shopify vía adapter pattern (Nuvemshop ya entregado).
- **Identidad probabilística** — unificación de contactos entre canales.

---

## 💬 Comunidad

- **Discusiones:** [GitHub Discussions](https://github.com/melgarafael/DeskcommCRM/discussions)
- **Issues:** [GitHub Issues](https://github.com/melgarafael/DeskcommCRM/issues)
- **Instagram:** [@melgarafael](https://www.instagram.com/melgarafael)
- **YouTube:** [youtube.com/@melgarafael](https://www.youtube.com/@melgarafael)

---

## 📜 Licencia

Distribuido bajo la licencia **MIT** — ver [`LICENSE`](LICENSE). Puedes usar, modificar y distribuir libremente, incluso comercialmente. El software se entrega **"tal cual", sin garantías**.

---

## 🛟 Soporte y responsabilidades (self-host)

Este es un proyecto **self-host**: cada persona corre el CRM en su **propia infraestructura** (VPS, base Supabase y clave de IA propios). Eso implica:

- **El soporte es comunitario y "as-is".** No hay SLA — es open source mantenido por buena voluntad.
- **Eres responsable de tu instalación.** Las actualizaciones no son automáticas (haces clic, o corres `update.sh`, cuando quieras), y mantener/respaldar tu servidor es cosa tuya.
- **Protección de datos:** quien **hospeda** la instancia es el **controlador** de los datos personales tratados ahí (clientes, conversaciones, pedidos), con las obligaciones legales que eso implica. Los mantenedores del proyecto **no son** controladores ni operadores de tu instancia, y no tienen acceso a tu base, a tu WhatsApp ni a tu storage.
- **Telemetría (Sentry):** `install.sh` **pregunta** durante la instalación y respeta tu respuesta; en modo no interactivo, sin `SENTRY_DSN` definido, la telemetría queda **apagada**. Si aceptas el Sentry de la comunidad, lo que se envía son **reportes de error** (stack trace) con documento, teléfono y correo sustituidos, cabeceras sensibles removidas, y token de webhook/invitación redactado de la URL — **sin** rastreo de performance y **sin** replay de sesión, que quedan en 0 en ese camino. Para apagarlo en cualquier momento: `SENTRY_DSN=off` en el `.env`. Para mandarlo a **tu** Sentry (ahí sí con performance y replay): `SENTRY_DSN=<tu-dsn>`. Qué se redacta, y por qué, está en [`lib/sentry/scrub.ts`](lib/sentry/scrub.ts); la resolución del DSN en [`lib/sentry/dsn.ts`](lib/sentry/dsn.ts).

---

## 🙏 Agradecimientos

- **WAHA** ([devlikeapro](https://waha.devlikeapro.com/)) — motor de WhatsApp.
- **Supabase** — Postgres + Auth + Storage + Realtime en una sola stack.
- **HostGator** — la alianza de infraestructura que hizo posible el self-host de 1 comando.
- **Anthropic**, **OpenAI** y **OpenRouter** — los proveedores de IA que el CRM sabe usar.
- **shadcn/ui** — base de componentes.
- La comunidad que nos llevó del e-commerce a clínicas, inmobiliarias, infoproductos y más allá — ustedes definieron lo que es este proyecto.

---

<div align="center">

**Built with ☕ in Brasil** · **Made for the community**

</div>
