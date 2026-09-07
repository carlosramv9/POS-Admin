/**
 * Proxy HTTP → HTTP/HTTPS para desarrollo.
 *
 * **Es la puerta de entrada de las apps móviles.** Escucha en :3002 y reenvía a
 * la API de NestJS en localhost:3001/api. El 3001 queda para los clientes que
 * viven en la misma máquina (ERP web, POS); las apps móviles apuntan siempre
 * aquí.
 *
 * Qué aporta el salto:
 *  - CORS: la API solo admite los orígenes de `CORS_ORIGIN` (las apps web
 *    internas). Este proxy responde `Access-Control-Allow-Origin: *`, que es lo
 *    que necesita un cliente fuera de esa lista — la app en modo web, un WebView.
 *  - Una URL estable para el dispositivo, que no depende del puerto que anuncie
 *    Metro en cada arranque.
 *  - HTTPS: puede apuntar a un backend con TLS (`TARGET_HTTPS`) sin que la app
 *    lidie con certificados de desarrollo.
 *
 * Ejecutar: node scripts/proxy.js
 * Luego, en el `.env` del móvil (IP LAN de la máquina, nunca `localhost`, que
 * desde el teléfono es el propio teléfono):
 *   EXPO_PUBLIC_API_URL=http://<TU_IP_LAN>:3002/api
 *
 * Ver apps/mobile/orbix-mobile/README.md.
 */

const http = require("http");
const https = require("https");
const url = require("url");

// Configuración
const PROXY_PORT = 3002;
const TARGET_HOST = "localhost";
const TARGET_PORT = 3001;
const TARGET_BASE_PATH = "/api";
const TARGET_HTTPS = false; // cambiar a true si el backend usa HTTPS

const server = http.createServer((req, res) => {
  // Configurar CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url);
  const targetPath = TARGET_BASE_PATH + parsedUrl.path.replace("/api", "");

  console.log(`📡 ${req.method} ${targetPath}`);
  console.log(
    `🔑 Auth: ${req.headers.authorization ? "Bearer presente" : "Sin token"}`,
  );

  const options = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${TARGET_HOST}:${TARGET_PORT}`,
    },
    ...(TARGET_HTTPS && { rejectUnauthorized: false }),
  };

  const requester = TARGET_HTTPS ? https : http;
  const proxyReq = requester.request(options, (proxyRes) => {
    console.log(`✅ ${proxyRes.statusCode} ${targetPath}`);

    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    console.error(`❌ Error: ${err.message}`);
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });

  req.pipe(proxyReq);
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Proxy corriendo en http://0.0.0.0:${PROXY_PORT}`);
  console.log(
    `📍 Redirigiendo a ${TARGET_HTTPS ? "https" : "http"}://${TARGET_HOST}:${TARGET_PORT}${TARGET_BASE_PATH}`,
  );
  console.log(`\n📱 En tu .env usa:`);
  console.log(`   EXPO_PUBLIC_API_URL=http://10.0.2.2:${PROXY_PORT}/api\n`);
});
