/**
 * Typed, validated access to public runtime configuration.
 *
 * Expo inlines `EXPO_PUBLIC_*` at build time via a literal-only transform, so
 * each variable must be referenced as a full static property access —
 * `process.env[name]` would compile to `undefined`.
 *
 * Validation runs once at module load. A missing required variable fails loudly
 * at startup instead of surfacing as a confusing network error later.
 */
import Constants from 'expo-constants';
import { z } from 'zod';

const envSchema = z.object({
  apiUrl: z.url({ error: 'EXPO_PUBLIC_API_URL must be an absolute URL' }),
  apiTimeout: z.coerce.number().int().positive().default(15_000),
  defaultLocale: z.enum(['es', 'en', 'pt']).default('es'),
  google: z.object({
    clientId: z.string().optional(),
    androidClientId: z.string().optional(),
    iosClientId: z.string().optional(),
    webClientId: z.string().optional(),
  }),
});

export type Env = z.infer<typeof envSchema>;

/** Treats empty strings as absent — `.env` placeholders are committed empty. */
function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Puerto al que apunta la URL DEDUCIDA del dev server (ver `api/.env`).
 *
 * Ojo con el contrato de red del proyecto: las apps móviles se conectan al
 * **3002**, que es el proxy (`scripts/proxy.js` en la raíz del monorepo) hacia
 * la API en el 3001. Esta constante deja la deducción automática apuntando
 * directo al 3001, que funciona para una app NATIVA porque no hay CORS de por
 * medio; la app en web sí necesita el proxy.
 *
 * Para usar el proxy siempre, fija `EXPO_PUBLIC_API_URL`, que tiene prioridad
 * sobre lo deducido — ver el README.
 */
const DEV_API_PORT = 3001;

/**
 * Deduce la URL de la API en desarrollo a partir de dónde está Metro.
 *
 * `hostUri` es el `host:puerto` que anuncia el dev server, y la API corre en la
 * misma máquina: reutilizar ese host cambiando el puerto evita que cada quien
 * tenga que escribir su IP a mano en un `.env`. Con el modo por defecto
 * (`--lan`) es la IP LAN de la máquina, alcanzable tanto desde un teléfono en
 * la misma Wi-Fi como desde el emulador de Android.
 *
 * Excepción: con `expo start --host localhost`, `hostUri` es `localhost` y
 * Expo solo hace `adb reverse` del puerto de Metro. Ahí hace falta también
 * `adb reverse tcp:3001 tcp:3001` (o `tcp:3002 tcp:3002` si pasas por el
 * proxy), o fijar `EXPO_PUBLIC_API_URL`.
 *
 * Devuelve `undefined` en release (no hay dev server) y ante cualquier formato
 * inesperado; en ambos casos manda `EXPO_PUBLIC_API_URL`.
 */
function apiUrlFromDevServer(): string | undefined {
  if (!__DEV__) return undefined;

  const hostUri = Constants.expoConfig?.hostUri;
  const host = optional(hostUri)?.split('/')[0]?.split(':')[0];
  if (!host) return undefined;

  return `http://${host}:${DEV_API_PORT}/api`;
}

const raw = {
  apiUrl:
    optional(process.env.EXPO_PUBLIC_API_URL) ??
    apiUrlFromDevServer() ??
    `http://localhost:${DEV_API_PORT}/api`,
  apiTimeout: optional(process.env.EXPO_PUBLIC_API_TIMEOUT) ?? 15_000,
  defaultLocale: optional(process.env.EXPO_PUBLIC_DEFAULT_LOCALE) ?? 'es',
  google: {
    clientId: optional(process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID),
    androidClientId: optional(process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID),
    iosClientId: optional(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID),
    webClientId: optional(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID),
  },
};

const parsed = envSchema.safeParse(raw);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(
    `Invalid environment configuration.\n${issues}\n\n` +
      'Copy .env.example to .env and fill in the required values.',
  );
}

export const env: Env = parsed.data;

/**
 * Google sign-in is only offered when at least one client ID is configured, so
 * a fresh checkout without credentials still builds and runs.
 */
export const isGoogleAuthConfigured =
  Boolean(env.google.clientId) ||
  Boolean(env.google.androidClientId) ||
  Boolean(env.google.iosClientId) ||
  Boolean(env.google.webClientId);

export const isDev = __DEV__;
