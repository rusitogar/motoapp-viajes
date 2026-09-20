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
//   I) sembrar los viajes prearmados de ViajesPrearmados (uno por uno, sólo si no existen; no pisa lo que ya haya)
//   J) sincronizar config/auspiciantes.Auspiciantes (carrusel de Inicio: imagen + link de cada uno)
//   K) config/estadisticas.Usuarios_Registrados, para la landing -> 1 vez por día (no en cada corrida)

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
  return s.trim().split(/\s+/)[0] || '';
}

// --- Idiomas de los avisos -------------------------------------------------
// Cada persona guarda su idioma en Usuarios/{uid}.Idioma ('es' | 'en' | 'pt').
// Las cuentas que todavía no lo guardaron (versiones viejas) reciben español.
const IDIOMAS = ['es', 'en', 'pt'];
const idiomaDe = (u) => (u && IDIOMAS.includes(u.Idioma) ? u.Idioma : 'es');

/** destinatarios: [{ token, idioma }]. Manda a cada grupo de idioma su texto. */
async function enviarPorIdioma(destinatarios, armar, data) {
  const grupos = {};
  for (const d of destinatarios) {
    if (!d.token) continue;
    (grupos[d.idioma] = grupos[d.idioma] || []).push(d.token);
  }
  for (const [idioma, tokens] of Object.entries(grupos)) {
    await enviar(tokens, armar(idioma), data);
  }
}

const TEXTOS = {
  viajeNuevo: {
    es: (n, v) => ({ title: `${n || 'Un amigo'} creó un viaje`, body: `"${v || 'Nuevo viaje'}" — miralo y sumate si querés.` }),
    en: (n, v) => ({ title: `${n || 'A friend'} created a trip`, body: `"${v || 'New trip'}" — check it out and join if you like.` }),
    pt: (n, v) => ({ title: `${n || 'Um amigo'} criou uma viagem`, body: `"${v || 'Nova viagem'}" — dê uma olhada e participe se quiser.` }),
  },
  sos: {
    es: (a) => ({ title: `${a || 'Un rider'}: SOS`, body: `${a || 'Un rider'} pidió ayuda. Abrí el viaje para ver su ubicación.` }),
    en: (a) => ({ title: `${a || 'A rider'}: SOS`, body: `${a || 'A rider'} asked for help. Open the trip to see their location.` }),
    pt: (a) => ({ title: `${a || 'Um piloto'}: SOS`, body: `${a || 'Um piloto'} pediu ajuda. Abra a viagem para ver a localização.` }),
  },
  detenido: {
    es: (a, m) => ({ title: `${a || 'Un rider'} se detuvo`, body: `Hace ${m} min que ${a || 'Un rider'} no se mueve.` }),
    en: (a, m) => ({ title: `${a || 'A rider'} stopped`, body: `${a || 'A rider'} hasn't moved for ${m} min.` }),
    pt: (a, m) => ({ title: `${a || 'Um piloto'} parou`, body: `${a || 'Um piloto'} está parado há ${m} min.` }),
  },
  solicitudNueva: {
    es: (q, v) => ({ title: `${q || 'Alguien'} quiere sumarse a tu viaje`, body: `"${v || 'tu viaje'}" — abrí la app para aceptarlo o rechazarlo.` }),
    en: (q, v) => ({ title: `${q || 'Someone'} wants to join your trip`, body: `"${v || 'your trip'}" — open the app to accept or decline.` }),
    pt: (q, v) => ({ title: `${q || 'Alguém'} quer participar da sua viagem`, body: `"${v || 'sua viagem'}" — abra o app para aceitar ou recusar.` }),
  },
  aceptada: {
    es: (v) => ({ title: 'Te sumaron a un viaje', body: `"${v || 'El viaje'}" ya es tuyo — mirá los detalles.` }),
    en: (v) => ({ title: 'You were added to a trip', body: `"${v || 'The trip'}" is now yours — check the details.` }),
    pt: (v) => ({ title: 'Você foi adicionado a uma viagem', body: `"${v || 'A viagem'}" já é sua — veja os detalhes.` }),
  },
  soporte: {
    es: (n) => ({ title: 'Tenés una respuesta de Soporte', body: n ? `Caso #${n} — abrí la app para verla.` : 'Abrí la app para verla.' }),
    en: (n) => ({ title: 'You have a reply from Support', body: n ? `Case #${n} — open the app to read it.` : 'Open the app to read it.' }),
    pt: (n) => ({ title: 'Você tem uma resposta do Suporte', body: n ? `Caso #${n} — abra o app para ver.` : 'Abra o app para ver.' }),
  },
};

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
      const destinatarios = favs.docs
        .filter((d) => d.id !== orgId && !miembros.has(d.id))
        .map((d) => ({ token: d.data().FCM_Token, idioma: idiomaDe(d.data()) }));

      await enviarPorIdioma(
        destinatarios,
        (l) => TEXTOS.viajeNuevo[l](nombre, v.Nombre),
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
        const destinatarios = usuarios.map((u) => ({
          token: u.data() && u.data().FCM_Token,
          idioma: idiomaDe(u.data()),
        }));

        const apodo = r.apodo || '';
        const mins = r.detenidoDesde
          ? Math.round((ahora - r.detenidoDesde) / 60000)
          : 0;

        await enviarPorIdioma(
          destinatarios,
          (l) => (estado === 'sos' ? TEXTOS.sos[l](apodo) : TEXTOS.detenido[l](apodo, mins)),
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
      // Su última posición y su aviso en los viajes ajenos (Realtime Database)
      for (const v of memberViajes.docs) {
        await rtdb.ref(`viajes_en_ruta/${v.id}/${uid}`).remove();
        await rtdb.ref(`avisos_ruta/${v.id}/${uid}`).remove();
      }
      // Su foto de perfil (Storage)
      try {
        await admin
          .storage()
          .bucket('app-viaje-moto.firebasestorage.app')
          .file(`fotos_perfil/${uid}/foto.jpg`)
          .delete({ ignoreNotFound: true });
      } catch (e) {
        console.log(`   no se pudo borrar la foto de ${uid}: ${e.message}`);
      }

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
      const quien = s.Solicitante_Nombre || '';

      await enviarPorIdioma(
        [{ token, idioma: idiomaDe(orgDoc.data()) }],
        (l) => TEXTOS.solicitudNueva[l](quien, s.Viaje_Nombre),
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

      await enviarPorIdioma(
        [{ token, idioma: idiomaDe(uDoc.data()) }],
        (l) => TEXTOS.aceptada[l](s.Viaje_Nombre),
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

      await enviarPorIdioma(
        [{ token, idioma: idiomaDe(uDoc.data()) }],
        (l) => TEXTOS.soporte[l](s.Numero),
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

// ---------------------------------------------------------------------------
// I) Sembrar los viajes prearmados que van sumando ("Conocé") — cada uno se
//    crea una sola vez (idempotente por id); si ya existe no se toca.
// ---------------------------------------------------------------------------
// Punto de interés de un viaje prearmado. Si se pasa `aviso`, ese punto le
// avisa al rider cuando pasa cerca en "modo ruta" (auspiciantes e imperdibles);
// si no, sólo aparece en la lista y en el mapa. `auspiciante: true` lo resalta.
const poi = (Nombre, Tipo, Lat, Lng, Descripcion, aviso = '', auspiciante = false) => ({
  Nombre,
  Tipo,
  Descripcion,
  Lat,
  Lng,
  Mensaje: aviso,
  Contacto: '',
  Auspiciante: auspiciante,
  Avisar: aviso !== '' || auspiciante,
});

const PREARMADOS = [
  {
    id: 'siete-lagos',
    Nombre: 'Ruta de los 7 Lagos',
    Descripcion:
      'El clásico recorrido patagónico entre San Martín de los Andes y ' +
      'Villa La Angostura, bordeando una cadena de lagos cordilleranos. ' +
      'Vos ponés tu punto de partida y la app arma el tramo hasta acá.',
    Dias_Sugeridos: 1,
    Foto_Url: 'https://motoappviajes.web.app/prearmados/siete-lagos.jpg',
    Origen: 'San Martín de los Andes, Neuquén',
    Origen_Lat: -40.1576,
    Origen_Lng: -71.3538,
    Destino: 'Villa La Angostura, Neuquén',
    Destino_Lat: -40.7599,
    Destino_Lng: -71.6425,
    Paradas: [
      { Nombre: 'Villa Traful, Neuquén', Lat: -40.6167, Lng: -71.4167 },
    ],
    Puntos_Interes: [
      poi('Mirador Bandurrias', 'mirador', -40.16534, -71.37407,
        'Vista al Lago Lácar, a minutos de San Martín de los Andes.'),
      poi('Mirador Arroyo Partido', 'mirador', -40.24217, -71.37265,
        'Un arroyo que se parte en dos y sigue caminos distintos.',
        'Mirador Arroyo Partido, ahí adelante: buen lugar para parar.'),
      poi('Mirador Lago Machónico', 'mirador', -40.33263, -71.41767,
        'Parada sobre el lago, con el bosque andino de fondo.'),
      poi('Cascada Vuliñanco', 'cascada', -40.43059, -71.5272,
        'Cascada a pasos de la ruta, en pleno bosque.',
        'Cascada Vuliñanco cerca: vale la pena una parada y una foto.'),
      poi('Mirador Lago Falkner', 'mirador', -40.44278, -71.53917,
        'Uno de los lagos más lindos del camino.'),
      poi('Mirador Lago Villarino', 'mirador', -40.45173, -71.57328,
        'Vista abierta al lago y a la cordillera.'),
      poi('Mirador Lago Escondido', 'mirador', -40.45962, -71.57935,
        'Un lago chico y tranquilo, sobre la ruta.'),
      poi('Cascada Ñivinco', 'cascada', -40.48783, -71.66361,
        'Desvío corto (unos 2 km) hasta la cascada.'),
      poi('Bosque Sumergido de Villa Traful', 'naturaleza', -40.65313, -71.40018,
        'Un bosque que quedó bajo el agua del Lago Traful. Se visita con excursión o buceo.',
        'Villa Traful cerca: no te pierdas el Bosque Sumergido.'),
      poi('Mirador Lago Correntoso', 'mirador', -40.61112, -71.67766,
        'Vista al lago, camino a Villa La Angostura.'),
      poi('Mirador Lago Espejo', 'mirador', -40.64254, -71.70513,
        'Aguas quietas donde se refleja el bosque.'),
      poi('Mirador Belvedere', 'mirador', -40.73444, -71.65013,
        'Vista panorámica de Villa La Angostura y el Nahuel Huapi.'),
      poi('Mirador Bahía Mansa', 'mirador', -40.78818, -71.65732,
        'Costa tranquila sobre el lago Nahuel Huapi.'),
    ],
    Activo: true,
  },
  {
    id: 'san-luis-uspallata',
    Nombre: 'San Luis – Uspallata',
    Descripcion:
      'Cruzando San Juan hacia el pie de la cordillera, con Uspallata ya ' +
      'asomando a los cerros. Vos ponés tu punto de partida y la app arma ' +
      'el tramo hasta acá.',
    Dias_Sugeridos: 2,
    Foto_Url: 'https://motoappviajes.web.app/prearmados/san-luis-uspallata.jpg',
    Origen: 'San Luis',
    Origen_Lat: -33.3017267,
    Origen_Lng: -66.3377522,
    Destino: 'Uspallata, Mendoza',
    Destino_Lat: -32.5910827,
    Destino_Lng: -69.3478836,
    Paradas: [{ Nombre: 'San Juan', Lat: -31.5351074, Lng: -68.5385941 }],
    Puntos_Interes: [
      poi('Parque Nacional Sierra de las Quijadas', 'naturaleza', -32.46794, -66.96227,
        'Cañones y paisajes rojizos en el desierto puntano; el ingreso principal es por un desvío.',
        'Sierra de las Quijadas cerca: uno de los paisajes más impactantes del camino.'),
      poi('Casa Natal de Sarmiento', 'museo', -31.53479, -68.52886,
        'En San Juan: la casa donde nació Domingo F. Sarmiento.'),
      poi('Museo Argentino de Motos Antiguas', 'museo', -32.89614, -68.83785,
        'En Mendoza: una parada obligada para motoqueros.',
        'Museo de Motos Antiguas, en Mendoza: parada obligada para motoqueros.'),
      poi('Museo del Área Fundacional', 'museo', -32.87975, -68.82796,
        'Restos de la ciudad original de Mendoza.'),
      poi('Memorial de la Bandera de los Andes', 'historico', -32.8979, -68.84634,
        'Recuerda la bandera con la que San Martín cruzó los Andes.'),
      poi('Embalse Potrerillos', 'dique', -32.96303, -69.19662,
        'Lago de montaña camino a Uspallata, ideal para una pausa.',
        'Embalse Potrerillos cerca: buen lugar para una pausa camino a Uspallata.'),
      poi('Museo Histórico Las Bóvedas', 'museo', -32.56969, -69.34052,
        'Ruinas de las antiguas bóvedas de fundición, en Uspallata.'),
      poi('Mirador de Uspallata', 'mirador', -32.59524, -69.32964,
        'Vista al valle de Uspallata y la precordillera.'),
    ],
    Activo: true,
  },
  {
    id: 'altas-cumbres',
    Nombre: 'Altas Cumbres',
    Descripcion:
      'Un circuito por tres valles cordobeses: subís por el mítico camino ' +
      'de Altas Cumbres (con parada obligada en el mirador "El Cóndor"), ' +
      'bajás a Traslasierra y volvés por Calamuchita. Vos ponés tu punto ' +
      'de partida y la app arma el tramo hasta acá.',
    Dias_Sugeridos: 1,
    Foto_Url: 'https://motoappviajes.web.app/prearmados/altas-cumbres.jpg',
    Origen: 'Villa Carlos Paz, Córdoba',
    Origen_Lat: -31.4207828,
    Origen_Lng: -64.4992141,
    Destino: 'Villa Carlos Paz, Córdoba',
    Destino_Lat: -31.4207828,
    Destino_Lng: -64.4992141,
    Paradas: [
      { Nombre: 'Mirador "El Cóndor", Altas Cumbres', Lat: -31.6098803, Lng: -64.7581217 },
      { Nombre: 'Mina Clavero, Córdoba', Lat: -31.730033, Lng: -65.0050245 },
      { Nombre: 'Villa General Belgrano, Córdoba', Lat: -31.9776652, Lng: -64.5594102 },
      { Nombre: 'Dique de Los Molinos, Córdoba', Lat: -31.818378, Lng: -64.502994 },
    ],
    Puntos_Interes: [
      poi('Cascada Pie Grande', 'cascada', -31.70835, -64.89106,
        'Cascada en Mina Clavero, entre piedras y agua.',
        'Cascadas de Mina Clavero cerca: una parada para refrescarse.'),
      poi('Cañón de los Vencejos', 'cascada', -31.70854, -64.89225,
        'Cañón y cascada muy cerca de la anterior.'),
      poi('Museo del Cura Brochero', 'museo', -31.70588, -65.01882,
        'En Villa Cura Brochero: la historia del santo Cura Brochero.'),
      poi('Estación Astrofísica de Bosque Alegre', 'observatorio', -31.59774, -64.54859,
        'Observatorio astronómico en las sierras de Córdoba.'),
      poi('Mirador de Costa Azul', 'mirador', -31.72301, -64.39396,
        'Vista al lago San Roque desde Costa Azul.'),
      poi('Estancia Jesuítica de Alta Gracia', 'historico', -31.65767, -64.43489,
        'Patrimonio de la Humanidad de la UNESCO.',
        'Alta Gracia cerca: su Estancia Jesuítica es Patrimonio de la Humanidad.'),
      poi('Museo Casa del Che Guevara', 'museo', -31.64882, -64.44154,
        'La casa donde vivió el Che Guevara de chico.'),
      poi('Museo Manuel de Falla', 'museo', -31.65142, -64.44625,
        'La casa donde vivió el compositor Manuel de Falla.'),
    ],
    Activo: true,
  },
  {
    id: 'cuyo-noroeste',
    Nombre: 'Cuyo – Noroeste Argentino',
    Descripcion:
      'El gran cruce de Cuyo al NOA: de Mendoza al valle de Jáchal, la ' +
      'Cuesta de Miranda hacia Chilecito y los cerros pintados de ' +
      'Cafayate, hasta llegar a Salta. Vos ponés tu punto de partida y ' +
      'la app arma el tramo hasta acá.',
    Dias_Sugeridos: 6,
    Foto_Url: 'https://motoappviajes.web.app/prearmados/cuyo-noa.jpg',
    Origen: 'Mendoza, Capital',
    Origen_Lat: -32.8894587,
    Origen_Lng: -68.8458386,
    Destino: 'Salta',
    Destino_Lat: -24.7821269,
    Destino_Lng: -65.4231976,
    Paradas: [
      { Nombre: 'San Juan', Lat: -31.5351074, Lng: -68.5385941 },
      { Nombre: 'San José de Jáchal, San Juan', Lat: -30.2416824, Lng: -68.7465967 },
      { Nombre: 'Villa Unión, La Rioja', Lat: -29.3181764, Lng: -68.2282932 },
      { Nombre: 'Chilecito, La Rioja', Lat: -29.1611279, Lng: -67.4962016 },
      { Nombre: 'Cafayate, Salta', Lat: -26.0730798, Lng: -65.976052 },
    ],
    Puntos_Interes: [
      poi('Mirador Cuesta de Huaco', 'mirador', -30.1418, -68.54508,
        'Vista a la quebrada de Huaco, camino a Jáchal.'),
      poi('Mirador Cuesta de Miranda', 'mirador', -29.33995, -67.7661,
        'La cuesta más famosa de la RN 40 riojana: curvas entre cerros de colores.',
        'Cuesta de Miranda cerca: curvas y vistas de las mejores del camino.'),
      poi('Cablecarril de Chilecito', 'historico', -29.18047, -67.49171,
        'Antiguo cable carril minero, monumento histórico.'),
      poi('Samay Huasi', 'museo', -29.17397, -67.47951,
        'La casa de Joaquín V. González en Chilecito, hoy museo y jardín.'),
      poi('Los Castillos (Quebrada de las Conchas)', 'naturaleza', -26.00451, -65.80835,
        'Formaciones rojizas de la Quebrada de las Conchas.'),
      poi('Las Ventanas (Quebrada de las Conchas)', 'naturaleza', -26.01052, -65.79915,
        'Formación con aberturas en la roca.'),
      poi('El Obelisco (Quebrada de las Conchas)', 'naturaleza', -26.006, -65.78762,
        'Roca en forma de obelisco al costado de la ruta.'),
      poi('El Anfiteatro (Quebrada de las Conchas)', 'naturaleza', -25.85506, -65.70232,
        'Gran hueco natural en la roca, con acústica especial.'),
      poi('Garganta del Diablo (Quebrada de las Conchas)', 'naturaleza', -25.84863, -65.69941,
        'La formación más famosa de la quebrada.',
        'Quebrada de las Conchas: la Garganta del Diablo está cerca.'),
      poi('Museo de Arqueología de Alta Montaña', 'museo', -24.78905, -65.41093,
        'En Salta: los hallazgos del volcán Llullaillaco.'),
      poi('Cerro San Bernardo', 'mirador', -24.79008, -65.39307,
        'Vista de la ciudad de Salta; se sube en teleférico.'),
    ],
    Activo: true,
  },
];

// Traducciones (inglés / portugués) de los prearmados y sus puntos de interés.
// Se guardan junto a cada documento (campo Traducciones) y la app muestra la del idioma del teléfono.
const TRAD_PREARMADOS = {
  "en": {
    "rutas": {
      "siete-lagos": {
        "Nombre": "Seven Lakes Route",
        "Descripcion": "The classic Patagonian route between San Martín de los Andes and Villa La Angostura, running along a chain of Andean lakes. You set your starting point and the app builds the leg up to here."
      },
      "san-luis-uspallata": {
        "Nombre": "San Luis – Uspallata",
        "Descripcion": "Crossing San Juan toward the foot of the Andes, with Uspallata already showing among the hills. You set your starting point and the app builds the leg up to here."
      },
      "altas-cumbres": {
        "Nombre": "Altas Cumbres",
        "Descripcion": "A loop through three valleys in Córdoba: you climb the legendary Altas Cumbres road (with a must-stop at the \"El Cóndor\" viewpoint), drop down to Traslasierra and return via Calamuchita. You set your starting point and the app builds the leg up to here."
      },
      "cuyo-noroeste": {
        "Nombre": "Cuyo – Argentine Northwest",
        "Descripcion": "The great crossing from Cuyo to the Northwest: from Mendoza to the Jáchal valley, the Cuesta de Miranda toward Chilecito and the painted hills of Cafayate, all the way to Salta. You set your starting point and the app builds the leg up to here."
      }
    },
    "pois": {
      "Mirador Bandurrias": {
        "Nombre": "Bandurrias Viewpoint",
        "Descripcion": "View of Lake Lácar, minutes from San Martín de los Andes.",
        "Mensaje": ""
      },
      "Mirador Arroyo Partido": {
        "Nombre": "Arroyo Partido Viewpoint",
        "Descripcion": "A stream that splits in two and goes separate ways.",
        "Mensaje": "Arroyo Partido Viewpoint just ahead: a good place to stop."
      },
      "Mirador Lago Machónico": {
        "Nombre": "Lake Machónico Viewpoint",
        "Descripcion": "A stop by the lake, with the Andean forest as a backdrop.",
        "Mensaje": ""
      },
      "Cascada Vuliñanco": {
        "Nombre": "Vuliñanco Waterfall",
        "Descripcion": "A waterfall steps from the road, deep in the forest.",
        "Mensaje": "Vuliñanco Waterfall nearby: worth a stop and a photo."
      },
      "Mirador Lago Falkner": {
        "Nombre": "Lake Falkner Viewpoint",
        "Descripcion": "One of the prettiest lakes on the route.",
        "Mensaje": ""
      },
      "Mirador Lago Villarino": {
        "Nombre": "Lake Villarino Viewpoint",
        "Descripcion": "Open view of the lake and the mountains.",
        "Mensaje": ""
      },
      "Mirador Lago Escondido": {
        "Nombre": "Lake Escondido Viewpoint",
        "Descripcion": "A small, quiet lake right by the road.",
        "Mensaje": ""
      },
      "Cascada Ñivinco": {
        "Nombre": "Ñivinco Waterfall",
        "Descripcion": "A short detour (about 2 km) to the waterfall.",
        "Mensaje": ""
      },
      "Bosque Sumergido de Villa Traful": {
        "Nombre": "Villa Traful Sunken Forest",
        "Descripcion": "A forest that ended up under the water of Lake Traful. Visited by boat tour or diving.",
        "Mensaje": "Villa Traful nearby: don't miss the Sunken Forest."
      },
      "Mirador Lago Correntoso": {
        "Nombre": "Lake Correntoso Viewpoint",
        "Descripcion": "View of the lake on the way to Villa La Angostura.",
        "Mensaje": ""
      },
      "Mirador Lago Espejo": {
        "Nombre": "Lake Espejo Viewpoint",
        "Descripcion": "Still waters that mirror the forest.",
        "Mensaje": ""
      },
      "Mirador Belvedere": {
        "Nombre": "Belvedere Viewpoint",
        "Descripcion": "Panoramic view of Villa La Angostura and Nahuel Huapi.",
        "Mensaje": ""
      },
      "Mirador Bahía Mansa": {
        "Nombre": "Bahía Mansa Viewpoint",
        "Descripcion": "A calm shore on Lake Nahuel Huapi.",
        "Mensaje": ""
      },
      "Parque Nacional Sierra de las Quijadas": {
        "Nombre": "Sierra de las Quijadas National Park",
        "Descripcion": "Canyons and reddish landscapes in the San Luis desert; the main entrance is via a detour.",
        "Mensaje": "Sierra de las Quijadas nearby: one of the most striking landscapes on the road."
      },
      "Casa Natal de Sarmiento": {
        "Nombre": "Sarmiento's Birthplace",
        "Descripcion": "In San Juan: the house where Domingo F. Sarmiento was born.",
        "Mensaje": ""
      },
      "Museo Argentino de Motos Antiguas": {
        "Nombre": "Argentine Vintage Motorcycle Museum",
        "Descripcion": "In Mendoza: a must-stop for motorcyclists.",
        "Mensaje": "Vintage Motorcycle Museum, in Mendoza: a must-stop for motorcyclists."
      },
      "Museo del Área Fundacional": {
        "Nombre": "Founding Area Museum",
        "Descripcion": "Remains of the original city of Mendoza.",
        "Mensaje": ""
      },
      "Memorial de la Bandera de los Andes": {
        "Nombre": "Flag of the Andes Memorial",
        "Descripcion": "Commemorates the flag San Martín carried across the Andes.",
        "Mensaje": ""
      },
      "Embalse Potrerillos": {
        "Nombre": "Potrerillos Reservoir",
        "Descripcion": "A mountain lake on the way to Uspallata, ideal for a break.",
        "Mensaje": "Potrerillos Reservoir nearby: a good place for a break on the way to Uspallata."
      },
      "Museo Histórico Las Bóvedas": {
        "Nombre": "Las Bóvedas Historical Museum",
        "Descripcion": "Ruins of the old smelting vaults, in Uspallata.",
        "Mensaje": ""
      },
      "Mirador de Uspallata": {
        "Nombre": "Uspallata Viewpoint",
        "Descripcion": "View of the Uspallata valley and the foothills.",
        "Mensaje": ""
      },
      "Cascada Pie Grande": {
        "Nombre": "Pie Grande Waterfall",
        "Descripcion": "A waterfall in Mina Clavero, among rocks and water.",
        "Mensaje": "Mina Clavero waterfalls nearby: a stop to cool off."
      },
      "Cañón de los Vencejos": {
        "Nombre": "Vencejos Canyon",
        "Descripcion": "Canyon and waterfall very close to the previous one.",
        "Mensaje": ""
      },
      "Museo del Cura Brochero": {
        "Nombre": "Cura Brochero Museum",
        "Descripcion": "In Villa Cura Brochero: the story of the saint Cura Brochero.",
        "Mensaje": ""
      },
      "Estación Astrofísica de Bosque Alegre": {
        "Nombre": "Bosque Alegre Astrophysical Station",
        "Descripcion": "An astronomical observatory in the Córdoba hills.",
        "Mensaje": ""
      },
      "Mirador de Costa Azul": {
        "Nombre": "Costa Azul Viewpoint",
        "Descripcion": "View of Lake San Roque from Costa Azul.",
        "Mensaje": ""
      },
      "Estancia Jesuítica de Alta Gracia": {
        "Nombre": "Jesuit Estancia of Alta Gracia",
        "Descripcion": "A UNESCO World Heritage Site.",
        "Mensaje": "Alta Gracia nearby: its Jesuit Estancia is a World Heritage Site."
      },
      "Museo Casa del Che Guevara": {
        "Nombre": "Che Guevara House Museum",
        "Descripcion": "The house where Che Guevara lived as a child.",
        "Mensaje": ""
      },
      "Museo Manuel de Falla": {
        "Nombre": "Manuel de Falla Museum",
        "Descripcion": "The house where the composer Manuel de Falla lived.",
        "Mensaje": ""
      },
      "Mirador Cuesta de Huaco": {
        "Nombre": "Cuesta de Huaco Viewpoint",
        "Descripcion": "View of the Huaco gorge, on the way to Jáchal.",
        "Mensaje": ""
      },
      "Mirador Cuesta de Miranda": {
        "Nombre": "Cuesta de Miranda Viewpoint",
        "Descripcion": "The most famous hill road on La Rioja's Route 40: curves between colorful hills.",
        "Mensaje": "Cuesta de Miranda nearby: some of the best curves and views on the road."
      },
      "Cablecarril de Chilecito": {
        "Nombre": "Chilecito Cable Car",
        "Descripcion": "An old mining cable car, a historic monument.",
        "Mensaje": ""
      },
      "Samay Huasi": {
        "Nombre": "Samay Huasi",
        "Descripcion": "Joaquín V. González's house in Chilecito, now a museum and garden.",
        "Mensaje": ""
      },
      "Los Castillos (Quebrada de las Conchas)": {
        "Nombre": "Los Castillos (Quebrada de las Conchas)",
        "Descripcion": "Reddish rock formations in the Quebrada de las Conchas.",
        "Mensaje": ""
      },
      "Las Ventanas (Quebrada de las Conchas)": {
        "Nombre": "Las Ventanas (Quebrada de las Conchas)",
        "Descripcion": "A rock formation with openings.",
        "Mensaje": ""
      },
      "El Obelisco (Quebrada de las Conchas)": {
        "Nombre": "El Obelisco (Quebrada de las Conchas)",
        "Descripcion": "An obelisk-shaped rock by the side of the road.",
        "Mensaje": ""
      },
      "El Anfiteatro (Quebrada de las Conchas)": {
        "Nombre": "El Anfiteatro (Quebrada de las Conchas)",
        "Descripcion": "A large natural hollow in the rock, with special acoustics.",
        "Mensaje": ""
      },
      "Garganta del Diablo (Quebrada de las Conchas)": {
        "Nombre": "Devil's Throat (Quebrada de las Conchas)",
        "Descripcion": "The most famous formation in the gorge.",
        "Mensaje": "Quebrada de las Conchas: the Devil's Throat is close."
      },
      "Museo de Arqueología de Alta Montaña": {
        "Nombre": "High Mountain Archaeology Museum",
        "Descripcion": "In Salta: the finds from the Llullaillaco volcano.",
        "Mensaje": ""
      },
      "Cerro San Bernardo": {
        "Nombre": "San Bernardo Hill",
        "Descripcion": "View of the city of Salta; you go up by cable car.",
        "Mensaje": ""
      }
    }
  },
  "pt": {
    "rutas": {
      "siete-lagos": {
        "Nombre": "Rota dos 7 Lagos",
        "Descripcion": "O clássico roteiro patagônico entre San Martín de los Andes e Villa La Angostura, margeando uma cadeia de lagos andinos. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      },
      "san-luis-uspallata": {
        "Nombre": "San Luis – Uspallata",
        "Descripcion": "Atravessando San Juan rumo ao pé da cordilheira, com Uspallata já aparecendo entre os morros. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      },
      "altas-cumbres": {
        "Nombre": "Altas Cumbres",
        "Descripcion": "Um circuito por três vales de Córdoba: você sobe pela lendária estrada de Altas Cumbres (com parada obrigatória no mirante \"El Cóndor\"), desce a Traslasierra e volta por Calamuchita. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      },
      "cuyo-noroeste": {
        "Nombre": "Cuyo – Noroeste Argentino",
        "Descripcion": "A grande travessia de Cuyo ao Noroeste: de Mendoza ao vale de Jáchal, a Cuesta de Miranda rumo a Chilecito e os morros coloridos de Cafayate, até chegar a Salta. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      }
    },
    "pois": {
      "Mirador Bandurrias": {
        "Nombre": "Mirante Bandurrias",
        "Descripcion": "Vista para o Lago Lácar, a poucos minutos de San Martín de los Andes.",
        "Mensaje": ""
      },
      "Mirador Arroyo Partido": {
        "Nombre": "Mirante Arroyo Partido",
        "Descripcion": "Um riacho que se divide em dois e segue caminhos diferentes.",
        "Mensaje": "Mirante Arroyo Partido logo à frente: bom lugar para parar."
      },
      "Mirador Lago Machónico": {
        "Nombre": "Mirante Lago Machónico",
        "Descripcion": "Parada à beira do lago, com a floresta andina ao fundo.",
        "Mensaje": ""
      },
      "Cascada Vuliñanco": {
        "Nombre": "Cachoeira Vuliñanco",
        "Descripcion": "Cachoeira a poucos passos da estrada, em plena floresta.",
        "Mensaje": "Cachoeira Vuliñanco por perto: vale uma parada e uma foto."
      },
      "Mirador Lago Falkner": {
        "Nombre": "Mirante Lago Falkner",
        "Descripcion": "Um dos lagos mais bonitos do caminho.",
        "Mensaje": ""
      },
      "Mirador Lago Villarino": {
        "Nombre": "Mirante Lago Villarino",
        "Descripcion": "Vista aberta para o lago e a cordilheira.",
        "Mensaje": ""
      },
      "Mirador Lago Escondido": {
        "Nombre": "Mirante Lago Escondido",
        "Descripcion": "Um lago pequeno e tranquilo, à beira da estrada.",
        "Mensaje": ""
      },
      "Cascada Ñivinco": {
        "Nombre": "Cachoeira Ñivinco",
        "Descripcion": "Desvio curto (cerca de 2 km) até a cachoeira.",
        "Mensaje": ""
      },
      "Bosque Sumergido de Villa Traful": {
        "Nombre": "Floresta Submersa de Villa Traful",
        "Descripcion": "Uma floresta que ficou debaixo d'água no Lago Traful. Visita-se de barco ou mergulhando.",
        "Mensaje": "Villa Traful por perto: não perca a Floresta Submersa."
      },
      "Mirador Lago Correntoso": {
        "Nombre": "Mirante Lago Correntoso",
        "Descripcion": "Vista do lago a caminho de Villa La Angostura.",
        "Mensaje": ""
      },
      "Mirador Lago Espejo": {
        "Nombre": "Mirante Lago Espejo",
        "Descripcion": "Águas paradas onde a floresta se reflete.",
        "Mensaje": ""
      },
      "Mirador Belvedere": {
        "Nombre": "Mirante Belvedere",
        "Descripcion": "Vista panorâmica de Villa La Angostura e do Nahuel Huapi.",
        "Mensaje": ""
      },
      "Mirador Bahía Mansa": {
        "Nombre": "Mirante Bahía Mansa",
        "Descripcion": "Margem tranquila do lago Nahuel Huapi.",
        "Mensaje": ""
      },
      "Parque Nacional Sierra de las Quijadas": {
        "Nombre": "Parque Nacional Sierra de las Quijadas",
        "Descripcion": "Cânions e paisagens avermelhadas no deserto de San Luis; a entrada principal é por um desvio.",
        "Mensaje": "Sierra de las Quijadas por perto: uma das paisagens mais impressionantes do caminho."
      },
      "Casa Natal de Sarmiento": {
        "Nombre": "Casa Natal de Sarmiento",
        "Descripcion": "Em San Juan: a casa onde nasceu Domingo F. Sarmiento.",
        "Mensaje": ""
      },
      "Museo Argentino de Motos Antiguas": {
        "Nombre": "Museu Argentino de Motos Antigas",
        "Descripcion": "Em Mendoza: parada obrigatória para motociclistas.",
        "Mensaje": "Museu de Motos Antigas, em Mendoza: parada obrigatória para motociclistas."
      },
      "Museo del Área Fundacional": {
        "Nombre": "Museu da Área Fundacional",
        "Descripcion": "Restos da cidade original de Mendoza.",
        "Mensaje": ""
      },
      "Memorial de la Bandera de los Andes": {
        "Nombre": "Memorial da Bandeira dos Andes",
        "Descripcion": "Lembra a bandeira com a qual San Martín cruzou os Andes.",
        "Mensaje": ""
      },
      "Embalse Potrerillos": {
        "Nombre": "Represa Potrerillos",
        "Descripcion": "Lago de montanha a caminho de Uspallata, ideal para uma pausa.",
        "Mensaje": "Represa Potrerillos por perto: bom lugar para uma pausa a caminho de Uspallata."
      },
      "Museo Histórico Las Bóvedas": {
        "Nombre": "Museu Histórico Las Bóvedas",
        "Descripcion": "Ruínas das antigas abóbadas de fundição, em Uspallata.",
        "Mensaje": ""
      },
      "Mirador de Uspallata": {
        "Nombre": "Mirante de Uspallata",
        "Descripcion": "Vista do vale de Uspallata e da pré-cordilheira.",
        "Mensaje": ""
      },
      "Cascada Pie Grande": {
        "Nombre": "Cachoeira Pie Grande",
        "Descripcion": "Cachoeira em Mina Clavero, entre pedras e água.",
        "Mensaje": "Cachoeiras de Mina Clavero por perto: uma parada para se refrescar."
      },
      "Cañón de los Vencejos": {
        "Nombre": "Cânion dos Vencejos",
        "Descripcion": "Cânion e cachoeira bem perto da anterior.",
        "Mensaje": ""
      },
      "Museo del Cura Brochero": {
        "Nombre": "Museu do Cura Brochero",
        "Descripcion": "Em Villa Cura Brochero: a história do santo Cura Brochero.",
        "Mensaje": ""
      },
      "Estación Astrofísica de Bosque Alegre": {
        "Nombre": "Estação Astrofísica de Bosque Alegre",
        "Descripcion": "Observatório astronômico nas serras de Córdoba.",
        "Mensaje": ""
      },
      "Mirador de Costa Azul": {
        "Nombre": "Mirante de Costa Azul",
        "Descripcion": "Vista do lago San Roque a partir de Costa Azul.",
        "Mensaje": ""
      },
      "Estancia Jesuítica de Alta Gracia": {
        "Nombre": "Estância Jesuítica de Alta Gracia",
        "Descripcion": "Patrimônio Mundial da UNESCO.",
        "Mensaje": "Alta Gracia por perto: sua Estância Jesuítica é Patrimônio Mundial."
      },
      "Museo Casa del Che Guevara": {
        "Nombre": "Museu Casa do Che Guevara",
        "Descripcion": "A casa onde Che Guevara viveu quando criança.",
        "Mensaje": ""
      },
      "Museo Manuel de Falla": {
        "Nombre": "Museu Manuel de Falla",
        "Descripcion": "A casa onde viveu o compositor Manuel de Falla.",
        "Mensaje": ""
      },
      "Mirador Cuesta de Huaco": {
        "Nombre": "Mirante Cuesta de Huaco",
        "Descripcion": "Vista da garganta de Huaco, a caminho de Jáchal.",
        "Mensaje": ""
      },
      "Mirador Cuesta de Miranda": {
        "Nombre": "Mirante Cuesta de Miranda",
        "Descripcion": "A subida mais famosa da RN 40 riojana: curvas entre morros coloridos.",
        "Mensaje": "Cuesta de Miranda por perto: curvas e vistas entre as melhores do caminho."
      },
      "Cablecarril de Chilecito": {
        "Nombre": "Cabo aéreo de Chilecito",
        "Descripcion": "Antigo cabo aéreo de mineração, monumento histórico.",
        "Mensaje": ""
      },
      "Samay Huasi": {
        "Nombre": "Samay Huasi",
        "Descripcion": "A casa de Joaquín V. González em Chilecito, hoje museu e jardim.",
        "Mensaje": ""
      },
      "Los Castillos (Quebrada de las Conchas)": {
        "Nombre": "Los Castillos (Quebrada de las Conchas)",
        "Descripcion": "Formações avermelhadas da Quebrada de las Conchas.",
        "Mensaje": ""
      },
      "Las Ventanas (Quebrada de las Conchas)": {
        "Nombre": "Las Ventanas (Quebrada de las Conchas)",
        "Descripcion": "Formação com aberturas na rocha.",
        "Mensaje": ""
      },
      "El Obelisco (Quebrada de las Conchas)": {
        "Nombre": "El Obelisco (Quebrada de las Conchas)",
        "Descripcion": "Rocha em forma de obelisco à beira da estrada.",
        "Mensaje": ""
      },
      "El Anfiteatro (Quebrada de las Conchas)": {
        "Nombre": "El Anfiteatro (Quebrada de las Conchas)",
        "Descripcion": "Grande cavidade natural na rocha, com acústica especial.",
        "Mensaje": ""
      },
      "Garganta del Diablo (Quebrada de las Conchas)": {
        "Nombre": "Garganta do Diabo (Quebrada de las Conchas)",
        "Descripcion": "A formação mais famosa da quebrada.",
        "Mensaje": "Quebrada de las Conchas: a Garganta do Diabo está perto."
      },
      "Museo de Arqueología de Alta Montaña": {
        "Nombre": "Museu de Arqueologia de Alta Montanha",
        "Descripcion": "Em Salta: os achados do vulcão Llullaillaco.",
        "Mensaje": ""
      },
      "Cerro San Bernardo": {
        "Nombre": "Morro San Bernardo",
        "Descripcion": "Vista da cidade de Salta; sobe-se de teleférico.",
        "Mensaje": ""
      }
    }
  }
};

// Agrega el campo Traducciones a la ruta y a cada punto de interés.
function conTraducciones(id, datos) {
  const idiomas = ['en', 'pt'];
  const ruta = {};
  for (const l of idiomas) if (TRAD_PREARMADOS[l].rutas[id]) ruta[l] = TRAD_PREARMADOS[l].rutas[id];
  return {
    ...datos,
    Traducciones: ruta,
    Puntos_Interes: (datos.Puntos_Interes || []).map((p) => {
      const t = {};
      for (const l of idiomas) if (TRAD_PREARMADOS[l].pois[p.Nombre]) t[l] = TRAD_PREARMADOS[l].pois[p.Nombre];
      return { ...p, Traducciones: t };
    }),
  };
}

// JSON con las claves ordenadas: Firestore no conserva el orden de los campos.
const estable = (o) =>
  JSON.stringify(o, (k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

async function sembrarPrearmados() {
  for (const { id, ...base } of PREARMADOS) {
    const datos = conTraducciones(id, base);
    const ref = db.collection('ViajesPrearmados').doc(id);
    const doc = await ref.get();
    if (!doc.exists) {
      await ref.set(datos);
      console.log(`I) sembrado el prearmado "${datos.Nombre}"`);
      continue;
    }
    // Ya existe: sólo completamos la foto si falta y ahora tenemos una
    // (no pisamos nada más — puede haber sido editado a mano).
    const actual = doc.data();
    if (!actual.Foto_Url && datos.Foto_Url) {
      await ref.update({ Foto_Url: datos.Foto_Url });
      console.log(`I) foto agregada al prearmado "${datos.Nombre}"`);
    }
    // Los puntos de interés y las traducciones se definen acá (única fuente):
    // si cambian, se pisan.
    if (estable(actual.Puntos_Interes || []) !== estable(datos.Puntos_Interes || [])) {
      await ref.update({ Puntos_Interes: datos.Puntos_Interes || [] });
      console.log(`I) puntos de interés actualizados en "${datos.Nombre}" (${(datos.Puntos_Interes || []).length})`);
    }
    if (estable(actual.Traducciones || {}) !== estable(datos.Traducciones || {})) {
      await ref.update({ Traducciones: datos.Traducciones || {} });
      console.log(`I) traducciones actualizadas en "${datos.Nombre}"`);
    }
  }
}

// Carrusel de Inicio: la lista COMPLETA y en orden de los auspiciantes que
// aparecen, con la imagen y la página a la que lleva el toque (Link vacío =
// el banner no es cliqueable). Es la única fuente: para sumar, sacar o
// cambiar un link, editar esta lista y volver a correr el robot — no hace
// falta build de la app. Ojo: lo que se edite a mano en Firestore
// (config/auspiciantes.Auspiciantes) se pisa en la próxima corrida.
const AUSPICIANTES_INICIO = [
  { Nombre: 'FOS', Imagen: 'https://motoappviajes.web.app/auspiciantes/fos.jpg', Link: 'https://www.fos.com.ar/' },
  // Oyambre va con WhatsApp (https://wa.me/549<código de área><número>, sin 0 ni 15); falta el número.
  { Nombre: 'Café Oyambre', Imagen: 'https://motoappviajes.web.app/auspiciantes/oyambre.jpg', Link: '' },
  { Nombre: 'MR Services', Imagen: 'https://motoappviajes.web.app/auspiciantes/mr.jpg', Link: 'https://mrservices.com.ar/' },
];

async function sembrarConfigAuspiciantes() {
  const ref = db.collection('config').doc('auspiciantes');
  const doc = await ref.get();
  const actuales = doc.exists ? doc.data().Auspiciantes : undefined;
  if (JSON.stringify(actuales) === JSON.stringify(AUSPICIANTES_INICIO)) return;
  await ref.set({ Auspiciantes: AUSPICIANTES_INICIO }, { merge: true });
  console.log(`J) config/auspiciantes actualizado (${AUSPICIANTES_INICIO.length} auspiciantes)`);
}

async function actualizarEstadisticas() {
  const ref = db.collection('config').doc('estadisticas');
  const hoy = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const doc = await ref.get();
  if (doc.exists && doc.data().Actualizado === hoy) return; // ya corrió hoy
  const total = (await db.collection('Usuarios').count().get()).data().count;
  await ref.set({ Usuarios_Registrados: total, Actualizado: hoy }, { merge: true });
  console.log(`K) usuarios registrados: ${total}`);
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
  await sembrarPrearmados();
  await sembrarConfigAuspiciantes();
  await actualizarEstadisticas();
  console.log('OK');
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
