<div align="center">

[🇧🇷 Português](README.md) · [🇺🇸 English](README.en.md) · 🇪🇸 Español

# 🛠️ DeskcommCRM — El Sistema Operativo de Ventas con Agentes de IA

**Agentes de IA que atienden, califican y venden por WhatsApp — dentro de un CRM open source corriendo en tu propio servidor.**
**Sin mensualidad, sin funciones bloqueadas, tus datos contigo. La alternativa abierta a Kommo, Octadesk e Intercom.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![Self-hosted](https://img.shields.io/badge/self--hosted-1%20comando-orange)](hostgator-setup-kit/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[**🧭 Visión**](VISION.md) · [**📘 Guía de instalación**](docs/SETUP.md) · [**🏗️ Arquitectura**](ARCHITECTURE.md) · [**🤝 Contribuir**](CONTRIBUTING.md) · [**📋 PRDs**](docs/prd/) · [**🗺️ Roadmap**](#%EF%B8%8F-roadmap)

</div>

---

> ### ☁️ Pon este CRM en producción con un solo comando
>
> DeskcommCRM se desarrolla en **alianza con HostGator**: el [`hostgator-setup-kit/`](hostgator-setup-kit/)
> instala el CRM completo (app + WAHA + base de datos) en un VPS con un único comando, y el
> [runbook de producción](docs/runbooks/waha-hostgator.md) ya asume ese entorno.
>
> **[👉 Contratar el VPS de HostGator con el descuento de la alianza](https://www.hostgator.com.br/52708-141-3-52.html)** —
> datacenter en São Paulo, ideal para WhatsApp funcionando 24/7. *(enlace de partner — contratar por él apoya el proyecto y te sale más barato)*

## ✨ Qué es

**Deskcomm** viene de **Desk** (escritorio) + **comm** (comercio): toda la operación de ventas de tu negocio en un solo escritorio, operada por personas y agentes de IA trabajando juntos.

El proyecto nació como un CRM de e-commerce — y la comunidad open source lo llevó mucho más allá: hoy funciona en **clínicas, inmobiliarias, negocios de infoproductos, agencias, tiendas y empresas de servicios** — cualquier negocio que vende por WhatsApp. El producto acompañó ese giro y se convirtió en un **sistema operativo de ventas**: agentes de IA con RAG por tenant atienden clientes, califican leads, los mueven por el embudo, disparan automatizaciones y saben cuándo pasar la conversación a un humano — con el CRM completo expuesto vía **MCP** para que los agentes lo operen de verdad. La historia completa está en [`VISION.md`](VISION.md).

### Por qué es diferente

- 🤖 **Agentes de IA que operan el CRM** — RAG por tenant, análisis de sentimiento, handoff IA→humano auditado, la IA como asignado de primera clase y control de presupuesto por organización. No es un chatbot decorativo: el agente atiende, califica y mueve el embudo.
- 🔁 **Agentes que se auto-mejoran** — las conversaciones resueltas se convierten en conocimiento nuevo para el RAG; los handoffs marcan dónde el agente todavía no llega; las métricas cierran el ciclo. Cada mes de operación hace al agente mejor, con compuerta humana donde importa.
- 🧩 **Multi-nicho por diseño** — vocabulario configurable por pipeline: un lead se vuelve *Cliente*, *Paciente* o *Comprador*; "ganado" se vuelve *Pagado*, *Agendado* o *Cerrado*. El mismo núcleo sirve para e-commerce (nuestra cuna, con integración nativa con Nuvemshop/Tiendanube), clínicas, inmobiliarias o infoproductos.
- 🔌 **MCP-ready** — servidor MCP interno para los agentes integrados; contrato público para agentes externos en construcción. El CRM como infraestructura para cualquier agente de IA.
- 💬 **WhatsApp-nativo vía WAHA** — multi-número, anti-baneo (throttle + jitter + ventanas de horario), medios vía Storage, detección de STOP.
- 👥 **Gobernanza de atención** — RBAC server-side de verdad, asignación/transferencia auditadas, cola con posición, enrutamiento automático y alcance de visualización por rol.
- 🏢 **Multi-tenant + privacidad por diseño (LGPD)** — RLS en toda tabla tenant-aware con test de aislamiento como gate de CI; anonimización preferida sobre borrado; log de auditoría append-only con retención de 5 años.
- 🖥️ **Self-hosted de verdad** — tus datos en tu VPS; instalación con 1 comando; sin versión paga, sin funciones bloqueadas.

### 🔌 Webhooks & Automatizaciones

Cada tenant puede crear **fuentes de captación**: una dirección pública (`/api/v1/webhooks/in/<token>`) que recibe leads de landing pages, formularios propios o herramientas como Zapier/n8n vía POST (JSON o `application/x-www-form-urlencoded`) y los deja directo en el embudo/etapa elegidos — sin código, sin integración a medida por tenant. Sobre esas fuentes (y los demás eventos del CRM — lead cambió de etapa, recibió una etiqueta, llegó un mensaje de WhatsApp), el tenant arma **automatizaciones**: reglas CUANDO/SI/ENTONCES que agregan etiquetas, mueven leads, asignan agentes, envían mensajes de WhatsApp o avisan a sistemas externos vía webhooks de salida.

En la UI todo vive en **Webhooks** en la barra lateral (visible solo para roles `manager`/`admin`). Tres pestañas: **Recibir datos** (crear una fuente, copiar la dirección/formulario listo, disparar un lead de prueba, ver las últimas entregas), **Automatizaciones** (armar la regla, que siempre nace pausada hasta que el tenant la revise y active) y **Actividad** (línea de tiempo de cada ejecución, con el resultado de cada acción y reenvío manual cuando una llamada a un webhook externo falla).

Por debajo, cada evento se convierte en una fila en `event_log` — ningún trigger de base de datos hace llamadas HTTP. La ruta `/api/v1/cron/event-log-drain` drena la cola cada minuto. En Vercel eso es un Cron Job gestionado; **en el kit self-host de HostGator** (`hostgator-setup-kit/`), `install.sh`/`update.sh` configura solo una línea de `crontab` que ejecuta esa ruta cada minuto con el `INTERNAL_SECRET` del `.env`.

---

## 🚀 Quickstart (velo funcionando en 5 minutos)

```bash
# 1. Clona
git clone https://github.com/melgarafael/DeskcommCRM.git
cd DeskcommCRM

# 2. Node 20 + pnpm
nvm use                    # o instala Node 20+
npm install -g pnpm
pnpm install

# 3. Variables de entorno
cp .env.example .env.local
# Edita .env.local — guía completa en docs/SETUP.md

# 4. WAHA local (opcional en dev sin WhatsApp)
docker compose up -d

# 5. Migraciones de Supabase
supabase link --project-ref <tu-ref>
supabase db push

# 6. Levanta la app
pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

> 🆕 **¿Primera vez? No te saltes pasos.** [`docs/SETUP.md`](docs/SETUP.md) es el tutorial completo paso a paso de **todas las integraciones** (Supabase, WAHA, Anthropic, Upstash, Sentry, Resend, Nuvemshop) — hecho para quien nunca configuró nada de esto. ~60–90 min de cero a la app funcionando. *(La documentación está en portugués de Brasil; ¡las traducciones son bienvenidas!)*

---

## 🧱 Stack

| Capa | Elección | Por qué |
|---|---|---|
| **Frontend** | Next.js 16 App Router (Turbopack) + React 19 + TypeScript 6 estricto | Server Components + Route Handlers en el mismo repo |
| **Estilos** | Tailwind + shadcn/ui (`new-york`, neutral) | Personalizable sin lock-in |
| **DB** | Supabase (Postgres + RLS + `vector`) | Multi-tenant nativo, embeddings para RAG |
| **Auth** | Supabase Auth vía `@supabase/ssr` | Cookies SameSite=Strict, HttpOnly |
| **Realtime** | Supabase Realtime | postgres_changes + broadcast |
| **Storage** | Supabase Storage (URLs firmadas) | Bucket privado `whatsapp-media` |
| **WhatsApp** | WAHA Plus (engine NOWEB) | Multi-tenant, retry, S3 |
| **Colas** | Tabla `event_log` + workers (cron) | Sin Inngest/Trigger en el MVP |
| **Rate limit** | Upstash Redis (sliding window) | Serverless, el free tier alcanza |
| **AI** | Vercel AI SDK v7 (providers Anthropic/Google/OpenAI v4) vía AI Gateway | Fallback automático, ZDR |
| **Validación** | Zod | Input externo, env, payloads |
| **Observabilidad** | Sentry (con `beforeSend` sanitizado) | Sin PII en los breadcrumbs |
| **Hosting** | Vercel (app) + HostGator VPS Turing/SP (WAHA) | Edge + servidor dedicado para WhatsApp; datacenter en Brasil |

Detalles: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 🧪 Tests

```bash
pnpm typecheck     # tsc --noEmit (estricto)
pnpm lint          # eslint next/core-web-vitals
pnpm test:unit     # Vitest
pnpm test:e2e      # Playwright (requiere dev server)
```

CI ejecuta todo antes del merge. **El test de aislamiento RLS es un gate obligatorio** — crea 2 tenants y verifica que no haya fugas. La suite de **invariantes de gobernanza** (100+ tests) bloquea regresiones de RBAC, asignación, alcance y enrutamiento.

---

## 📚 Documentación

| Doc | Qué contiene |
|---|---|
| [`VISION.md`](VISION.md) | **Visión y posicionamiento** — qué es el proyecto, en qué cree, hacia dónde va |
| [`docs/SETUP.md`](docs/SETUP.md) | **Instalación completa paso a paso** de todas las integraciones |
| [`CLAUDE.md`](CLAUDE.md) | Convenciones no negociables (lectura obligatoria para contribuir) |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Visión de 1 página de la arquitectura |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Flujo de PRs |
| [`docs/prd/`](docs/prd/) | PRDs (master, plataforma, customer 360, WhatsApp, pipeline, IA-RAG, Nuvemshop) |
| [`docs/specs/`](docs/specs/) | Specs técnicas 01–13 (schema SQL, payloads, MCP, gobernanza) |
| [`docs/runbooks/waha-hostgator.md`](docs/runbooks/waha-hostgator.md) | Runbook completo de WAHA en producción (VPS HostGator) |

> La mayor parte de la documentación está en portugués de Brasil — nuestra comunidad primaria. Las contribuciones de traducción son muy bienvenidas.

---

## 🤝 Contribuir

Este proyecto es open source para la comunidad. Toda contribución es bienvenida — desde corregir un typo en la documentación hasta una feature nueva.

1. Lee [`CLAUDE.md`](CLAUDE.md) (~5 min) — convenciones no negociables (multi-tenancy, RLS, auditoría, privacidad).
2. Lee [`CONTRIBUTING.md`](CONTRIBUTING.md) — flujo de branches y commits.
3. Sigue el [Código de Conducta](CODE_OF_CONDUCT.md).

**Definition of Done:** typecheck en cero, lint en cero, tests relevantes en verde, RLS testeada si se toca una tabla tenant-aware, log de auditoría emitido en mutaciones, migración versionada si cambia el schema.

---

## 🐛 Reportar bugs

Abre un [issue](https://github.com/melgarafael/DeskcommCRM/issues/new/choose) — la plantilla pide lo que necesitamos (entorno, `/api/v1/health`, pasos).

Para **vulnerabilidades de seguridad**, **NO abras un issue público** — usa el [reporte privado de vulnerabilidades](https://github.com/melgarafael/DeskcommCRM/security/advisories/new). Detalles en [`SECURITY.md`](SECURITY.md).

---

## 🗺️ Roadmap

### ✅ Entregado

- **Fundación & plataforma** — auth (MFA para admins), multi-tenancy con RLS + test de aislamiento, RBAC de 4 roles, log de auditoría append-only, onboarding de tenants.
- **Atención por WhatsApp** — inbox de 3 paneles en tiempo real, conexiones WAHA multi-número, medios vía Storage, anti-baneo (throttle + jitter + ventana de horario), detección de STOP.
- **CRM & pedidos** — kanban con vocabulario configurable por nicho (fractional indexing), customer 360, contactos, etiquetas, integración con Nuvemshop/Tiendanube para e-commerce.
- **IA nativa** — agentes con RAG por tenant (pgvector), análisis de sentimiento, handoff IA→humano, control de presupuesto por org, servidor MCP interno.
- **Privacidad (LGPD)** — export y redact vía workers, anonimización en cascada, consentimiento auditado.
- **Self-host** — `hostgator-setup-kit` (app + WAHA + base de datos con 1 comando), `baseline.sql` auto-curativo, runbook de producción.
- **Webhooks & automatización** — fuentes de captación + reglas CUANDO/SI/ENTONCES + triggers para sistemas externos.
- **Gobernanza de atención** — RBAC server-side en toda la API, asignación y transferencia auditadas (la IA como asignado de 1ª clase), visualización por rol (RLS) + métricas por agente, enrutamiento automático con cola y panel de gestión, y contrato de gobernanza para agentes de IA externos ([`docs/specs/14`](docs/specs/14-contrato-governanca-agentes-externos.md)). Épica guiada por 100+ invariantes (G1–G6).
- **Operación visible** — pantallas para que el operador entienda al agente: motivo de la retención anti-baneo traducido en la conversación, central de avisos con severidades, control de protección de envío (ventana/ritmo/tope) y propuestas del flywheel aplicables como versión nueva (con compuerta humana).

### 🔮 Próximo

- **Fase FG** — el agente Vendaval consume la gobernanza vía `ai_dispatch_mode=external` 🔜 *(esperando priorización del dueño)*

- **MCP público** — capacidades del CRM expuestas al ecosistema de agentes: conecta el agente que quieras y opera Deskcomm.
- **Flywheel de auto-mejora** — el ciclo conversación resuelta → conocimiento → agente mejor, medido y con compuerta humana.
- **Plantillas por nicho** — pipelines y vocabularios listos para clínicas, inmobiliarias, infoproductos y servicios (e-commerce ya entregado).
- **Integraciones** — VTEX y Shopify vía adapter pattern (Nuvemshop ya entregada).
- **Identidad probabilística** — unificación de contactos entre canales.

---

## 💬 Comunidad

- **Discusiones:** [GitHub Discussions](https://github.com/melgarafael/DeskcommCRM/discussions)
- **Issues:** [GitHub Issues](https://github.com/melgarafael/DeskcommCRM/issues)
- **Instagram:** [@melgarafael](https://www.instagram.com/melgarafael)
- **YouTube:** [youtube.com/@melgarafael](https://www.youtube.com/@melgarafael)

---

## 📜 Licencia

Distribuido bajo la licencia **MIT** — mira [`LICENSE`](LICENSE). Puedes usar, modificar y distribuir libremente, incluso con fines comerciales. El software se entrega **"tal cual", sin garantías**.

---

## 🛟 Soporte & responsabilidades (self-host)

Este es un proyecto **self-hosted**: cada persona ejecuta el CRM en su **propia infraestructura** (VPS, base de datos Supabase y clave de IA propias). Eso implica:

- **El soporte es comunitario y "as-is".** Sin SLA — es open source mantenido por buena voluntad.
- **Eres responsable de tu instalación**, incluyendo actualizaciones (`bash hostgator-setup-kit/update.sh`) y backups.
- **Protección de datos:** quien **hospeda** la instancia es el **responsable** de los datos personales que se procesan ahí. Los mantenedores del proyecto **no tienen acceso** a tus datos.
- **Telemetría (Sentry):** por defecto se envían errores **anonimizados** (sin PII) al Sentry de la comunidad. Usa `SENTRY_DSN=off` para desactivarlo, o `SENTRY_DSN=<tu-dsn>` para usar el tuyo.

---

## 🙏 Agradecimientos

- **WAHA** ([devlikeapro](https://waha.devlikeapro.com/)) — engine de WhatsApp.
- **Supabase**, **Vercel**, **Anthropic** (Claude), **shadcn/ui**.
- La comunidad que llevó Deskcomm del e-commerce a clínicas, inmobiliarias, infoproductos y más allá — ustedes definieron lo que este proyecto es.

---

<div align="center">

**Built with ☕ in Brasil** · **Made for the community**

</div>
