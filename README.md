# vpdf

Visor de documentos 100% en el navegador: se arrastra un archivo y se muestra.
Nada se sube a ningún servidor — todo el parseo y el renderizado ocurren en la
pestaña del usuario.

## Formatos soportados

| Formato | Motor | Qué se ve |
| --- | --- | --- |
| **PDF** | [`ts-pdf`](https://github.com/yermolim/ts-pdf) (pdf.js) | Render completo. Al hacer clic en una anotación se abre su nota (autor + texto) en una tarjeta. Crear/editar anotaciones está deshabilitado. |
| **PPTX** | [`pptx-preview`](https://www.npmjs.com/package/pptx-preview) | Render completo (texto, imágenes, tablas, formas, gráficos). Las notas del orador se extraen aparte y se muestran en un panel lateral. |
| **ODP** | Parser propio (`src/lib/odf.ts` + `odfStyles.ts`) | Reconstrucción por geometría y estilo: posición en % del tamaño de página real del master, y fuente/tamaño/color/negrita/cursiva/subrayado, alineación, relleno, borde y alineación vertical resueltos desde las hojas de estilo. Texto, listas, tablas, imágenes y conectores/líneas. |
| **PPT** (97-2003) | Extractor propio (`src/lib/legacyPpt.ts`) | Solo texto, best-effort. El contenedor binario OLE/CFB no tiene ninguna librería JS que lo parsee del todo, así que se recorre el stream de records y se agrupa el texto por diapositiva. Sin imágenes, formas ni diseño. |

El tipo se detecta por **firma binaria**, no por extensión ni MIME
(`src/lib/fileType.ts`). PPTX y ODP son ambos ZIP, así que se distinguen
mirando dentro del contenedor.

## Uso

- Clic en el panel o arrastrar un archivo sobre él para abrirlo.
- **Esc** cierra el documento y vuelve a la pantalla inicial.
- Una vez abierto un documento, el drag & drop queda desactivado.

## Desarrollo

```bash
npm install
npm run dev      # servidor de desarrollo
npm run build    # tsc -b && vite build
npm run lint     # oxlint
```

`public/pdf.worker.min.mjs` es el worker de pdf.js que usa ts-pdf; su versión
debe coincidir con la de la dependencia `ts-pdf`.

Hay archivos de prueba reales en `test/` (PDF, PPTX y ODP).

## Notas de arquitectura

- **El archivo se lee una sola vez.** `detectFile()` devuelve el `ArrayBuffer`
  y, para los formatos ZIP, la instancia de `JSZip` ya inflada; los visores la
  reutilizan en lugar de volver a leer y descomprimir el archivo.
- **Cada visor es un chunk aparte** (`React.lazy`). Las dependencias pesadas
  (pdf.js, pptx-preview + echarts, cfb) solo se descargan cuando se abre ese
  formato, así que el bundle inicial es ~90 kB gzip en vez de ~850 kB.
- **El PPTX se renderiza por lotes.** `preview()` de pptx-preview es, en modo
  lista, `load()` seguido de un `for` síncrono sobre todas las diapositivas;
  ese bucle congelaba la pestaña ~8 s en un deck de 10 MB. En su lugar
  llamamos a `load()` y conducimos nosotros `htmlRender.renderSlide(i)`
  cediendo el hilo entre diapositivas, con una barra de progreso. Medido en
  el mismo deck: **bloqueo máximo de 84 ms**, ninguno por encima de 100 ms.
- **Las medidas del ODP se expresan en `cqw`.** El documento trae tamaños
  absolutos (cm/pt) pero la diapositiva se dibuja al ancho que quepa, así que
  todo (fuentes, padding, bordes) se convierte a porcentaje del contenedor.
  Ojo: una unidad de container query **no se puede usar sobre el propio
  contenedor** — resuelve contra el viewport, no contra sí mismo.
