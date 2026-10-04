/**
 * Carga licitaciones públicas en Firestore desde un archivo JSON.
 *
 * Uso (desde la carpeta scripts/):
 *   npm install
 *   set GOOGLE_APPLICATION_CREDENTIALS=C:\ruta\a\cuenta-de-servicio.json   (Windows)
 *   node cargar-licitaciones.mjs licitaciones.json
 *
 * El JSON es una lista de objetos con:
 *   titulo, organismo, rubro, jurisdiccion, apertura, url, fuente
 * (ver licitaciones-plantilla.json). "url" es obligatoria: es lo que
 * identifica a cada licitación, así que cargar el mismo archivo dos veces
 * no la duplica.
 *
 * Las PREVIEW_COUNT más recientes quedan con preview:true (la muestra que
 * ve el plan Gratis); el resto solo lo ven los planes pagos.
 * También actualiza stats/licitaciones con el total, que usa la app para
 * mostrar "Estás viendo 3 de N".
 *
 * Opcional: --cerrar-vencidas borra las licitaciones con fecha de apertura
 * (formato AAAA-MM-DD) anterior a hoy.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PREVIEW_COUNT = 3;
const file = process.argv[2];
const cerrarVencidas = process.argv.includes("--cerrar-vencidas");
if (!file) {
  console.error("Uso: node cargar-licitaciones.mjs <archivo.json> [--cerrar-vencidas]");
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: "tradex-corp-cd4a3" });
const db = getFirestore();

const items = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(items)) throw new Error("El archivo tiene que ser una lista (array) de licitaciones.");

let nuevas = 0;
for (const it of items) {
  if (!it.url || !it.titulo) { console.warn("Salteada (falta url o titulo):", it); continue; }
  const id = createHash("sha1").update(it.url).digest("hex").slice(0, 20);
  const ref = db.collection("licitaciones").doc(id);
  const snap = await ref.get();
  const data = {
    titulo: String(it.titulo).slice(0, 300),
    organismo: it.organismo || "",
    rubro: it.rubro || "Otros",
    jurisdiccion: it.jurisdiccion || "",
    apertura: it.apertura || "",
    url: it.url,
    fuente: it.fuente || "",
  };
  if (snap.exists) await ref.update(data);
  else { await ref.set({ ...data, preview: false, createdAt: FieldValue.serverTimestamp() }); nuevas++; }
}

if (cerrarVencidas) {
  const hoy = new Date().toISOString().slice(0, 10);
  const todas = await db.collection("licitaciones").get();
  let borradas = 0;
  for (const d of todas.docs) {
    const ap = d.data().apertura;
    if (/^\d{4}-\d{2}-\d{2}$/.test(ap || "") && ap < hoy) { await d.ref.delete(); borradas++; }
  }
  console.log(`Vencidas borradas: ${borradas}`);
}

// Recalcular la muestra gratis y el total.
const todas = await db.collection("licitaciones").orderBy("createdAt", "desc").get();
const batch = db.batch();
todas.docs.forEach((d, i) => {
  const preview = i < PREVIEW_COUNT;
  if (d.data().preview !== preview) batch.update(d.ref, { preview });
});
batch.set(db.doc("stats/licitaciones"), { total: todas.size, actualizado: FieldValue.serverTimestamp() });
await batch.commit();

console.log(`Listo: ${nuevas} nuevas, ${todas.size} en total, ${Math.min(PREVIEW_COUNT, todas.size)} en la muestra gratis.`);
