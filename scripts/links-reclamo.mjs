/**
 * Genera un CSV con las fichas armadas desde fuentes públicas que todavía
 * no fueron reclamadas, con el link directo para el mail de "Reclamá tu
 * perfil" (ver docs/email-reclamo-perfil.md).
 *
 * Uso (desde la carpeta scripts/):
 *   npm install
 *   set GOOGLE_APPLICATION_CREDENTIALS=C:\ruta\a\cuenta-de-servicio.json
 *   node links-reclamo.mjs > links-reclamo.csv
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const SITE_URL = "https://tradexcorp.netlify.app/";
initializeApp({ credential: applicationDefault(), projectId: "tradex-corp-cd4a3" });
const db = getFirestore();

const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const snap = await db.collection("companies").get();
console.log(["empresa", "categoria", "sector", "ubicacion", "fuente", "link_reclamo"].join(","));
for (const d of snap.docs) {
  const c = d.data();
  if (c.selfRegistered || c.claimedBy) continue;
  console.log([
    csv(c.name), csv(c.vinculo), csv(c.sector), csv(c.ubicacion), csv(c.fuente),
    csv(`${SITE_URL}#reclamar=${encodeURIComponent(d.id)}`),
  ].join(","));
}
