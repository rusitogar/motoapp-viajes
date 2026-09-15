// Robot de notificaciones push de MotoApp Viajes.
//
// Corre en GitHub Actions cada ~5 min (ver .github/workflows/avisos.yml).
// La app NO manda notificaciones: sólo guarda su token en Usuarios/{uid}.FCM_Token.
// Acá se decide a quién avisar y se envía con la cuenta de servicio de Firebase.
//
// Trabajos:
//   A) "un favorito creó un viaje"     -> Viaje con Notificado_Favoritos == false
//   B) "se detuvo" / "SOS"             -> viajes_en_ruta en Realtime Database
//   C) limpiar solicitudes huérfanas   -> SolicitudesViaje de viajes borrados
//   D) procesar bajas de cuenta        -> BajasCuenta
//   E) "alguien quiere sumarse a tu viaje" -> SolicitudesViaje con Notificado_Push == false
//   F) "te sumaron a un viaje"         -> SolicitudesViaje con Estado=='aceptada' && Notificado_Push_Resultado == false
//   G) "tenés una respuesta de Soporte" -> Soporte con Estado=='resuelto' && Notificado_Push_Soporte == false
//   H) mail al admin por cada caso de Soporte nuevo -> Soporte con Notificado_Mail_Admin == false

import admin from 'firebase-admin';
import nodemailer from 'nodemailer';

const cuenta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(cuenta),
  databaseURL: 'https://app-viaje-moto-default-rtdb.firebaseio.com',
});

const db = admin.firestore();
const rtdb = admin.database();
const ADMIN_EMAIL = 'rusitogar@gmail.com';
const mailer = process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: ADMIN_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
    })
  : null;
const fcm = admin.messaging();

const UMBRAL_DETENIDO_MS = 10 * 60 * 1000; // 10 minutos

/** Envía una notificación a una lista de tokens y limpia los que ya no sirven. */
async function enviar(tokens, notification, data) {
  const validos = [...new Set(tokens.filter(Boolean))];
  if (validos.length === 0) return;

  const res = await fcm.sendEachForMulticast({
    tokens: validos,
    notification,
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)]),
    ),
    android: { priority: 'high', notification: { channelId: 'push_avisos' } },
  });

  const muertos = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (
      !r.success &&
      (code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-argument')
    ) {
      muertos.push(validos[i]);
    }
  });
  if (muertos.length) {
    const q = await db
      .collection('Usuarios')
      .where('FCM_Token', 'in', muertos.slice(0, 30))
      .get();
    await Promise.all(
      q.docs.map((d) => d.ref.update({ FCM_Token: admin.firestore.FieldValue.delete() })),
    );
  }
  console.log(`  enviadas ${res.successCount}/${validos.length}`);
}

function primerNombre(u) {
  const s = (u && (u.Apodo || u.Nombre)) || '';
  return s.trim().split(/\s+/)[0] || 'Un amigo';
}

// ---------------------------------------------------------------------------
// A) Viajes nuevos de favoritos
// ---------------------------------------------------------------------------
async function avisarViajesNuevos() {
  const snap = await db
    .collection('Viaje')
    .where('Notificado_Favoritos', '==', false)
    .limit(20)
    .get();
  if (snap.empty) return;
  console.log(`A) ${snap.size} viaje(s) nuevo(s)`);

  for (const doc of snap.docs) {
    const v = doc.data();
    const orgId = v.Organizador_ID;
    try {
      if (!orgId) continue;
      const orgDoc = await db.collection('Usuarios').doc(orgId).get();
      const nombre = primerNombre(orgDoc.data());

      const favs = await db
        .collection('Usuarios')
        .where('Favoritos', 'array-contains', orgId)
        .get();

      const miembros = new Set(v.Miembros || []);
      const tokens = favs.docs
        .filter((d) => d.id !== orgId && !miembros.has(d.id))
        .map((d) => d.data().FCM_Token);

      await enviar(
        tokens,
        {
          title: `${nombre} creó un viaje`,
          body: `"${v.Nombre || 'Nuevo viaje'}" — miralo y sumate si querés.`,
        },
        { tipo: 'viaje_favorito', viajeId: doc.id },
      );
    } catch (e) {
      console.log(`  error en viaje ${doc.id}: ${e.message}`);
    } finally {
      await doc.ref.update({ Notificado_Favoritos: true });
    }
  }
}

// ---------------------------------------------------------------------------
// B) "se detuvo" / SOS
// ---------------------------------------------------------------------------
async function avisarDetenidos() {
  const rutas = (await rtdb.ref('viajes_en_ruta').get()).val();
  if (!rutas) return;
  const ahora = Date.now();
  console.log(`B) ${Object.keys(rutas).length} viaje(s) en ruta`);

  for (const [viajeId, riders] of Object.entries(rutas)) {
    if (!riders || typeof riders !== 'object') continue;
    const avisadoRef = rtdb.ref(`avisos_ruta/${viajeId}`);
    const avisado = (await avisadoRef.get()).val() || {};

    for (const [uid, r] of Object.entries(riders)) {
      if (!r || typeof r !== 'object') continue;

      let estado = null;
      if (r.sos) estado = 'sos';
      else if (r.pausado) estado = null;
      else if (r.detenidoDesde && ahora - r.detenidoDesde >= UMBRAL_DETENIDO_MS) {
        estado = 'detenido';
      }

      if (!estado) {
        if (avisado[uid]) await avisadoRef.child(uid).remove();
        continue;
      }
      if (avisado[uid] === estado) continue;

      try {
        const vDoc = await db.collection('Viaje').doc(viajeId).get();
        const miembros = (vDoc.data() && vDoc.data().Miembros ? vDoc.data().Miembros : [])
          .filter((m) => m !== uid);
        if (miembros.length === 0) continue;

        const usuarios = await db.getAll(
          ...miembros.map((m) => db.collection('Usuarios').doc(m)),
        );
        const tokens = usuarios.map((u) => u.data() && u.data().FCM_Token);

        const apodo = r.apodo || 'Un rider';
        const mins = r.detenidoDesde
          ? Math.round((ahora - r.detenidoDesde) / 60000)
          : 0;

        await enviar(
          tokens,
          estado === 'sos'
            ? {
                title: `${apodo}: SOS`,
                body: `${apodo} pidió ayuda. Abrí el viaje para ver su ubicación.`,
              }
            : {
                title: `${apodo} se detuvo`,
                body: `Hace ${mins} min que ${apodo} no se mueve.`,
              },
          { tipo: `rider_${estado}`, viajeId },
        );
        await avisadoRef.child(uid).set(estado);
      } catch (e) {
        console.log(`  error en rider ${uid}: ${e.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// C) Limpiar solicitudes de viajes que ya no existen
// ---------------------------------------------------------------------------
async function limpiarSolicitudesHuerfanas() {
  const snap = await db
    .collection('SolicitudesViaje')
    .where('Estado', '==', 'pendiente')
    .limit(50)
    .get();
  if (snap.empty) return;
  for (const doc of snap.docs) {
    const viajeId = doc.data().Viaje_ID;
    if (!viajeId) {
      await doc.ref.delete();
      continue;
    }
    const v = await db.collection('Viaje').doc(viajeId).get();
    if (!v.exists) {
      await doc.ref.delete();
      console.log(`C) solicitud huérfana borrada (viaje ${viajeId})`);
    }
  }
}

// ---------------------------------------------------------------------------
// D) Procesar bajas de cuenta (borra TODO lo del usuario)
// ---------------------------------------------------------------------------
async function procesarBajas() {
  const snap = await db.collection('BajasCuenta').limit(10).get();
  if (snap.empty) return;
  console.log(`D) ${snap.size} baja(s) de cuenta`);

  for (const doc of snap.docs) {
    const uid = doc.id;
    try {
      // Viajes que organiza -> borrar (con sus solicitudes y nodos de ruta)
      const orgViajes = await db
        .collection('Viaje')
        .where('Organizador_ID', '==', uid)
        .get();
      for (const v of orgViajes.docs) {
        const sols = await db
          .collection('SolicitudesViaje')
          .where('Viaje_ID', '==', v.id)
          .get();
        await Promise.all(sols.docs.map((s) => s.ref.delete()));
        await rtdb.ref(`viajes_en_ruta/${v.id}`).remove();
        await rtdb.ref(`avisos_ruta/${v.id}`).remove();
        await v.ref.delete();
      }

      // Viajes donde es miembro -> sacarlo
      const memberViajes = await db
        .collection('Viaje')
        .where('Miembros', 'array-contains', uid)
        .get();
      await Promise.all(
        memberViajes.docs.map((v) =>
          v.ref.update({
            Miembros: admin.firestore.FieldValue.arrayRemove(uid),
          }),
        ),
      );

      // Sacarlo de Amigos / Favoritos de todas las cuentas
      for (const campo of ['Amigos', 'Favoritos']) {
        const q = await db
          .collection('Usuarios')
          .where(campo, 'array-contains', uid)
          .get();
        await Promise.all(
          q.docs.map((u) =>
            u.ref.update({
              [campo]: admin.firestore.FieldValue.arrayRemove(uid),
            }),
          ),
        );
      }

      // Sus solicitudes, historial y mensajes de soporte
      for (const [col, campo] of [
        ['SolicitudesViaje', 'Solicitante_ID'],
        ['HistorialViajes', 'Usuario_ID'],
        ['Soporte', 'Usuario_ID'],
      ]) {
        const q = await db.collection(col).where(campo, '==', uid).get();
        await Promise.all(q.docs.map((d) => d.ref.delete()));
      }

      // Su doc de usuario + subcolección de notificaciones
      const notis = await db
        .collection('Usuarios')
        .doc(uid)
        .collection('Notificaciones')
        .get();
      await Promise.all(notis.docs.map((n) => n.ref.delete()));
      await db.collection('Usuarios').doc(uid).delete();

      // La cuenta de Auth (si el cliente no llegó a borrarla)
      try {
        await admin.auth().deleteUser(uid);
      } catch (e) {
        // ya no existe
      }

      await doc.ref.delete();
      console.log(`   baja completa: ${uid}`);
    } catch (e) {
      console.log(`   error en baja ${uid}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// E) Alguien pidió sumarse a un viaje
// ---------------------------------------------------------------------------
async function avisarSolicitudesNuevas() {
  const snap = await db
    .collection('SolicitudesViaje')
    .where('Estado', '==', 'pendiente')
    .where('Notificado_Push', '==', false)
    .limit(20)
    .get();
  if (snap.empty) return;
  console.log(`E) ${snap.size} solicitud(es) nueva(s)`);

  for (const doc of snap.docs) {
    const s = doc.data();
    try {
      const orgId = s.Organizador_ID;
      if (!orgId) continue;
      const orgDoc = await db.collection('Usuarios').doc(orgId).get();
      const token = orgDoc.data() && orgDoc.data().FCM_Token;
      const quien = s.Solicitante_Nombre || 'Alguien';

      await enviar(
        [token],
        {
          title: `${quien} quiere sumarse a tu viaje`,
          body: `"${s.Viaje_Nombre || 'tu viaje'}" — abrí la app para aceptarlo o rechazarlo.`,
        },
        { tipo: 'solicitud_nueva', viajeId: s.Viaje_ID },
      );
    } catch (e) {
      console.log(`  error en solicitud ${doc.id}: ${e.message}`);
    } finally {
      await doc.ref.update({ Notificado_Push: true });
    }
  }
}

// ---------------------------------------------------------------------------
// F) Te aceptaron en un viaje
// ---------------------------------------------------------------------------
async function avisarSolicitudesAceptadas() {
  const snap = await db
    .collection('SolicitudesViaje')
    .where('Estado', '==', 'aceptada')
    .where('Notificado_Push_Resultado', '==', false)
    .limit(20)
    .get();
  if (snap.empty) return;
  console.log(`F) ${snap.size} solicitud(es) aceptada(s)`);

  for (const doc of snap.docs) {
    const s = doc.data();
    try {
      const solicitanteId = s.Solicitante_ID;
      if (!solicitanteId) continue;
      const uDoc = await db.collection('Usuarios').doc(solicitanteId).get();
      const token = uDoc.data() && uDoc.data().FCM_Token;

      await enviar(
        [token],
        {
          title: 'Te sumaron a un viaje',
          body: `"${s.Viaje_Nombre || 'El viaje'}" ya es tuyo — mirá los detalles.`,
        },
        { tipo: 'solicitud_aceptada', viajeId: s.Viaje_ID },
      );
    } catch (e) {
      console.log(`  error en solicitud ${doc.id}: ${e.message}`);
    } finally {
      await doc.ref.update({ Notificado_Push_Resultado: true });
    }
  }
}

// ---------------------------------------------------------------------------
// G) Respuesta de Soporte
// ---------------------------------------------------------------------------
async function avisarRespuestasSoporte() {
  const snap = await db
    .collection('Soporte')
    .where('Estado', '==', 'resuelto')
    .where('Notificado_Push_Soporte', '==', false)
    .limit(20)
    .get();
  if (snap.empty) return;
  console.log(`G) ${snap.size} respuesta(s) de soporte`);

  for (const doc of snap.docs) {
    const s = doc.data();
    try {
      const uid = s.Usuario_ID;
      if (!uid) continue;
      const uDoc = await db.collection('Usuarios').doc(uid).get();
      const token = uDoc.data() && uDoc.data().FCM_Token;

      await enviar(
        [token],
        {
          title: 'Tenés una respuesta de Soporte',
          body: s.Numero
            ? `Caso #${s.Numero} — abrí la app para verla.`
            : 'Abrí la app para verla.',
        },
        { tipo: 'soporte_respuesta' },
      );
    } catch (e) {
      console.log(`  error en caso ${doc.id}: ${e.message}`);
    } finally {
      await doc.ref.update({ Notificado_Push_Soporte: true });
    }
  }
}

// ---------------------------------------------------------------------------
// H) Mail al admin por cada caso de Soporte nuevo
// ---------------------------------------------------------------------------
async function avisarSoporteNuevoPorMail() {
  const snap = await db
    .collection('Soporte')
    .where('Notificado_Mail_Admin', '==', false)
    .limit(20)
    .get();
  if (snap.empty) return;

  if (!mailer) {
    console.log(`H) ${snap.size} caso(s) nuevo(s) de Soporte, pero falta el secret GMAIL_APP_PASSWORD — no se manda mail.`);
    return;
  }
  console.log(`H) ${snap.size} caso(s) nuevo(s) de Soporte -> mail`);

  for (const doc of snap.docs) {
    const s = doc.data();
    try {
      await mailer.sendMail({
        from: `MotoApp Viajes <${ADMIN_EMAIL}>`,
        to: ADMIN_EMAIL,
        replyTo: s.Email || undefined,
        subject: `Soporte — caso #${s.Numero || doc.id} de ${s.Nombre || 'un usuario'}`,
        text:
          `${s.Nombre || 'Alguien'} (${s.Email || 's/email'}) escribió desde la app ` +
          `(versión ${s.Version_App || '?'}):\n\n${s.Mensaje || ''}\n\n` +
          `Responder desde el panel: https://motoapp-admin.web.app`,
      });
    } catch (e) {
      console.log(`  error mail caso ${doc.id}: ${e.message}`);
    } finally {
      await doc.ref.update({ Notificado_Mail_Admin: true });
    }
  }
}

try {
  await avisarViajesNuevos();
  await avisarDetenidos();
  await avisarSolicitudesNuevas();
  await avisarSolicitudesAceptadas();
  await avisarRespuestasSoporte();
  await avisarSoporteNuevoPorMail();
  await limpiarSolicitudesHuerfanas();
  await procesarBajas();
  console.log('OK');
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
