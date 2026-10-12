# Aeterna Duellum · Simulador de Cartas

Simulador de mesa para Aeterna Duellum. Funciona como app de escritorio (Electron), en el navegador y, desde ahora, en **modo online 1 contra 1**.

## Modos de juego

- **Un jugador**: el de siempre. Biblioteca de mazos, mesa libre, contadores. Todo se guarda en local (`data/` junto al .exe, o el navegador).
- **Online 1 contra 1**: botón *Jugar Online (1 vs 1)* en el menú lateral.
  - Un jugador crea una sala y comparte el código (o el enlace de invitación `https://<servidor>/?sala=CODIGO`).
  - Cada uno elige su mazo y pulsa *Poner mi mazo barajado en la mesa*.
  - La mesa es compartida; cada jugador tiene su **mano privada** abajo. Del rival solo se ve cuántas cartas tiene y sus reversos.
  - El servidor es el único que sabe qué carta es cada carta boca abajo: los navegadores no reciben esa información hasta que la carta se voltea, así que no se puede hacer trampa mirando el tráfico.
  - Barajar se hace en el servidor y renueva los identificadores de las cartas.
  - Registro de la partida y chat a la derecha (robar, barajar, mirar cartas, enseñar…).
  - Si se cierra la ventana o se cae la conexión, al volver se recupera el sitio en la sala.

### Controles online

| Acción | Cómo |
| --- | --- |
| Robar de tu mazo | Botón *Robar* o tecla **R** |
| Robar la carta de arriba de un montón concreto | Doble clic en el montón y **R** |
| Coger cartas de la mesa a la mano | Arrastrarlas hasta tu mano, o seleccionarlas y **H** |
| Jugar una carta | Arrastrarla de la mano a la mesa (boca arriba; con **Mayús** o el botón de la mano, boca abajo) |
| Mirar en privado cartas tuyas boca abajo (buscar en el mazo) | Seleccionarlas y *Mirar*. El rival ve en el registro que lo haces |
| Enseñar una carta de la mano sin jugarla | Pasar el ratón por encima y *Enseñar* |
| Voltear, rotar, barajar, retirar | **F**, **Q/E**, **Z**, **Supr** (igual que en un jugador) |

## Servidor online

El servidor (`server/`) es Node.js sin dependencias aparte de `ws`. Hace tres cosas:

1. Sirve la versión web del simulador (la carpeta `dist/`).
2. Guarda la biblioteca de mazos publicada (imágenes reducidas a WebP).
3. Gestiona las salas por WebSocket con el estado de la partida.

Variables de entorno:

| Variable | Para qué |
| --- | --- |
| `ADMIN_KEY` | Clave para publicar mazos desde el simulador. Obligatoria para poder subir mazos. |
| `PORT` | Puerto (Railway la pone sola). |
| `DATA_DIR` | Carpeta donde guardar la biblioteca. En Railway se usa automáticamente el volumen si hay uno montado. |

### Publicar los mazos

Desde la app de escritorio: *Jugar Online* → escribir la dirección del servidor → *Publicar mis mazos en el servidor* → clave `ADMIN_KEY`. Sube todos los mazos y reversos de tu biblioteca local (sustituye lo publicado antes). Repite cada vez que cambies cartas.

### Desarrollo local

```bash
npm install
npm run build
ADMIN_KEY=loquesea npm start      # http://localhost:8080
npm run dev                       # interfaz con recarga en caliente (usa el servidor de localhost:8080)
```

### Despliegue en Railway

1. Nuevo servicio desde este repositorio de GitHub (Railway lee `railway.json`: compila con `npm run build` y arranca con `npm start`).
2. Variables: `ADMIN_KEY` con una clave tuya.
3. Añadir un **Volume** al servicio (por ejemplo en `/data`) para que los mazos publicados no se pierdan en cada despliegue.
4. *Settings → Networking → Generate Domain* para tener la URL pública.

## App de escritorio

```bash
npm run electron:dev     # probar
npm run electron:build   # generar el .exe portable en dist-desktop/
```

Para que el .exe ya traiga la dirección del servidor, compila con `VITE_SERVER_URL=https://tu-app.up.railway.app npm run electron:build`. Si no, se escribe una vez en la pantalla online y se recuerda.
