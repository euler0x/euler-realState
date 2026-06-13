# Adapter MercadoLibre — Setup OAuth (one-time)

El adapter usa la API oficial de MercadoLibre con OAuth 2.0 (Bearer token). Los pasos a continuación son
manuales y solo hay que realizarlos una vez. Después de eso, el adapter rota el token automáticamente.

---

## Paso 1 — Crear una aplicación en MercadoLibre Developers

1. Ir a [https://developers.mercadolibre.com.ar/](https://developers.mercadolibre.com.ar/) e iniciar sesión
   con la cuenta de ML que se usará como owner de la app (puede ser una cuenta de test o la cuenta real).
2. Crear una nueva aplicación (gratis). En la configuración:
   - Configurar un **Redirect URI** válido, por ejemplo: `http://localhost:3000`
     (no necesita estar levantado, solo hay que poder ver la URL de redirección en el browser).
3. Copiar el **Client ID** y el **Client Secret** de la app creada.

---

## Paso 2 — Obtener el authorization code

Abrir este URL en el browser (reemplazando los valores):

```
https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=<CLIENT_ID>&redirect_uri=<REDIRECT_URI>
```

- Iniciar sesión con la cuenta ML si se pide.
- Autorizar la aplicación.
- El browser redirige a `<REDIRECT_URI>?code=TG-XXXXXXXXXX-YYYYYY`. Copiar el valor del parámetro `code`.

> El `code` tiene una vida muy corta (~10 minutos). Realizar el paso 3 de inmediato.

---

## Paso 3 — Canjear el code por tokens

```bash
curl -X POST https://api.mercadolibre.com/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&client_id=<CLIENT_ID>&client_secret=<CLIENT_SECRET>&code=<CODE>&redirect_uri=<REDIRECT_URI>"
```

La respuesta es un JSON con:

```json
{
  "access_token": "APP_USR-...",
  "token_type": "Bearer",
  "expires_in": 21600,
  "refresh_token": "TG-...",
  "user_id": 123456789,
  "scope": "offline_access read write"
}
```

Guardar el valor de **`refresh_token`** (empieza con `TG-`).

---

## Paso 4 — Configurar variables de entorno

Agregar al archivo `.env` (o `.env.local`):

```env
MELI_CLIENT_ID=<el client_id de la app>
MELI_CLIENT_SECRET=<el client_secret de la app>
MELI_REFRESH_TOKEN=<el refresh_token obtenido en el paso 3>
# Opcional: path donde se persiste el token rotado (default: .data/meli-token.json)
# MELI_TOKEN_FILE=.data/meli-token.json
```

---

## Comportamiento post-setup

- El **access token** dura 6 horas. El adapter lo cachea en memoria y lo refresca automáticamente
  antes de que expire.
- El **refresh token es de un solo uso** (single-use rotation): cada vez que se refresca el access token,
  ML devuelve un nuevo refresh_token que reemplaza al anterior. El adapter persiste el nuevo valor en
  `.data/meli-token.json`.
- Si `.data/meli-token.json` existe, el adapter lo usa en lugar de la variable `MELI_REFRESH_TOKEN`.
  Esto garantiza que tras el primer refresh, siempre se usa el token más reciente aunque no se actualice
  el `.env`.
- Agregar `.data/` al `.gitignore` para no commitear el token persistido.

---

## Sin credenciales

Si alguna de las variables `MELI_CLIENT_ID`, `MELI_CLIENT_SECRET`, o `MELI_REFRESH_TOKEN` no está
configurada, `meliHasCredentials()` devuelve `false` y el adapter no se agrega al pipeline de búsqueda.
El sistema funciona normalmente solo con Argenprop.
