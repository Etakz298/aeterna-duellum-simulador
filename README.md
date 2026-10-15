# Aeterna Duellum · Simulador de Cartas

Simulador de mesa para Aeterna Duellum. Funciona como app de escritorio (Electron), en el navegador y, desde ahora, en **modo online 1 contra 1**.

## Modos de juego

- **Un jugador**: la misma mesa que el 1 contra 1, pero controlas a los dos jugadores: ves las dos manos y mueves las cartas de los dos lados. Eliges un mazo para cada lado, hay tokens, vidas, registro y **Terminar partida** guarda qué campeón (mazo) ha ganado en un historial de este ordenador. La partida se guarda sola y sigue ahí al recargar.
  - Los mazos publicados en el servidor del 1 vs 1 se copian solos al abrir la app (y al volver de online) cuando han cambiado, así un jugador y online tienen siempre los mismos mazos.
  - El botón *Mazos* abre la biblioteca de siempre (importar cartas, cantidades, dorsos y la mesa libre antigua). Todo se guarda en local (`data/` junto al .exe, o el navegador).
  - *Traer mazos del 1 vs 1* copia en este ordenador los mazos publicados en el servidor (cartas, cantidades y dorsos), para usarlos también en un jugador. Si ya hay un mazo con el mismo nombre, pregunta antes de cambiar sus cartas.
- **Online 1 contra 1**: botón *Jugar Online (1 vs 1)* en el menú lateral.
  - Un jugador crea una sala y comparte el código (o el enlace de invitación `https://<servidor>/?sala=CODIGO`).
  - Cada uno elige su mazo y pulsa *Poner mi mazo barajado en la mesa*.
  - La mesa tiene el mismo aspecto que la de un jugador, con franjas marcadas para cada zona. Se escala a la ventana, así los dos jugadores la ven igual sea cual sea su resolución. Tu rival aparece enfrente (girado 180º).
  - Cada jugador tiene: **Biblioteca** (a la izquierda de la mano), **Mano** (privada), **Cementerio** (a la derecha: las cartas quedan boca abajo, giradas 90º a la izquierda y la última arriba) y su **Zona de juego**.
  - Las cartas nunca salen de las zonas. Puedes coger una carta de la zona de juego o del cementerio del rival y llevarla a tu mano, tu zona de juego o tu cementerio.
  - Vida fija a los lados: la tuya a la izquierda (solo tú puedes cambiarla) y la del rival a la derecha.
  - **Tokens**: fichas amarillas que se ponen encima de las cartas y se mueven libremente. Doble clic o clic derecho para quitarlas.
  - El servidor es el único que sabe qué carta es cada carta boca abajo: los navegadores no reciben esa información hasta que la carta se voltea, así que no se puede hacer trampa mirando el tráfico.
  - Registro de la partida y chat en el botón *Chat*.
  - **Enseñar mi mano**: botón en tu mano para que el rival vea todas tus cartas hasta que pulses *Ocultar mi mano*.
  - **Terminar partida**: pregunta quién ha ganado y lo guarda en el **Historial** (por sala, de hoy o todas), con victorias y derrotas por jugador y por mazo. El historial se guarda en el servidor junto a los mazos publicados, así que en Railway necesita el volumen para no perderse.
  - **Móvil**: las zonas de juego se dibujan más bajas para que las manos y los montones se vean más grandes; la mesa se ve entera y el panel pasa a un botón de menú (☰). Al tocar una carta se ve en grande unos segundos en el borde derecho y sus acciones aparecen en el centro; tocar la biblioteca roba (mantenerla pulsada: barajar o mirar); tocar el cementerio o una vida muestra sus acciones. El botón de pantalla completa quita las barras del navegador (en iPhone: Compartir → *Añadir a pantalla de inicio* y abrirlo desde ese icono).
  - **Tablet**: arrastra con el dedo; toca una carta de la mano para *Enseñar* o *Jugar boca abajo*; mantén pulsada una carta para verla en grande; toca la biblioteca para robar y un token para quitarlo. Mejor en horizontal.
  - Si se cierra la ventana o se cae la conexión, al volver se recupera el sitio en la sala.

### Controles online

| Acción | Cómo |
| --- | --- |
| Robar | Clic en tu biblioteca o tecla **R** |
| Jugar una carta | Arrastrarla de la mano a tu zona de juego (boca arriba; manteniendo **Mayús** al soltar, boca abajo) |
| Mover cartas | Arrastrar entre tus zonas; dentro de tu zona de juego se colocan donde quieras |
| Mirar tu biblioteca o cementerio | Botón de la lupa junto al montón. El rival ve en el registro que lo haces |
| Enseñar una carta de la mano sin jugarla | Pasar el ratón por encima y *Enseñar* |
| Carta seleccionada | **F** voltear, **Q/E** girar, **H** a la mano, **G** al cementerio |

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
