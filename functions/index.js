/**
 * Cloud Functions de TradeX.
 *
 *  - crearSuscripcion (callable): arma el checkout de Mercado Pago.
 *      plan "destacado"   -> suscripción (preapproval) mensual o anual
 *      plan "verificacion" -> pago único (preference)
 *  - mpWebhook (https): Mercado Pago avisa acá cada cambio. Se vuelve a
 *      consultar la API de MP con el access token (nunca se confía en el
 *      cuerpo del aviso) y recién ahí se cambia el plan en Firestore.
 *  - reporteMensual (programada, día 1 a las 9 hs): guarda el reporte del
 *      mes anterior de cada cuenta paga, lo manda por mail y marca qué
 *      Destacados entran en la garantía de 30 días.
 *  - avisoNuevaRfq (trigger): cuando se publica un requerimiento, avisa
 *      por mail a los proveedores Destacados.
 *
 * Requiere el plan Blaze de Firebase. Configuración y deploy: ver
 * docs/GUIA-MONETIZACION.md.
 */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret, defineInt, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;

/* ---------- configuración ---------- */
const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET = defineSecret("MP_WEBHOOK_SECRET");
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// Mercado Pago Argentina cobra suscripciones en pesos. Los precios se
// publican en dólares; acá van los montos en ARS que efectivamente se cobran.
// Se piden al hacer el deploy y se cambian con un nuevo deploy.
const PRECIO_DESTACADO_MENSUAL_ARS = defineInt("PRECIO_DESTACADO_MENSUAL_ARS");
const PRECIO_DESTACADO_ANUAL_ARS = defineInt("PRECIO_DESTACADO_ANUAL_ARS");
const PRECIO_VERIFICACION_ARS = defineInt("PRECIO_VERIFICACION_ARS");
const SITE_URL = defineString("SITE_URL", { default: "https://tradexcorp.netlify.app/" });
const EMAIL_FROM = defineString("EMAIL_FROM", { default: "TradeX <onboarding@resend.dev>" });

const PAID_PLANS = ["destacado", "porcotizacion", "enterprise", "pro"];
const GUARANTEE_DAYS = 30;
const DAY_MS = 86400000;

/* ---------- helpers ---------- */
function previousMonthKey(now) {
  const ar = new Date(now.getTime() - 3 * 3600 * 1000);
  const d = new Date(Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth() - 1, 15));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function siteUrl(path) {
  return SITE_URL.value().replace(/\/?$/, "/") + (path || "");
}

async function mpFetch(path, options) {
  const res = await fetch("https://api.mercadopago.com" + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + MP_ACCESS_TOKEN.value(),
      "Content-Type": "application/json",
      ...(options && options.headers),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
  if (!res.ok) {
    logger.error("Mercado Pago respondió con error", { path, status: res.status, body });
    throw new Error("Mercado Pago " + res.status);
  }
  return body;
}

async function sendEmail(to, subject, html) {
  if (!to) return false;
  const key = RESEND_API_KEY.value();
  if (!key || key === "-") return false; // mails desactivados
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: EMAIL_FROM.value(), to: [to], subject, html }),
  });
  if (!res.ok) {
    logger.warn("No se pudo mandar el mail", { to, status: res.status, body: await res.text() });
    return false;
  }
  return true;
}

async function contactEmailOf(companyId) {
  const snap = await db.doc(`companies/${companyId}/private/contact`).get();
  return snap.exists ? (snap.data().email || null) : null;
}

function emailLayout(title, bodyHtml) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2B2640;">
    <h2 style="font-size:20px;margin:0 0 12px;">${escapeHtml(title)}</h2>
    ${bodyHtml}
    <p style="font-size:12px;color:#9C96AE;margin-top:28px;">TradeX · La red B2B de empresas y proveedores verificados.<br>
    Si no querés recibir estos mails, respondé este correo y te damos de baja.</p>
  </div>`;
}

/* ---------- 1. Checkout ---------- */
exports.crearSuscripcion = onCall(
  { secrets: [MP_ACCESS_TOKEN] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión para contratar un plan.");
    const uid = request.auth.uid;
    const email = request.auth.token.email;
    const plan = request.data && request.data.plan;
    const billing = request.data && request.data.billing === "anual" ? "anual" : "mensual";
    if (!email) throw new HttpsError("failed-precondition", "Tu cuenta no tiene un email asociado.");

    const company = await db.doc(`companies/${uid}`).get();
    if (!company.exists) throw new HttpsError("failed-precondition", "Tu cuenta no tiene un perfil de empresa.");
    const name = company.data().name || "Tu empresa";

    if (plan === "destacado") {
      if (company.data().plan === "destacado") {
        throw new HttpsError("already-exists", "Ya tenés el plan Destacado activo.");
      }
      const amount = billing === "anual" ? PRECIO_DESTACADO_ANUAL_ARS.value() : PRECIO_DESTACADO_MENSUAL_ARS.value();
      const body = await mpFetch("/preapproval", {
        method: "POST",
        body: JSON.stringify({
          reason: `TradeX Destacado (${billing}) — ${name}`.slice(0, 250),
          external_reference: [uid, "destacado", billing].join("|"),
          payer_email: email,
          back_url: siteUrl("?pago=ok"),
          status: "pending",
          auto_recurring: {
            frequency: billing === "anual" ? 12 : 1,
            frequency_type: "months",
            transaction_amount: amount,
            currency_id: "ARS",
          },
        }),
      });
      await db.collection("payments").add({
        uid, kind: "preapproval", plan, billing, mpId: body.id, status: body.status || "pending",
        createdAt: FieldValue.serverTimestamp(),
      });
      return { url: body.init_point };
    }

    if (plan === "verificacion") {
      const body = await mpFetch("/checkout/preferences", {
        method: "POST",
        body: JSON.stringify({
          items: [{
            title: "TradeX — Verificación & compliance (12 meses)",
            quantity: 1,
            unit_price: PRECIO_VERIFICACION_ARS.value(),
            currency_id: "ARS",
          }],
          payer: { email },
          external_reference: [uid, "verificacion"].join("|"),
          back_urls: {
            success: siteUrl("?pago=ok"),
            pending: siteUrl("?pago=pendiente"),
            failure: siteUrl("?pago=error"),
          },
          auto_return: "approved",
        }),
      });
      return { url: body.init_point };
    }

    throw new HttpsError("invalid-argument", "Ese plan no se cobra online. Escribinos y lo activamos.");
  }
);

/* ---------- 2. Webhook de Mercado Pago ----------
   Configurá en Mercado Pago -> Tus integraciones -> Webhooks la URL de esta
   función, con los eventos "Planes y suscripciones" y "Pagos". */
function validSignature(req, dataId) {
  const secret = MP_WEBHOOK_SECRET.value();
  if (!secret || secret === "-") return true; // sin secreto configurado: se confía en la re-consulta a la API
  const header = req.get("x-signature") || "";
  const requestId = req.get("x-request-id") || "";
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=")));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch (e) {
    return false;
  }
}

async function applyPreapproval(pre) {
  const [uid, plan, billing] = String(pre.external_reference || "").split("|");
  if (!uid || plan !== "destacado") {
    logger.warn("Preapproval sin referencia válida", { id: pre.id, ref: pre.external_reference });
    return;
  }
  const ref = db.doc(`companies/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) return;
  const current = snap.data();

  if (pre.status === "authorized") {
    const update = {
      plan: "destacado",
      planBilling: billing || "mensual",
      mpPreapprovalId: pre.id,
      planUntil: FieldValue.delete(),
    };
    // planSince marca el arranque de la garantía de 30 días: solo se pone
    // la primera vez que se activa (no en cada renovación).
    if (current.plan !== "destacado" || !current.planSince) update.planSince = FieldValue.serverTimestamp();
    await ref.update(update);
    logger.info("Plan Destacado activado", { uid, billing });
  } else if ((pre.status === "cancelled" || pre.status === "paused") && current.mpPreapprovalId === pre.id) {
    await ref.update({ plan: "gratis", planUntil: FieldValue.serverTimestamp() });
    logger.info("Plan Destacado dado de baja", { uid, status: pre.status });
  }
  await db.collection("payments").add({
    uid, kind: "preapproval_update", mpId: pre.id, status: pre.status,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function applyPayment(pay) {
  const [uid, kind] = String(pay.external_reference || "").split("|");
  if (!uid) return;
  await db.collection("payments").add({
    uid, kind: "payment", product: kind || null, mpId: pay.id, status: pay.status,
    amount: pay.transaction_amount || null, currency: pay.currency_id || null,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (kind === "verificacion" && pay.status === "approved") {
    await db.doc(`companies/${uid}`).update({ verificacionPagada: true });
    // El badge "verificada" lo sigue poniendo el equipo después de revisar
    // la documentación. Esto deja la tarea en la cola.
    await db.collection("verificaciones").doc(uid).set({
      uid, status: "pendiente_documentacion", mpPaymentId: pay.id,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}

exports.mpWebhook = onRequest(
  { secrets: [MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET] },
  async (req, res) => {
    try {
      const type = req.body.type || req.query.type || req.body.topic || req.query.topic;
      const dataId = (req.body.data && req.body.data.id) || req.query["data.id"] || req.query.id;
      if (!type || !dataId) { res.status(200).send("ignorado"); return; }
      if (!validSignature(req, req.query["data.id"] || dataId)) {
        logger.warn("Firma de webhook inválida", { type, dataId });
        res.status(401).send("firma inválida");
        return;
      }
      if (type === "subscription_preapproval" || type === "preapproval") {
        await applyPreapproval(await mpFetch(`/preapproval/${encodeURIComponent(dataId)}`));
      } else if (type === "payment") {
        await applyPayment(await mpFetch(`/v1/payments/${encodeURIComponent(dataId)}`));
      } else if (type === "subscription_authorized_payment") {
        // Cobro recurrente de una suscripción: se registra para el historial.
        const ap = await mpFetch(`/authorized_payments/${encodeURIComponent(dataId)}`);
        if (ap.preapproval_id) {
          await applyPreapproval(await mpFetch(`/preapproval/${encodeURIComponent(ap.preapproval_id)}`));
        }
      }
      res.status(200).send("ok");
    } catch (err) {
      logger.error("Error procesando webhook", err);
      res.status(500).send("error"); // Mercado Pago reintenta
    }
  }
);

/* ---------- 3. Reporte mensual + garantía ---------- */
exports.reporteMensual = onSchedule(
  { schedule: "0 9 1 * *", timeZone: "America/Argentina/Buenos_Aires", secrets: [RESEND_API_KEY] },
  async () => {
    const now = new Date();
    const month = previousMonthKey(now);
    const paid = await db.collection("companies").where("plan", "in", PAID_PLANS).get();
    logger.info(`Reporte ${month}: ${paid.size} cuentas pagas`);

    for (const companyDoc of paid.docs) {
      const id = companyDoc.id;
      const c = companyDoc.data();
      try {
        const [pv, cv, qs] = await Promise.all([
          db.collection("profileViews").where("companyId", "==", id).where("month", "==", month).get(),
          db.collection("contactViews").where("companyId", "==", id).where("month", "==", month).get(),
          db.collection("quotes").where("supplierId", "==", id).where("month", "==", month).get(),
        ]);
        const buyers = pv.docs.filter((d) => d.data().viewerType === "empresa").length;
        const report = {
          month, profileViews: pv.size, buyerViews: buyers, contactViews: cv.size, quotesSent: qs.size,
          createdAt: FieldValue.serverTimestamp(),
        };
        await db.doc(`companies/${id}/reports/${month}`).set(report);

        const viewers = pv.docs.slice(0, 10).map((d) => escapeHtml(d.data().viewerName || "Empresa")).join(", ");
        const html = emailLayout(`Tu mes en TradeX (${month})`, `
          <p>Hola, este es el resumen de <b>${escapeHtml(c.name)}</b>:</p>
          <ul style="line-height:1.8;">
            <li><b>${pv.size}</b> empresas vieron tu perfil (${buyers} compradoras)</li>
            <li><b>${cv.size}</b> vieron tu contacto</li>
            <li><b>${qs.size}</b> cotizaciones enviadas</li>
          </ul>
          ${viewers ? `<p>Te miraron, entre otras: ${viewers}.</p>` : ""}
          <p><a href="${siteUrl("")}" style="color:#4256CC;font-weight:bold;">Ver mi panel en TradeX</a></p>`);
        await sendEmail(await contactEmailOf(id), `Tu reporte de ${month} en TradeX`, html);
      } catch (err) {
        logger.error("Falló el reporte de una empresa", { id, err: String(err) });
      }

      // Garantía: Destacados que cumplieron 30 días sin ninguna vista de contacto.
      if (c.plan === "destacado" && c.planSince && !c.garantiaRevisada) {
        const since = c.planSince.toDate();
        const days = (now - since) / DAY_MS;
        if (days >= GUARANTEE_DAYS) {
          const end = new Date(since.getTime() + GUARANTEE_DAYS * DAY_MS);
          const cvAll = await db.collection("contactViews").where("companyId", "==", id).get();
          const inWindow = cvAll.docs.filter((d) => {
            const t = d.data().createdAt;
            return t && t.toDate() >= since && t.toDate() < end;
          }).length;
          await db.doc(`companies/${id}`).update({ garantiaRevisada: true });
          if (inWindow === 0) {
            await db.collection("garantias").doc(id).set({
              uid: id, name: c.name || "", status: "aplica", planSince: c.planSince,
              createdAt: FieldValue.serverTimestamp(),
            });
            logger.info("Garantía aplica: bonificar el próximo mes en Mercado Pago", { id });
          }
        }
      }
    }
  }
);

/* ---------- 4. Aviso de nuevo requerimiento a Destacados ---------- */
exports.avisoNuevaRfq = onDocumentCreated(
  { document: "rfqs/{rfqId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const rfq = event.data && event.data.data();
    if (!rfq) return;
    const destacados = await db.collection("companies").where("plan", "==", "destacado").get();
    const html = emailLayout("Nuevo requerimiento en TradeX", `
      <p><b>${escapeHtml(rfq.buyerName || "Una empresa de la red")}</b> publicó un requerimiento:</p>
      <p style="font-size:17px;"><b>${escapeHtml(rfq.title)}</b></p>
      <p>Categoría: ${escapeHtml(rfq.category)} · Ubicación: ${escapeHtml(rfq.location)} · Entrega: ${escapeHtml(rfq.deadline)} · Presupuesto: ${escapeHtml(rfq.budget)}</p>
      <p><a href="${siteUrl("")}" style="color:#4256CC;font-weight:bold;">Cotizar en TradeX</a></p>`);
    let sent = 0;
    for (const d of destacados.docs) {
      if (d.id === rfq.buyerId) continue;
      if (await sendEmail(await contactEmailOf(d.id), `Nuevo requerimiento: ${rfq.title}`.slice(0, 120), html)) sent++;
    }
    logger.info(`Aviso de RFQ enviado a ${sent} Destacados`, { rfqId: event.params.rfqId });
  }
);
