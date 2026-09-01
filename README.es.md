<div align="center">

[🇧🇷 Português](README.md) · [🇺🇸 English](README.en.md) · 🇪🇸 Español

# 🛠️ SonghaiCRM — el Sistema Operativo de Ventas con IA, open source, para WhatsApp

**Agentes de IA que atienden, califican y venden en WhatsApp — dentro de un CRM open source que corre en tu propio servidor.**
**Sin mensualidad, sin funciones bloqueadas, tus datos siguen siendo tuyos. La alternativa abierta a Kommo, Octadesk e Intercom.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![Self-hosted](https://img.shields.io/badge/self--hosted-1%20comando-orange)](self-host-kit/)
[![CI](https://github.com/melgarafael/DeskcommCRM/actions/workflows/ci.yml/badge.svg)](https://github.com/melgarafael/DeskcommCRM/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[**⚡ Instalar**](#-instalar-en-tu-vps-el-camino-principal) · [**🔄 Actualizar**](#-actualizar) · [**🧭 Visión**](VISION.md) · [**🏗️ Arquitectura**](ARCHITECTURE.md) · [**🤝 Contribuir**](CONTRIBUTING.md) · [**🗺️ Roadmap**](#%EF%B8%8F-roadmap)

</div>

---

> ### ☁️ Corre este CRM en producción con 1 comando
>
> El [`self-host-kit/`](self-host-kit/) instala el CRM completo (app + WhatsApp + base de datos)
> en cualquier VPS con Docker con un único comando, y el
> [runbook de producción](docs/runbooks/waha-vps.md) ya asume ese entorno.
>
> **¿Todavía no tienes servidor?** Ejecuta esto **en tu propia computadora** (macOS, Linux o WSL).
> Te dice qué plan contratar — con los números reales del runbook, no un "depende" — y te
> devuelve el comando exacto para tu caso:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/self-host-kit/comecar.sh | bash
> ```
>
> *(¿prefieres leer antes de ejecutar? clona el repo y corre `bash self-host-kit/comecar.sh` —
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
bash self-host-kit/install.sh
```

Eso es todo. **No instalas Node, ni pnpm, ni compilas nada** — la imagen de la app ya viene
lista. Si falta Docker, el instalador pregunta y lo instala solo.

### Lo que necesitas tener a mano

| Ítem | Dónde conseguirlo |
|---|---|
| **VPS con Docker** | Cualquier proveedor de VPS con Docker. 4 GB de RAM recomendados |
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

> **Modo no interactivo:** copia `.env.selfhost.example` a `.env`, complétalo y ejecuta
> `bash self-host-kit/install.sh --yes`.

### ¿Otro hosting? (Hostinger, Coolify, Dokploy, CapRover…)

Funciona. Si tu VPS ya viene con un **proxy inverso propio** ocupando los puertos 80/443, el
instalador **lo detecta solo** y publica el CRM a través de él, en vez de intentar levantar un
Caddy que no cabría. En un caso específico — proxy en `--network host`, como hace Hostinger —
**pregunta en vez de adivinar**, porque publicar detrás del proxy equivocado instala "con éxito"
un sitio mudo. Detalles en [`self-host-kit/README.md`](self-host-kit/README.md).

### Primer acceso

Abre `https://<tu-dominio>` (el candado tarda ~1 min en aparecer), entra con el admin y ten a
mano **Google Authenticator** o **Authy** *si* querés activar la verificación en dos pasos — es **opcional** y está en Configuración › Seguridad; el primer inicio de sesión **no** la exige. En el
onboarding, escanea el código QR con el WhatsApp de tu número.

### 🤖 ¿Prefieres que una IA lo instale por ti?

Suelta la carpeta `self-host-kit/` en el chat de **Claude Code** corriendo dentro del VPS
y dile *"instálame el SonghaiCRM"*. Lee el [`CLAUDE.md`](self-host-kit/CLAUDE.md) del kit
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
cd /ruta/al/SonghaiCRM
bash self-host-kit/update.sh
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
ruido y muestra `✓ banco atualizado`. Si aparece `⚠ avisos que não são os esperados`, ahí sí
guarda el mensaje.

**¿Salió mal?** `bash self-host-kit/restore.sh` vuelve al backup.
**¿Solo quieres diagnosticar?** `bash self-host-kit/healthcheck.sh`.

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
- 🏢 **Multi-tenant + privacidad por diseño** — RLS en toda tabla tenant-aware con test de aislamiento como gate de CI; anonimización preferida sobre borrado; audit log append-only con retención de 5 años. Base legal: Ley n.º 3/2017 (Mozambique).
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
| **IA** | Vercel AI SDK v7 — OpenRouter, Anthropic, OpenAI y Google | El instalador pregunta cuál; se cambia después desde la pantalla |
| **Validación** | Zod | Input externo, env, payloads |
| **Observabilidad** | Sentry (scrub en error, transacción, span y breadcrumb) | Telemetría opt-in en la instalación |
| **Hosting** | Cualquier VPS con Docker | App + WhatsApp + workers en tu propia máquina |

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
| `e2e` | levanta un Supabase local, aplica `baseline.sql` y corre **44 de las 45** specs de Playwright por el frontend |

La única spec fuera del `e2e` es `vps-fresh-onboarding` — necesita WAHA + Redis + Resend + Nuvemshop de verdad. Es la **P0** de nuestra doctrina de QA visual, así que un `e2e` verde **no** prueba el recorrido de instalación fresca; ese se prueba en un VPS.

Entre los invariantes está el **test de aislamiento RLS**: crea 2 organizaciones, simula los claims JWT por el mismo camino `auth.uid()` / `fn_user_org_ids()` que usan las policies de producción, y prueba que un usuario de la org A ve **cero filas** de la org B en `conversations`, `messages`, `contacts` y `crm_leads`. Antes, un caso de control prueba que las filas de la org B realmente existen — sin él, el test pasaría con la tabla vacía.

---

## 📚 Documentación

| Doc | Qué tiene |
|---|---|
| [`self-host-kit/README.md`](self-host-kit/README.md) | **Instalación self-host** — el kit, los scripts, los hostings con proxy propio |
| [`docs/ATUALIZANDO.md`](docs/ATUALIZANDO.md) | **Cómo actualizar** tu instalación, en lenguaje simple |
| [`VISION.md`](VISION.md) | **Visión y posicionamiento** — qué es el proyecto, en qué cree y hacia dónde va |
| [`CHANGELOG.md`](CHANGELOG.md) | Qué cambió en cada versión — **lee la sección de tu versión antes de actualizar** |
| [`docs/SETUP.md`](docs/SETUP.md) | Setup de desarrollo, paso a paso, de todas las integraciones |
| [`docs/white-label.es.md`](docs/white-label.es.md) | **Instalar para clientes** — cambiar la marca, una instalación por cliente vs compartida, reventa |
| [`docs/runbooks/waha-vps.md`](docs/runbooks/waha-vps.md) | Runbook de WAHA en producción (dimensionamiento, recuperación) |
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

## 🐛 Reportar bugs

Abre un [issue](https://github.com/melgarafael/DeskcommCRM/issues/new/choose) — la plantilla pide lo que necesitamos (entorno, `/api/v1/health`, pasos). Correr `bash self-host-kit/healthcheck.sh` y pegar la salida ayuda mucho.

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
- **Self-host** — `self-host-kit` (app + WhatsApp + base con 1 comando), `baseline.sql` auto-curativo, **actualización desde la pantalla** con backup automático, runbook de producción.
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
- **Anthropic**, **OpenAI** y **OpenRouter** — los proveedores de IA que el CRM sabe usar.
- **shadcn/ui** — base de componentes.
- La comunidad que nos llevó del e-commerce a clínicas, inmobiliarias, infoproductos y más allá — ustedes definieron lo que es este proyecto.

---

<div align="center">

**Built with ☕ in Moçambique** · **Made for the community**

</div>
