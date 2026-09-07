# @orbix/mobile

Cliente móvil de Orbix ERP. React Native + Expo SDK 54 + Expo Router.

La base visual es el prototipo de Claude Design *Orbix Onboarding — Vibrante*; los
tokens (`oklch`) fueron portados a sRGB con mapeo de gamut real en
[`src/theme/tokens.ts`](src/theme/tokens.ts), donde cada color conserva su
`oklch()` original en un comentario para poder auditarlo contra el diseño.

## Empezar

```bash
pnpm install       # desde la raíz del monorepo
pnpm dev:server    # la API, en :3001
node scripts/proxy.js   # proxy :3002 → :3001, desde la raíz del monorepo
pnpm dev:mobile    # Metro  (o: pnpm --filter @orbix/mobile dev)
```

### La app móvil se conecta al puerto 3002, no al 3001

`scripts/proxy.js` (en la raíz del monorepo) escucha en **3002** y reenvía todo a
`localhost:3001/api`, que es donde corre la API de NestJS. **Las apps móviles
apuntan siempre al 3002**; el 3001 queda para los clientes que viven en la misma
máquina (ERP web, POS).

Por qué existe el salto:

- **CORS.** La API solo admite los orígenes de `CORS_ORIGIN` (las apps web
  internas). El proxy responde `Access-Control-Allow-Origin: *`, que es lo que
  necesita un cliente que no está en esa lista — la app en modo web, o un
  WebView.
- **Una sola URL estable.** El dispositivo la alcanza por la IP LAN de tu
  máquina (`http://192.168.x.x:3002/api`), sin depender de qué puerto anuncie
  Metro en cada arranque.
- **HTTPS.** El proxy puede apuntar a un backend con TLS (`TARGET_HTTPS`) sin
  que la app tenga que lidiar con certificados de desarrollo.

En un teléfono físico, pon la IP LAN de tu máquina en `.env`:

```bash
EXPO_PUBLIC_API_URL=http://192.168.x.x:3002/api   # tu IP, no localhost
```

`localhost` desde el teléfono es el propio teléfono, así que ahí no sirve.

Sin `.env`, la app deduce la URL del propio dev server: `hostUri` es la dirección
con la que tu dispositivo alcanzó a Metro, así que ya es enrutable desde él, y
solo se le cambia el puerto. **Esa deducción usa `DEV_API_PORT` de
[`src/constants/env.ts`](src/constants/env.ts) y hoy apunta al 3001**, saltándose
el proxy: funciona para una app nativa (no hay CORS de por medio), pero no para
la app en web. Si quieres el proxy siempre, fija `EXPO_PUBLIC_API_URL`, que
tiene prioridad sobre lo deducido.

Otros casos donde tienes que intervenir:

- **`expo start --host localhost`** — Expo solo hace `adb reverse` del puerto de
  Metro. Añade `adb reverse tcp:3002 tcp:3002` (o `tcp:3001` si vas directo).
- **API en otra máquina** — fija `EXPO_PUBLIC_API_URL` en un `.env`.

Copia `.env.example` a `.env` solo si necesitas Google Sign-In, apuntar al proxy
desde un dispositivo físico, o cambiar algún default.

```bash
pnpm --filter @orbix/mobile typecheck   # tsc --noEmit
pnpm --filter @orbix/mobile lint        # eslint, 0 warnings
pnpm --filter @orbix/mobile deps:check  # expo install --check
```

## Variables de entorno

Expo carga `.env`, y además `.env.development` o `.env.production` según
`NODE_ENV`. Se validan con Zod al arrancar ([`src/constants/env.ts`](src/constants/env.ts)):
una variable inválida falla en el arranque, no en mitad de una request.

`EXPO_PUBLIC_*` se **inlinea en el bundle** — nunca metas un secreto ahí. Los
client IDs de Google son públicos por diseño; el *client secret* vive solo en el
backend.

| Variable | Obligatoria | Nota |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | no | Incluye el prefijo `/api`. Sin ella se deduce del dev server; obligatoria en un build de release |
| `EXPO_PUBLIC_API_TIMEOUT` | no | Default 15000 ms |
| `EXPO_PUBLIC_DEFAULT_LOCALE` | no | `es` \| `en` \| `pt` |
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID` | no | Sin ninguno, el botón de Google no se muestra |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | no | |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | no | |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | no | |

## Arquitectura

El flujo de datos va en una sola dirección; una pantalla nunca llama a axios.

```
app/ (rutas)  →  features/ (hooks)  →  repositories/  →  services/api  →  API
                      ↓                      ↓
                 providers/              dto/ → models/
```

| Carpeta | Responsabilidad |
|---|---|
| `app/` | Rutas de Expo Router. `route-guard.tsx` concentra toda la protección |
| `components/` | Design System (`Orbix*`). Sin colores literales: todo sale de `useTheme()` |
| `features/` | Hooks por dominio: `auth`, `onboarding`, `tenant`, `business`, `common` |
| `repositories/` | Único lugar que conoce las rutas HTTP; mapea DTO → modelo |
| `services/` | `api` (axios + interceptores), `auth`, `storage`, `query`, `theme` |
| `providers/` | Contextos de React sobre los servicios |
| `dto/` | Contratos de transporte, espejo de la API |
| `models/` | Tipos de dominio que consume la UI |
| `theme/` | Tokens, tipos y merge del tema; sin React |

### Sesión

La API tiene autenticación en dos pasos, y la app la respeta:

1. `POST /auth/login` → JWT preliminar + `availableTenants[]`
2. `PATCH /auth/select-tenant/:slug` → JWT con `tenantId`
3. `PATCH /auth/select-branch/:branchId` → JWT con `branchId`

Los tokens viven en el keychain (`expo-secure-store`). El resto de la sesión se
cachea en MMKV para que un arranque en frío pinte la pantalla correcta antes de
que `GET /auth/me` conteste. Un 401 dispara **un solo** refresh compartido entre
todas las requests en vuelo — la API rota el refresh token en cada uso, así que
refrescar en paralelo invalidaría los tokens entre sí.

### Temas

No hay colores literales en los componentes. `ThemeProvider` expone los tokens por
`useTheme()` y además los inyecta como variables CSS, de modo que las clases de
NativeWind (`bg-primary`) también responden al tema del tenant. El branding se
lee de disco de forma síncrona al cambiar de tenant (re-skin instantáneo) y se
refresca en segundo plano.

### Permisos

`usePermissions()` lee los permisos que devuelve `GET /auth/me` — la unión que
calcula el `PermissionsGuard` del backend. Nada hardcodeado; `SUPER_ADMIN` salta
todas las comprobaciones, igual que en el servidor.

## Lo que aún no existe en el backend

Cinco endpoints del flujo no existen todavía. La app **no los simula**: documenta
el contrato y degrada de forma explícita. Ver **[BACKEND-GAPS.md](BACKEND-GAPS.md)**.

En corto: Google OAuth, OTP de teléfono, creación self-service de empresa,
catálogo de tipos de negocio y branding del tenant. Lo que sí funciona contra la
API real: registro, login, refresh, logout, perfil, selección de empresa y
sucursal, capacidades del plan y los KPIs de inicio (`GET /dashboard/stats`).

## Relación con el POS

`apps/mobile/orbix-app` —el POS de terminal, con activación por QR, login por
PIN y cola de sincronización offline— se eliminó del repo en `cec732b`. Hoy
`orbix-mobile` es la única app móvil; el POS vive en `apps/pos-web`.
