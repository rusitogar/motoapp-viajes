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

// >>> RUTAS_PAISES (generado por rutas_paises.py — no editar a mano)
const PREARMADOS_PAISES = [
  {
    id: "carretera-austral",
    Pais: "CL",
    Nombre: "Carretera Austral: Puerto Montt – Coyhaique",
    Descripcion: "El gran clásico del sur de Chile: de Puerto Montt a Coyhaique por la Carretera Austral, entre fiordos, volcanes y bosque húmedo. Hay tramos con balsa (ferry): revisá los horarios antes de salir. Vos ponés tu punto de partida y la app arma el tramo hasta acá.",
    Dias_Sugeridos: 4,
    Foto_Url: "https://motoappviajes.web.app/prearmados/carretera-austral.jpg",
    Origen: "Puerto Montt, Los Lagos", Origen_Lat: -41.4718, Origen_Lng: -72.93959,
    Destino: "Coyhaique, Aysén", Destino_Lat: -45.57118, Destino_Lng: -72.06849,
    Paradas: [{ Nombre: "Hornopirén, Los Lagos", Lat: -41.96605, Lng: -72.47068 }, { Nombre: "Chaitén, Los Lagos", Lat: -42.91653, Lng: -72.70842 }, { Nombre: "Puyuhuapi, Aysén", Lat: -44.32521, Lng: -72.55843 }],
    Puntos_Interes: [
      poi("Feria y Mercado de Angelmó", "otro", -41.48331, -72.95835,
        "Feria de artesanías y mercado de mariscos frente al mar, en Puerto Montt: buen lugar para arrancar."),
      poi("Volcán Chaitén", "naturaleza", -42.83678, -72.64751,
        "Volcán que entró en erupción en 2008. Un sendero permite llegar hasta el borde de su cráter.",
        "Volcán Chaitén cerca: vale la pena el sendero al cráter."),
      poi("Mirador de Chaitén", "mirador", -42.91087, -72.70928,
        "Vista de Chaitén y de su costa sobre el golfo."),
      poi("Parque Nacional Pumalín Douglas Tompkins", "naturaleza", -43.00873, -72.47834,
        "Senderos entre bosque húmedo, cascadas y volcanes. Uno de los tramos más lindos de la ruta.",
        "Parque Pumalín cerca: uno de los mejores tramos de la ruta."),
      poi("Termas El Amarillo", "naturaleza", -42.99713, -72.44235,
        "Termas junto a la ruta, cerca del Parque Pumalín."),
      poi("Mirador Lago Yelcho", "mirador", -43.21672, -72.44266,
        "Vista al Lago Yelcho con la cordillera de fondo."),
      poi("Mirador Ventisquero Yelcho", "mirador", -43.27245, -72.42078,
        "Vista al ventisquero (glaciar) Yelcho."),
      poi("Mirador de Puyuhuapi", "mirador", -44.31931, -72.57645,
        "Vista de Puyuhuapi y de su fiordo."),
      poi("Parque Nacional Queulat", "naturaleza", -44.38642, -72.41544,
        "Bosque húmedo, lagunas y glaciares colgantes. Hay un sendero al Ventisquero Colgante.",
        "Queulat cerca: el sendero al Ventisquero Colgante es un imperdible."),
      poi("Mirador Río Cisnes", "mirador", -44.70595, -72.22847,
        "Vista al valle del río Cisnes."),
      poi("Mirador Lago Las Torres", "mirador", -44.79058, -72.20674,
        "Vista al Lago Las Torres, sobre la ruta."),
      poi("Piedra del Indio", "naturaleza", -45.5753, -72.07902,
        "Formación de roca que recuerda el perfil de un rostro, en la entrada de Coyhaique."),
      poi("Museo Regional de Aysén", "museo", -45.57275, -72.0261,
        "Historia y cultura de la región de Aysén."),
    ],
    Activo: true,
  },
  {
    id: "llanquihue",
    Pais: "CL",
    Nombre: "Vuelta al Lago Llanquihue",
    Descripcion: "La vuelta completa al lago Llanquihue: pueblos de colonización alemana como Puerto Varas, Frutillar y Puerto Octay, con los volcanes Osorno y Calbuco de fondo. Vos ponés tu punto de partida y la app arma el tramo hasta acá.",
    Dias_Sugeridos: 1,
    Foto_Url: "https://motoappviajes.web.app/prearmados/llanquihue.jpg",
    Origen: "Puerto Varas, Los Lagos", Origen_Lat: -41.3178, Origen_Lng: -72.98291,
    Destino: "Puerto Varas, Los Lagos", Destino_Lat: -41.3178, Destino_Lng: -72.98291,
    Paradas: [{ Nombre: "Frutillar, Los Lagos", Lat: -41.12585, Lng: -73.06047 }, { Nombre: "Puerto Octay, Los Lagos", Lat: -40.97276, Lng: -72.88422 }, { Nombre: "Las Cascadas, Los Lagos", Lat: -41.07877, Lng: -72.63717 }, { Nombre: "Ensenada, Los Lagos", Lat: -41.20819, Lng: -72.53867 }],
    Puntos_Interes: [
      poi("Iglesia del Sagrado Corazón de Puerto Varas", "historico", -41.32039, -72.98607,
        "Iglesia de estilo alemán que domina el pueblo."),
      poi("Cerro Calvario", "mirador", -41.31972, -72.99047,
        "Mirador de Puerto Varas, con vista al lago y a los volcanes."),
      poi("Teatro del Lago", "otro", -41.13938, -73.02485,
        "Teatro frente al lago, en Frutillar, sede de las Semanas Musicales."),
      poi("Museo Colonial Alemán de Frutillar", "museo", -41.13241, -73.03025,
        "Casas, molino y herramientas que muestran la vida de los colonos alemanes."),
      poi("Zona Típica de Puerto Octay", "historico", -40.97533, -72.88347,
        "Centro histórico con casas de madera de los colonos alemanes."),
      poi("Playa de Ensenada", "mirador", -41.21216, -72.54568,
        "Costa del lago con vista al volcán Osorno."),
      poi("Saltos del Petrohué", "cascada", -41.17331, -72.44742,
        "Cascadas de agua turquesa sobre roca volcánica. Desvío corto desde Ensenada.",
        "Saltos del Petrohué a pocos kilómetros: desvío corto desde Ensenada."),
    ],
    Activo: true,
  },
  {
    id: "pucon-conaripe",
    Pais: "CL",
    Nombre: "Pucón – Panguipulli – Coñaripe",
    Descripcion: "Un circuito por los lagos de la Araucanía y Los Ríos: Pucón, Villarrica, Licán Ray, Coñaripe y Panguipulli, con el volcán Villarrica siempre cerca. Vos ponés tu punto de partida y la app arma el tramo hasta acá.",
    Dias_Sugeridos: 1,
    Foto_Url: "https://motoappviajes.web.app/prearmados/pucon-conaripe.jpg",
    Origen: "Pucón, Araucanía", Origen_Lat: -39.27312, Origen_Lng: -71.97776,
    Destino: "Pucón, Araucanía", Destino_Lat: -39.27312, Destino_Lng: -71.97776,
    Paradas: [{ Nombre: "Villarrica, Araucanía", Lat: -39.27809, Lng: -72.22744 }, { Nombre: "Licán Ray, Araucanía", Lat: -39.48972, Lng: -72.15539 }, { Nombre: "Coñaripe, Los Ríos", Lat: -39.56785, Lng: -72.00742 }, { Nombre: "Panguipulli, Los Ríos", Lat: -39.64199, Lng: -72.33338 }],
    Puntos_Interes: [
      poi("Centro Interactivo Vulcanológico CIVUR", "museo", -39.27364, -71.97914,
        "Muestra sobre el volcán Villarrica y su actividad."),
      poi("Museo Histórico y Arqueológico de Villarrica", "museo", -39.28516, -72.22394,
        "Historia de la región y de la cultura mapuche."),
      poi("Costanera de Villarrica", "mirador", -39.28323, -72.22171,
        "Paseo junto al lago con vista al volcán."),
      poi("Costanera de Licán Ray", "mirador", -39.49255, -72.15186,
        "Costa del lago Calafquén, con playa y punto para la foto."),
      poi("Mirador Lago Calafquén", "mirador", -39.4976, -72.28864,
        "Vista al lago Calafquén desde la ruta."),
      poi("Salto Comonahue", "cascada", -39.52151, -72.02989,
        "Cascada cerca del camino a Coñaripe. Desvío corto."),
      poi("Termas Geométricas", "naturaleza", -39.50154, -71.87442,
        "Termas entre pasarelas de madera en un cañón del bosque. Desvío desde Coñaripe (unos 15 km).",
        "Termas Geométricas cerca: un desvío que vale la pena."),
    ],
    Activo: true,
  },
  {
    id: "atacama-jama",
    Pais: "CL",
    Nombre: "San Pedro de Atacama – Paso de Jama",
    Descripcion: "Desde San Pedro de Atacama hacia el altiplano: lagunas, volcanes y salares camino al Paso de Jama, en la frontera con Argentina. Se sube por encima de los 4.000 metros, así que llevá abrigo y combustible de sobra. Vos ponés tu punto de partida y la app arma el tramo hasta acá.",
    Dias_Sugeridos: 2,
    Foto_Url: "https://motoappviajes.web.app/prearmados/atacama-jama.jpg",
    Origen: "San Pedro de Atacama, Antofagasta", Origen_Lat: -22.9107, Origen_Lng: -68.2001,
    Destino: "Paso de Jama, Antofagasta", Destino_Lat: -23.22643, Destino_Lng: -67.06284,
    Paradas: [{ Nombre: "Socaire, Antofagasta", Lat: -23.59021, Lng: -67.89027 }],
    Puntos_Interes: [
      poi("Pukará de Quitor", "historico", -22.89116, -68.21488,
        "Antigua fortaleza de piedra sobre un cerro, con vista al oasis de San Pedro."),
      poi("Museo Arqueológico Gustavo Le Paige", "museo", -22.90563, -68.19669,
        "Piezas y momias de las culturas del desierto de Atacama."),
      poi("Museo del Meteorito", "museo", -22.908, -68.20166,
        "Colección de meteoritos encontrados en el desierto de Atacama."),
      poi("Valle de la Luna", "naturaleza", -22.93515, -68.23309,
        "Paisaje de sal, arena y roca erosionada, famoso por sus atardeceres. Desvío corto desde San Pedro."),
      poi("Trópico de Capricornio", "mirador", -23.44761, -67.99596,
        "Marca sobre la línea del Trópico de Capricornio, junto a la ruta."),
      poi("Lagunas Miscanti y Miñiques", "naturaleza", -23.73843, -67.79019,
        "Dos lagunas altiplánicas de color azul intenso, bajo los volcanes. Desvío desde Socaire.",
        "Lagunas Miscanti y Miñiques: desvío desde Socaire, de lo más lindo de la ruta."),
      poi("Portezuelo del Cajón", "mirador", -22.88084, -67.79861,
        "Paso de alta montaña sobre la ruta al Paso de Jama."),
      poi("Cerro Toco", "mirador", -22.94622, -67.77534,
        "Volcán de más de 5.000 metros, visible desde la ruta."),
      poi("Monjes de la Pacana", "naturaleza", -23.06043, -67.47907,
        "Monolitos de roca en pleno altiplano, cerca de la ruta.",
        "Monjes de la Pacana cerca: formaciones de roca que vale la pena ver."),
      poi("Laguna Aguas Calientes", "naturaleza", -23.11755, -67.43073,
        "Laguna altiplánica junto a la ruta, buen punto para sacar fotos."),
    ],
    Activo: true,
  },
  {
    id: "rio-do-rastro",
    Pais: "BR",
    Nombre: "Serra do Rio do Rastro y Corvo Branco",
    Descripcion: "Dos clásicos de la sierra catarinense: la Serra do Rio do Rastro, con sus curvas en zigzag, y la Serra do Corvo Branco, un camino tallado entre paredes de roca, pasando por Urubici. Vos ponés tu punto de partida y la app arma el tramo hasta acá.",
    Dias_Sugeridos: 2,
    Foto_Url: "https://motoappviajes.web.app/prearmados/rio-do-rastro.jpg",
    Origen: "Lauro Müller, Santa Catarina", Origen_Lat: -28.39422, Origen_Lng: -49.39754,
    Destino: "Lauro Müller, Santa Catarina", Destino_Lat: -28.39422, Destino_Lng: -49.39754,
    Paradas: [{ Nombre: "Bom Jardim da Serra, Santa Catarina", Lat: -28.33803, Lng: -49.62559 }, { Nombre: "Urubici, Santa Catarina", Lat: -28.01566, Lng: -49.59255 }, { Nombre: "Serra do Corvo Branco, Santa Catarina", Lat: -28.06248, Lng: -49.36246 }],
    Puntos_Interes: [
      poi("Mirante da Serra do Rio do Rastro", "mirador", -28.40326, -49.54876,
        "Mirador sobre las curvas en zigzag de la sierra, uno de los caminos más fotografiados del sur de Brasil.",
        "Serra do Rio do Rastro cerca: paren en el mirador, las curvas son una postal."),
      poi("Mirante Norte da Serra do Rio do Rastro", "mirador", -28.40517, -49.54925,
        "Otro mirador sobre la sierra, con vista distinta de las curvas."),
      poi("Mirante do Parque Nacional de São Joaquim", "mirador", -28.15945, -49.63412,
        "Mirador del Parque Nacional de São Joaquim, en la sierra más fría de Brasil."),
      poi("Cascata do Avencal", "cascada", -28.0471, -49.6173,
        "Cascada cerca de Urubici."),
      poi("Mirante de Urubici", "mirador", -28.02454, -49.60609,
        "Vista de la sierra y del valle de Urubici."),
      poi("Inscrições Rupestres de Urubici", "historico", -28.02829, -49.61214,
        "Sitio con inscripciones rupestres cerca de Urubici."),
      poi("Serra do Corvo Branco", "naturaleza", -28.0564, -49.36506,
        "Camino de montaña tallado en la roca, con paredes altísimas y miradores. Revisá el estado del camino antes de ir.",
        "Serra do Corvo Branco cerca: un tramo tallado en la roca, con miradores."),
      poi("Cascata da Barrinha", "cascada", -28.34761, -49.59905,
        "Cascada cerca de la ruta, en la sierra."),
      poi("Rua Coberta de São Ludgero", "historico", -28.32604, -49.17655,
        "Calle cubierta de estilo alemán, en el centro de São Ludgero."),
    ],
    Activo: true,
  },
  {
    id: "rio-santos",
    Pais: "BR",
    Nombre: "Río–Santos: Río de Janeiro – Ubatuba",
    Descripcion: "La Costa Verde entre Río de Janeiro y Ubatuba: playas, sierra y selva pegadas al mar, con el casco histórico de Paraty en el medio. Vos ponés tu punto de partida y la app arma el tramo hasta acá.",
    Dias_Sugeridos: 2,
    Foto_Url: "https://motoappviajes.web.app/prearmados/rio-santos.jpg",
    Origen: "Río de Janeiro, Río de Janeiro", Origen_Lat: -22.91117, Origen_Lng: -43.23578,
    Destino: "Ubatuba, São Paulo", Destino_Lat: -23.43316, Destino_Lng: -45.08342,
    Paradas: [{ Nombre: "Mangaratiba, Río de Janeiro", Lat: -22.96002, Lng: -44.04111 }, { Nombre: "Angra dos Reis, Río de Janeiro", Lat: -23.0064, Lng: -44.31633 }, { Nombre: "Paraty, Río de Janeiro", Lat: -23.21965, Lng: -44.71542 }],
    Puntos_Interes: [
      poi("Cristo Redentor", "mirador", -22.95192, -43.21049,
        "El monumento más famoso de Río, en lo alto del Corcovado, con vista de toda la ciudad."),
      poi("Ilha Grande", "naturaleza", -23.15554, -44.23448,
        "Isla de selva y playas sin autos. Se llega en barco desde Angra dos Reis o Conceição de Jacareí."),
      poi("Centro Histórico de Paraty", "historico", -23.21907, -44.71335,
        "Calles empedradas y casas coloniales del siglo XVIII. Patrimonio Mundial de la UNESCO.",
        "Paraty cerca: su centro histórico es Patrimonio de la Humanidad."),
      poi("Trindade", "naturaleza", -23.35073, -44.72569,
        "Aldea costera con playas rodeadas de selva, al sur de Paraty."),
      poi("Mirante da Praia Vermelha do Norte", "mirador", -23.41354, -45.03067,
        "Mirador con vista a la playa y a la costa de Ubatuba."),
      poi("Projeto Tamar Ubatuba", "naturaleza", -23.45219, -45.07013,
        "Centro de conservación de tortugas marinas, con acuario y visitas."),
    ],
    Activo: true,
  },
  {
    id: "estrada-real",
    Pais: "BR",
    Nombre: "Estrada Real: Ouro Preto – Tiradentes",
    Descripcion: "Un tramo del Camino Real de Minas Gerais entre dos joyas coloniales, Ouro Preto y Tiradentes, pasando por São João del-Rei. Iglesias barrocas, museos y calles empedradas de la época del oro. Vos ponés tu punto de partida y la app arma el tramo hasta acá.",
    Dias_Sugeridos: 2,
    Foto_Url: "https://motoappviajes.web.app/prearmados/estrada-real.jpg",
    Origen: "Ouro Preto, Minas Gerais", Origen_Lat: -20.38653, Origen_Lng: -43.50437,
    Destino: "Tiradentes, Minas Gerais", Destino_Lat: -21.11047, Destino_Lng: -44.17429,
    Paradas: [{ Nombre: "Ouro Branco, Minas Gerais", Lat: -20.52224, Lng: -43.69173 }, { Nombre: "Conselheiro Lafaiete, Minas Gerais", Lat: -20.65604, Lng: -43.80608 }, { Nombre: "São João del-Rei, Minas Gerais", Lat: -21.13358, Lng: -44.25881 }],
    Puntos_Interes: [
      poi("Centro Histórico de Ouro Preto", "historico", -20.38541, -43.50363,
        "Ciudad colonial de la época del oro, Patrimonio Mundial de la UNESCO desde 1980.",
        "Ouro Preto cerca: su centro histórico es Patrimonio de la Humanidad."),
      poi("Igreja de São Francisco de Assis", "historico", -20.38686, -43.50278,
        "Iglesia barroca con obras de Aleijadinho, uno de los grandes del barroco brasileño."),
      poi("Museu da Inconfidência", "museo", -20.38616, -43.50371,
        "Museo sobre la Inconfidência Mineira, la conspiración de 1789, en el antiguo ayuntamiento y cárcel."),
      poi("Mina do Chico Rei", "historico", -20.38627, -43.49925,
        "Antigua mina de oro que se puede visitar."),
      poi("Igreja Matriz de Nossa Senhora do Pilar", "historico", -20.3868, -43.50751,
        "Iglesia con altares tallados y cubiertos en oro, típica del barroco mineiro."),
      poi("Mirante do Morro São Sebastião", "mirador", -20.38122, -43.50258,
        "Vista de los techos y las iglesias de Ouro Preto."),
      poi("Museu Regional de São João del-Rei", "museo", -21.1359, -44.2613,
        "Casona colonial con muebles y objetos de la época."),
      poi("Estação Ferroviária de São João del-Rei (Maria Fumaça)", "historico", -21.13338, -44.25749,
        "Salida de la Maria Fumaça, el tren a vapor histórico que une São João del-Rei y Tiradentes. Consultá los días de funcionamiento."),
      poi("Chafariz de São José", "historico", -21.10743, -44.17651,
        "Fuente colonial de piedra en el centro histórico de Tiradentes.",
        "Tiradentes cerca: un centro histórico para recorrer a pie."),
      poi("Museu Casa Padre Toledo", "museo", -21.11103, -44.17649,
        "Casa histórica de Tiradentes, ligada a la Inconfidência Mineira."),
    ],
    Activo: true,
  },
  {
    id: "rota-romantica",
    Pais: "BR",
    Nombre: "Rota Romântica",
    Descripcion: "La sierra gaúcha de influencia alemana e italiana: Nova Petrópolis, Gramado, Canela y São Francisco de Paula, entre bosques, cascadas y pueblos de aire alpino. Vos ponés tu punto de partida y la app arma el tramo hasta acá.",
    Dias_Sugeridos: 1,
    Foto_Url: "https://motoappviajes.web.app/prearmados/rota-romantica.jpg",
    Origen: "Nova Petrópolis, Rio Grande do Sul", Origen_Lat: -29.37598, Origen_Lng: -51.11233,
    Destino: "Nova Petrópolis, Rio Grande do Sul", Destino_Lat: -29.37598, Destino_Lng: -51.11233,
    Paradas: [{ Nombre: "Gramado, Rio Grande do Sul", Lat: -29.37929, Lng: -50.8737 }, { Nombre: "Canela, Rio Grande do Sul", Lat: -29.33925, Lng: -50.83259 }, { Nombre: "São Francisco de Paula, Rio Grande do Sul", Lat: -29.44845, Lng: -50.5833 }],
    Puntos_Interes: [
      poi("Labirinto Verde", "otro", -29.37572, -51.11216,
        "Laberinto de arbustos y jardines en Nova Petrópolis."),
      poi("Mirante do Vale do Rio Caí", "mirador", -29.33161, -51.00758,
        "Vista del valle del río Caí desde la ruta."),
      poi("Rua Coberta de Gramado", "historico", -29.37859, -50.8732,
        "Calle cubierta en el corazón de Gramado, con cafés y tiendas."),
      poi("Lago Negro", "mirador", -29.39496, -50.87561,
        "Lago rodeado de bosque en Gramado, ideal para un paseo."),
      poi("Cascata Véu de Noiva", "cascada", -29.38243, -50.88037,
        "Cascada cerca del centro de Gramado."),
      poi("Catedral de Pedra de Canela", "historico", -29.36376, -50.8092,
        "Catedral neogótica de piedra, ícono de Canela.",
        "Canela cerca: no te pierdas la Catedral de Pedra."),
      poi("Cascata do Caracol", "cascada", -29.31354, -50.85432,
        "Cascada de más de 100 metros dentro del Parque Estadual do Caracol. Desvío corto desde Canela.",
        "Cascata do Caracol a pocos kilómetros: desvío corto desde Canela."),
    ],
    Activo: true,
  },
];
const TRAD_PAISES = {
  "en": {
    "rutas": {
      "carretera-austral": {
        "Nombre": "Carretera Austral: Puerto Montt – Coyhaique",
        "Descripcion": "The great classic of southern Chile: from Puerto Montt to Coyhaique along the Carretera Austral, through fjords, volcanoes and temperate rainforest. Some stretches need a ferry: check the schedules before you leave. You set your starting point and the app builds the leg up to here."
      },
      "llanquihue": {
        "Nombre": "Lake Llanquihue Loop",
        "Descripcion": "The full loop around Lake Llanquihue: German-settlement towns like Puerto Varas, Frutillar and Puerto Octay, with the Osorno and Calbuco volcanoes in the background. You set your starting point and the app builds the leg up to here."
      },
      "pucon-conaripe": {
        "Nombre": "Pucón – Panguipulli – Coñaripe",
        "Descripcion": "A loop through the lakes of Araucanía and Los Ríos: Pucón, Villarrica, Licán Ray, Coñaripe and Panguipulli, with the Villarrica volcano always nearby. You set your starting point and the app builds the leg up to here."
      },
      "atacama-jama": {
        "Nombre": "San Pedro de Atacama – Paso de Jama",
        "Descripcion": "From San Pedro de Atacama up to the altiplano: lagoons, volcanoes and salt flats on the way to the Paso de Jama, on the border with Argentina. The road climbs above 4,000 meters, so bring warm clothes and extra fuel. You set your starting point and the app builds the leg up to here."
      },
      "rio-do-rastro": {
        "Nombre": "Serra do Rio do Rastro and Corvo Branco",
        "Descripcion": "Two classics of the Santa Catarina highlands: the Serra do Rio do Rastro, with its zigzag curves, and the Serra do Corvo Branco, a road cut between rock walls, passing through Urubici. You set your starting point and the app builds the leg up to here."
      },
      "rio-santos": {
        "Nombre": "Rio–Santos: Rio de Janeiro – Ubatuba",
        "Descripcion": "The Costa Verde between Rio de Janeiro and Ubatuba: beaches, mountains and rainforest right by the sea, with the historic center of Paraty in the middle. You set your starting point and the app builds the leg up to here."
      },
      "estrada-real": {
        "Nombre": "Estrada Real: Ouro Preto – Tiradentes",
        "Descripcion": "A stretch of the Royal Road of Minas Gerais between two colonial gems, Ouro Preto and Tiradentes, passing through São João del-Rei. Baroque churches, museums and cobbled streets from the gold era. You set your starting point and the app builds the leg up to here."
      },
      "rota-romantica": {
        "Nombre": "Rota Romântica",
        "Descripcion": "The Serra Gaúcha with German and Italian influence: Nova Petrópolis, Gramado, Canela and São Francisco de Paula, among forests, waterfalls and Alpine-style towns. You set your starting point and the app builds the leg up to here."
      }
    },
    "pois": {
      "Feria y Mercado de Angelmó": {
        "Nombre": "Angelmó Market and Crafts Fair",
        "Descripcion": "A crafts fair and seafood market by the sea in Puerto Montt: a good place to start.",
        "Mensaje": ""
      },
      "Volcán Chaitén": {
        "Nombre": "Chaitén Volcano",
        "Descripcion": "A volcano that erupted in 2008. A trail leads to the edge of its crater.",
        "Mensaje": "Chaitén Volcano nearby: the trail to the crater is worth it."
      },
      "Mirador de Chaitén": {
        "Nombre": "Chaitén Viewpoint",
        "Descripcion": "View of Chaitén and its coast on the gulf.",
        "Mensaje": ""
      },
      "Parque Nacional Pumalín Douglas Tompkins": {
        "Nombre": "Pumalín Douglas Tompkins National Park",
        "Descripcion": "Trails through rainforest, waterfalls and volcanoes. One of the prettiest stretches of the route.",
        "Mensaje": "Pumalín Park nearby: one of the best stretches of the route."
      },
      "Termas El Amarillo": {
        "Nombre": "El Amarillo Hot Springs",
        "Descripcion": "Hot springs by the road, near Pumalín Park.",
        "Mensaje": ""
      },
      "Mirador Lago Yelcho": {
        "Nombre": "Lake Yelcho Viewpoint",
        "Descripcion": "View of Lake Yelcho with the mountains behind.",
        "Mensaje": ""
      },
      "Mirador Ventisquero Yelcho": {
        "Nombre": "Yelcho Glacier Viewpoint",
        "Descripcion": "View of the Yelcho glacier.",
        "Mensaje": ""
      },
      "Mirador de Puyuhuapi": {
        "Nombre": "Puyuhuapi Viewpoint",
        "Descripcion": "View of Puyuhuapi and its fjord.",
        "Mensaje": ""
      },
      "Parque Nacional Queulat": {
        "Nombre": "Queulat National Park",
        "Descripcion": "Rainforest, lagoons and hanging glaciers. There is a trail to the Ventisquero Colgante glacier.",
        "Mensaje": "Queulat nearby: the trail to the Ventisquero Colgante glacier is a must."
      },
      "Mirador Río Cisnes": {
        "Nombre": "Cisnes River Viewpoint",
        "Descripcion": "View of the Cisnes River valley.",
        "Mensaje": ""
      },
      "Mirador Lago Las Torres": {
        "Nombre": "Lake Las Torres Viewpoint",
        "Descripcion": "View of Lake Las Torres, right on the road.",
        "Mensaje": ""
      },
      "Piedra del Indio": {
        "Nombre": "Piedra del Indio (Indian Rock)",
        "Descripcion": "A rock formation that looks like the profile of a face, at the entrance to Coyhaique.",
        "Mensaje": ""
      },
      "Museo Regional de Aysén": {
        "Nombre": "Aysén Regional Museum",
        "Descripcion": "History and culture of the Aysén region.",
        "Mensaje": ""
      },
      "Iglesia del Sagrado Corazón de Puerto Varas": {
        "Nombre": "Sacred Heart Church of Puerto Varas",
        "Descripcion": "A German-style church that overlooks the town.",
        "Mensaje": ""
      },
      "Cerro Calvario": {
        "Nombre": "Cerro Calvario",
        "Descripcion": "A viewpoint in Puerto Varas, with views of the lake and the volcanoes.",
        "Mensaje": ""
      },
      "Teatro del Lago": {
        "Nombre": "Teatro del Lago",
        "Descripcion": "A theater on the lake in Frutillar, home of the Musical Weeks festival.",
        "Mensaje": ""
      },
      "Museo Colonial Alemán de Frutillar": {
        "Nombre": "Frutillar German Colonial Museum",
        "Descripcion": "Houses, a mill and tools that show the life of the German settlers.",
        "Mensaje": ""
      },
      "Zona Típica de Puerto Octay": {
        "Nombre": "Puerto Octay Historic Zone",
        "Descripcion": "A historic center with wooden houses built by German settlers.",
        "Mensaje": ""
      },
      "Playa de Ensenada": {
        "Nombre": "Ensenada Beach",
        "Descripcion": "Lakeshore with a view of the Osorno volcano.",
        "Mensaje": ""
      },
      "Saltos del Petrohué": {
        "Nombre": "Petrohué Falls",
        "Descripcion": "Turquoise waterfalls over volcanic rock. A short detour from Ensenada.",
        "Mensaje": "Petrohué Falls a few kilometers away: a short detour from Ensenada."
      },
      "Centro Interactivo Vulcanológico CIVUR": {
        "Nombre": "CIVUR Volcanology Interactive Center",
        "Descripcion": "An exhibit about the Villarrica volcano and its activity.",
        "Mensaje": ""
      },
      "Museo Histórico y Arqueológico de Villarrica": {
        "Nombre": "Villarrica Historical and Archaeological Museum",
        "Descripcion": "History of the region and of Mapuche culture.",
        "Mensaje": ""
      },
      "Costanera de Villarrica": {
        "Nombre": "Villarrica Lakefront",
        "Descripcion": "A lakeside promenade with a view of the volcano.",
        "Mensaje": ""
      },
      "Costanera de Licán Ray": {
        "Nombre": "Licán Ray Lakefront",
        "Descripcion": "Shore of Lake Calafquén, with a beach and a photo spot.",
        "Mensaje": ""
      },
      "Mirador Lago Calafquén": {
        "Nombre": "Lake Calafquén Viewpoint",
        "Descripcion": "View of Lake Calafquén from the road.",
        "Mensaje": ""
      },
      "Salto Comonahue": {
        "Nombre": "Comonahue Falls",
        "Descripcion": "A waterfall near the road to Coñaripe. Short detour.",
        "Mensaje": ""
      },
      "Termas Geométricas": {
        "Nombre": "Termas Geométricas",
        "Descripcion": "Hot springs along wooden walkways in a forest canyon. A detour from Coñaripe (about 15 km).",
        "Mensaje": "Termas Geométricas nearby: a detour worth taking."
      },
      "Pukará de Quitor": {
        "Nombre": "Pukará de Quitor",
        "Descripcion": "An ancient stone fortress on a hill, overlooking the San Pedro oasis.",
        "Mensaje": ""
      },
      "Museo Arqueológico Gustavo Le Paige": {
        "Nombre": "Gustavo Le Paige Archaeological Museum",
        "Descripcion": "Artifacts and mummies from the cultures of the Atacama desert.",
        "Mensaje": ""
      },
      "Museo del Meteorito": {
        "Nombre": "Meteorite Museum",
        "Descripcion": "A collection of meteorites found in the Atacama desert.",
        "Mensaje": ""
      },
      "Valle de la Luna": {
        "Nombre": "Valle de la Luna (Moon Valley)",
        "Descripcion": "A landscape of salt, sand and eroded rock, famous for its sunsets. A short detour from San Pedro.",
        "Mensaje": ""
      },
      "Trópico de Capricornio": {
        "Nombre": "Tropic of Capricorn",
        "Descripcion": "A marker on the Tropic of Capricorn line, right by the road.",
        "Mensaje": ""
      },
      "Lagunas Miscanti y Miñiques": {
        "Nombre": "Miscanti and Miñiques Lagoons",
        "Descripcion": "Two deep-blue altiplano lagoons beneath the volcanoes. A detour from Socaire.",
        "Mensaje": "Miscanti and Miñiques lagoons: a detour from Socaire, some of the best scenery on the route."
      },
      "Portezuelo del Cajón": {
        "Nombre": "Portezuelo del Cajón",
        "Descripcion": "A high mountain pass on the road to the Paso de Jama.",
        "Mensaje": ""
      },
      "Cerro Toco": {
        "Nombre": "Cerro Toco",
        "Descripcion": "A volcano of over 5,000 meters, visible from the road.",
        "Mensaje": ""
      },
      "Monjes de la Pacana": {
        "Nombre": "Monjes de la Pacana",
        "Descripcion": "Rock monoliths in the middle of the altiplano, near the road.",
        "Mensaje": "Monjes de la Pacana nearby: rock formations worth a look."
      },
      "Laguna Aguas Calientes": {
        "Nombre": "Aguas Calientes Lagoon",
        "Descripcion": "An altiplano lagoon by the road, a good photo stop.",
        "Mensaje": ""
      },
      "Mirante da Serra do Rio do Rastro": {
        "Nombre": "Serra do Rio do Rastro Viewpoint",
        "Descripcion": "A viewpoint over the zigzag curves of the mountain road, one of the most photographed roads in southern Brazil.",
        "Mensaje": "Serra do Rio do Rastro nearby: stop at the viewpoint, the curves are a postcard."
      },
      "Mirante Norte da Serra do Rio do Rastro": {
        "Nombre": "Serra do Rio do Rastro North Viewpoint",
        "Descripcion": "Another viewpoint over the mountain road, with a different view of the curves.",
        "Mensaje": ""
      },
      "Mirante do Parque Nacional de São Joaquim": {
        "Nombre": "São Joaquim National Park Viewpoint",
        "Descripcion": "A viewpoint in São Joaquim National Park, in the coldest highlands of Brazil.",
        "Mensaje": ""
      },
      "Cascata do Avencal": {
        "Nombre": "Avencal Waterfall",
        "Descripcion": "A waterfall near Urubici.",
        "Mensaje": ""
      },
      "Mirante de Urubici": {
        "Nombre": "Urubici Viewpoint",
        "Descripcion": "View of the mountains and the Urubici valley.",
        "Mensaje": ""
      },
      "Inscrições Rupestres de Urubici": {
        "Nombre": "Urubici Rock Inscriptions",
        "Descripcion": "A site with rock inscriptions near Urubici.",
        "Mensaje": ""
      },
      "Serra do Corvo Branco": {
        "Nombre": "Serra do Corvo Branco",
        "Descripcion": "A mountain road cut into the rock, with towering walls and viewpoints. Check the road conditions before you go.",
        "Mensaje": "Serra do Corvo Branco nearby: a stretch cut into the rock, with viewpoints."
      },
      "Cascata da Barrinha": {
        "Nombre": "Barrinha Waterfall",
        "Descripcion": "A waterfall near the road, in the mountains.",
        "Mensaje": ""
      },
      "Rua Coberta de São Ludgero": {
        "Nombre": "São Ludgero Covered Street",
        "Descripcion": "A German-style covered street in the center of São Ludgero.",
        "Mensaje": ""
      },
      "Cristo Redentor": {
        "Nombre": "Christ the Redeemer",
        "Descripcion": "Rio's most famous monument, atop Corcovado, with a view over the whole city.",
        "Mensaje": ""
      },
      "Ilha Grande": {
        "Nombre": "Ilha Grande",
        "Descripcion": "A rainforest island with beaches and no cars. You get there by boat from Angra dos Reis or Conceição de Jacareí.",
        "Mensaje": ""
      },
      "Centro Histórico de Paraty": {
        "Nombre": "Paraty Historic Center",
        "Descripcion": "Cobbled streets and 18th-century colonial houses. A UNESCO World Heritage Site.",
        "Mensaje": "Paraty nearby: its historic center is a World Heritage Site."
      },
      "Trindade": {
        "Nombre": "Trindade",
        "Descripcion": "A coastal village with beaches surrounded by rainforest, south of Paraty.",
        "Mensaje": ""
      },
      "Mirante da Praia Vermelha do Norte": {
        "Nombre": "Praia Vermelha do Norte Viewpoint",
        "Descripcion": "A viewpoint over the beach and the Ubatuba coast.",
        "Mensaje": ""
      },
      "Projeto Tamar Ubatuba": {
        "Nombre": "Projeto Tamar Ubatuba",
        "Descripcion": "A sea turtle conservation center, with an aquarium and visits.",
        "Mensaje": ""
      },
      "Centro Histórico de Ouro Preto": {
        "Nombre": "Ouro Preto Historic Center",
        "Descripcion": "A colonial city from the gold era, a UNESCO World Heritage Site since 1980.",
        "Mensaje": "Ouro Preto nearby: its historic center is a World Heritage Site."
      },
      "Igreja de São Francisco de Assis": {
        "Nombre": "Church of São Francisco de Assis",
        "Descripcion": "A baroque church with works by Aleijadinho, one of the greats of Brazilian baroque.",
        "Mensaje": ""
      },
      "Museu da Inconfidência": {
        "Nombre": "Museu da Inconfidência",
        "Descripcion": "A museum about the Inconfidência Mineira, the 1789 conspiracy, in the former town hall and jail.",
        "Mensaje": ""
      },
      "Mina do Chico Rei": {
        "Nombre": "Chico Rei Mine",
        "Descripcion": "An old gold mine open to visitors.",
        "Mensaje": ""
      },
      "Igreja Matriz de Nossa Senhora do Pilar": {
        "Nombre": "Mother Church of Our Lady of the Pillar",
        "Descripcion": "A church with carved, gold-covered altars, typical of the Minas Gerais baroque.",
        "Mensaje": ""
      },
      "Mirante do Morro São Sebastião": {
        "Nombre": "São Sebastião Hill Viewpoint",
        "Descripcion": "View of the rooftops and churches of Ouro Preto.",
        "Mensaje": ""
      },
      "Museu Regional de São João del-Rei": {
        "Nombre": "São João del-Rei Regional Museum",
        "Descripcion": "A colonial mansion with furniture and objects of the period.",
        "Mensaje": ""
      },
      "Estação Ferroviária de São João del-Rei (Maria Fumaça)": {
        "Nombre": "São João del-Rei Railway Station (Maria Fumaça)",
        "Descripcion": "Departure point of the Maria Fumaça, the historic steam train between São João del-Rei and Tiradentes. Check the operating days.",
        "Mensaje": ""
      },
      "Chafariz de São José": {
        "Nombre": "São José Fountain",
        "Descripcion": "A colonial stone fountain in the historic center of Tiradentes.",
        "Mensaje": "Tiradentes nearby: a historic center to explore on foot."
      },
      "Museu Casa Padre Toledo": {
        "Nombre": "Padre Toledo House Museum",
        "Descripcion": "A historic house in Tiradentes, tied to the Inconfidência Mineira.",
        "Mensaje": ""
      },
      "Labirinto Verde": {
        "Nombre": "Labirinto Verde (Green Maze)",
        "Descripcion": "A hedge maze and gardens in Nova Petrópolis.",
        "Mensaje": ""
      },
      "Mirante do Vale do Rio Caí": {
        "Nombre": "Caí River Valley Viewpoint",
        "Descripcion": "View of the Caí River valley from the road.",
        "Mensaje": ""
      },
      "Rua Coberta de Gramado": {
        "Nombre": "Gramado Covered Street",
        "Descripcion": "A covered street in the heart of Gramado, with cafés and shops.",
        "Mensaje": ""
      },
      "Lago Negro": {
        "Nombre": "Lago Negro (Black Lake)",
        "Descripcion": "A forest-ringed lake in Gramado, ideal for a stroll.",
        "Mensaje": ""
      },
      "Cascata Véu de Noiva": {
        "Nombre": "Véu de Noiva Waterfall",
        "Descripcion": "A waterfall near downtown Gramado.",
        "Mensaje": ""
      },
      "Catedral de Pedra de Canela": {
        "Nombre": "Canela Stone Cathedral",
        "Descripcion": "A neo-Gothic stone cathedral, the icon of Canela.",
        "Mensaje": "Canela nearby: don't miss the Stone Cathedral."
      },
      "Cascata do Caracol": {
        "Nombre": "Caracol Waterfall",
        "Descripcion": "A waterfall of over 100 meters inside Caracol State Park. A short detour from Canela.",
        "Mensaje": "Caracol Waterfall a few kilometers away: a short detour from Canela."
      }
    }
  },
  "pt": {
    "rutas": {
      "carretera-austral": {
        "Nombre": "Carretera Austral: Puerto Montt – Coyhaique",
        "Descripcion": "O grande clássico do sul do Chile: de Puerto Montt a Coyhaique pela Carretera Austral, entre fiordes, vulcões e floresta úmida. Há trechos com balsa (ferry): confira os horários antes de sair. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      },
      "llanquihue": {
        "Nombre": "Volta ao Lago Llanquihue",
        "Descripcion": "A volta completa ao lago Llanquihue: cidades de colonização alemã como Puerto Varas, Frutillar e Puerto Octay, com os vulcões Osorno e Calbuco ao fundo. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      },
      "pucon-conaripe": {
        "Nombre": "Pucón – Panguipulli – Coñaripe",
        "Descripcion": "Um circuito pelos lagos da Araucanía e Los Ríos: Pucón, Villarrica, Licán Ray, Coñaripe e Panguipulli, com o vulcão Villarrica sempre por perto. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      },
      "atacama-jama": {
        "Nombre": "San Pedro de Atacama – Paso de Jama",
        "Descripcion": "De San Pedro de Atacama rumo ao altiplano: lagoas, vulcões e salares a caminho do Paso de Jama, na fronteira com a Argentina. A estrada sobe acima dos 4.000 metros, então leve agasalho e combustível extra. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      },
      "rio-do-rastro": {
        "Nombre": "Serra do Rio do Rastro e Corvo Branco",
        "Descripcion": "Dois clássicos da serra catarinense: a Serra do Rio do Rastro, com suas curvas em zigue-zague, e a Serra do Corvo Branco, uma estrada talhada entre paredões de rocha, passando por Urubici. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      },
      "rio-santos": {
        "Nombre": "Rio–Santos: Rio de Janeiro – Ubatuba",
        "Descripcion": "A Costa Verde entre o Rio de Janeiro e Ubatuba: praias, serra e mata colados ao mar, com o centro histórico de Paraty no meio. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      },
      "estrada-real": {
        "Nombre": "Estrada Real: Ouro Preto – Tiradentes",
        "Descripcion": "Um trecho da Estrada Real de Minas Gerais entre duas joias coloniais, Ouro Preto e Tiradentes, passando por São João del-Rei. Igrejas barrocas, museus e ruas de pedra da época do ouro. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      },
      "rota-romantica": {
        "Nombre": "Rota Romântica",
        "Descripcion": "A Serra Gaúcha de influência alemã e italiana: Nova Petrópolis, Gramado, Canela e São Francisco de Paula, entre bosques, cachoeiras e cidades de ar alpino. Você escolhe o ponto de partida e o app monta o trecho até aqui."
      }
    },
    "pois": {
      "Feria y Mercado de Angelmó": {
        "Nombre": "Feira e Mercado de Angelmó",
        "Descripcion": "Feira de artesanato e mercado de frutos do mar à beira-mar, em Puerto Montt: bom lugar para começar.",
        "Mensaje": ""
      },
      "Volcán Chaitén": {
        "Nombre": "Vulcão Chaitén",
        "Descripcion": "Vulcão que entrou em erupção em 2008. Uma trilha leva até a borda da cratera.",
        "Mensaje": "Vulcão Chaitén por perto: vale a pena a trilha até a cratera."
      },
      "Mirador de Chaitén": {
        "Nombre": "Mirante de Chaitén",
        "Descripcion": "Vista de Chaitén e de sua costa no golfo.",
        "Mensaje": ""
      },
      "Parque Nacional Pumalín Douglas Tompkins": {
        "Nombre": "Parque Nacional Pumalín Douglas Tompkins",
        "Descripcion": "Trilhas entre floresta úmida, cachoeiras e vulcões. Um dos trechos mais bonitos da rota.",
        "Mensaje": "Parque Pumalín por perto: um dos melhores trechos da rota."
      },
      "Termas El Amarillo": {
        "Nombre": "Termas El Amarillo",
        "Descripcion": "Termas junto à estrada, perto do Parque Pumalín.",
        "Mensaje": ""
      },
      "Mirador Lago Yelcho": {
        "Nombre": "Mirante Lago Yelcho",
        "Descripcion": "Vista do Lago Yelcho com a cordilheira ao fundo.",
        "Mensaje": ""
      },
      "Mirador Ventisquero Yelcho": {
        "Nombre": "Mirante Geleira Yelcho",
        "Descripcion": "Vista da geleira Yelcho.",
        "Mensaje": ""
      },
      "Mirador de Puyuhuapi": {
        "Nombre": "Mirante de Puyuhuapi",
        "Descripcion": "Vista de Puyuhuapi e do seu fiorde.",
        "Mensaje": ""
      },
      "Parque Nacional Queulat": {
        "Nombre": "Parque Nacional Queulat",
        "Descripcion": "Floresta úmida, lagoas e geleiras suspensas. Há uma trilha até a geleira Ventisquero Colgante.",
        "Mensaje": "Queulat por perto: a trilha até o Ventisquero Colgante é imperdível."
      },
      "Mirador Río Cisnes": {
        "Nombre": "Mirante Rio Cisnes",
        "Descripcion": "Vista do vale do rio Cisnes.",
        "Mensaje": ""
      },
      "Mirador Lago Las Torres": {
        "Nombre": "Mirante Lago Las Torres",
        "Descripcion": "Vista do Lago Las Torres, à beira da estrada.",
        "Mensaje": ""
      },
      "Piedra del Indio": {
        "Nombre": "Piedra del Indio",
        "Descripcion": "Formação rochosa que lembra o perfil de um rosto, na entrada de Coyhaique.",
        "Mensaje": ""
      },
      "Museo Regional de Aysén": {
        "Nombre": "Museu Regional de Aysén",
        "Descripcion": "História e cultura da região de Aysén.",
        "Mensaje": ""
      },
      "Iglesia del Sagrado Corazón de Puerto Varas": {
        "Nombre": "Igreja do Sagrado Coração de Puerto Varas",
        "Descripcion": "Igreja de estilo alemão que domina a cidade.",
        "Mensaje": ""
      },
      "Cerro Calvario": {
        "Nombre": "Cerro Calvario",
        "Descripcion": "Mirante de Puerto Varas, com vista do lago e dos vulcões.",
        "Mensaje": ""
      },
      "Teatro del Lago": {
        "Nombre": "Teatro del Lago",
        "Descripcion": "Teatro à beira do lago, em Frutillar, sede das Semanas Musicais.",
        "Mensaje": ""
      },
      "Museo Colonial Alemán de Frutillar": {
        "Nombre": "Museu Colonial Alemão de Frutillar",
        "Descripcion": "Casas, moinho e ferramentas que mostram a vida dos colonos alemães.",
        "Mensaje": ""
      },
      "Zona Típica de Puerto Octay": {
        "Nombre": "Zona Típica de Puerto Octay",
        "Descripcion": "Centro histórico com casas de madeira dos colonos alemães.",
        "Mensaje": ""
      },
      "Playa de Ensenada": {
        "Nombre": "Praia de Ensenada",
        "Descripcion": "Costa do lago com vista do vulcão Osorno.",
        "Mensaje": ""
      },
      "Saltos del Petrohué": {
        "Nombre": "Saltos do Petrohué",
        "Descripcion": "Cachoeiras de água turquesa sobre rocha vulcânica. Desvio curto desde Ensenada.",
        "Mensaje": "Saltos do Petrohué a poucos quilômetros: desvio curto desde Ensenada."
      },
      "Centro Interactivo Vulcanológico CIVUR": {
        "Nombre": "Centro Interativo Vulcanológico CIVUR",
        "Descripcion": "Mostra sobre o vulcão Villarrica e sua atividade.",
        "Mensaje": ""
      },
      "Museo Histórico y Arqueológico de Villarrica": {
        "Nombre": "Museu Histórico e Arqueológico de Villarrica",
        "Descripcion": "História da região e da cultura mapuche.",
        "Mensaje": ""
      },
      "Costanera de Villarrica": {
        "Nombre": "Orla de Villarrica",
        "Descripcion": "Passeio à beira do lago com vista do vulcão.",
        "Mensaje": ""
      },
      "Costanera de Licán Ray": {
        "Nombre": "Orla de Licán Ray",
        "Descripcion": "Costa do lago Calafquén, com praia e ponto para foto.",
        "Mensaje": ""
      },
      "Mirador Lago Calafquén": {
        "Nombre": "Mirante Lago Calafquén",
        "Descripcion": "Vista do lago Calafquén desde a estrada.",
        "Mensaje": ""
      },
      "Salto Comonahue": {
        "Nombre": "Salto Comonahue",
        "Descripcion": "Cachoeira perto da estrada para Coñaripe. Desvio curto.",
        "Mensaje": ""
      },
      "Termas Geométricas": {
        "Nombre": "Termas Geométricas",
        "Descripcion": "Termas entre passarelas de madeira em um cânion na floresta. Desvio desde Coñaripe (cerca de 15 km).",
        "Mensaje": "Termas Geométricas por perto: um desvio que vale a pena."
      },
      "Pukará de Quitor": {
        "Nombre": "Pukará de Quitor",
        "Descripcion": "Antiga fortaleza de pedra sobre um morro, com vista do oásis de San Pedro.",
        "Mensaje": ""
      },
      "Museo Arqueológico Gustavo Le Paige": {
        "Nombre": "Museu Arqueológico Gustavo Le Paige",
        "Descripcion": "Peças e múmias das culturas do deserto do Atacama.",
        "Mensaje": ""
      },
      "Museo del Meteorito": {
        "Nombre": "Museu do Meteorito",
        "Descripcion": "Coleção de meteoritos encontrados no deserto do Atacama.",
        "Mensaje": ""
      },
      "Valle de la Luna": {
        "Nombre": "Valle de la Luna",
        "Descripcion": "Paisagem de sal, areia e rocha erodida, famosa pelo pôr do sol. Desvio curto desde San Pedro.",
        "Mensaje": ""
      },
      "Trópico de Capricornio": {
        "Nombre": "Trópico de Capricórnio",
        "Descripcion": "Marco sobre a linha do Trópico de Capricórnio, à beira da estrada.",
        "Mensaje": ""
      },
      "Lagunas Miscanti y Miñiques": {
        "Nombre": "Lagoas Miscanti e Miñiques",
        "Descripcion": "Duas lagoas de altiplano de azul intenso, sob os vulcões. Desvio desde Socaire.",
        "Mensaje": "Lagoas Miscanti e Miñiques: desvio desde Socaire, do mais bonito da rota."
      },
      "Portezuelo del Cajón": {
        "Nombre": "Portezuelo del Cajón",
        "Descripcion": "Passo de alta montanha na estrada para o Paso de Jama.",
        "Mensaje": ""
      },
      "Cerro Toco": {
        "Nombre": "Cerro Toco",
        "Descripcion": "Vulcão de mais de 5.000 metros, visível da estrada.",
        "Mensaje": ""
      },
      "Monjes de la Pacana": {
        "Nombre": "Monjes de la Pacana",
        "Descripcion": "Monólitos de rocha em pleno altiplano, perto da estrada.",
        "Mensaje": "Monjes de la Pacana por perto: formações rochosas que valem a visita."
      },
      "Laguna Aguas Calientes": {
        "Nombre": "Lagoa Aguas Calientes",
        "Descripcion": "Lagoa de altiplano à beira da estrada, bom ponto para fotos.",
        "Mensaje": ""
      },
      "Mirante da Serra do Rio do Rastro": {
        "Nombre": "Mirante da Serra do Rio do Rastro",
        "Descripcion": "Mirante sobre as curvas em zigue-zague da serra, uma das estradas mais fotografadas do sul do Brasil.",
        "Mensaje": "Serra do Rio do Rastro por perto: pare no mirante, as curvas são um cartão-postal."
      },
      "Mirante Norte da Serra do Rio do Rastro": {
        "Nombre": "Mirante Norte da Serra do Rio do Rastro",
        "Descripcion": "Outro mirante sobre a serra, com outra vista das curvas.",
        "Mensaje": ""
      },
      "Mirante do Parque Nacional de São Joaquim": {
        "Nombre": "Mirante do Parque Nacional de São Joaquim",
        "Descripcion": "Mirante do Parque Nacional de São Joaquim, na serra mais fria do Brasil.",
        "Mensaje": ""
      },
      "Cascata do Avencal": {
        "Nombre": "Cascata do Avencal",
        "Descripcion": "Cachoeira perto de Urubici.",
        "Mensaje": ""
      },
      "Mirante de Urubici": {
        "Nombre": "Mirante de Urubici",
        "Descripcion": "Vista da serra e do vale de Urubici.",
        "Mensaje": ""
      },
      "Inscrições Rupestres de Urubici": {
        "Nombre": "Inscrições Rupestres de Urubici",
        "Descripcion": "Sítio com inscrições rupestres perto de Urubici.",
        "Mensaje": ""
      },
      "Serra do Corvo Branco": {
        "Nombre": "Serra do Corvo Branco",
        "Descripcion": "Estrada de montanha talhada na rocha, com paredões altíssimos e mirantes. Confira as condições da estrada antes de ir.",
        "Mensaje": "Serra do Corvo Branco por perto: um trecho talhado na rocha, com mirantes."
      },
      "Cascata da Barrinha": {
        "Nombre": "Cascata da Barrinha",
        "Descripcion": "Cachoeira perto da estrada, na serra.",
        "Mensaje": ""
      },
      "Rua Coberta de São Ludgero": {
        "Nombre": "Rua Coberta de São Ludgero",
        "Descripcion": "Rua coberta de estilo alemão, no centro de São Ludgero.",
        "Mensaje": ""
      },
      "Cristo Redentor": {
        "Nombre": "Cristo Redentor",
        "Descripcion": "O monumento mais famoso do Rio, no alto do Corcovado, com vista para toda a cidade.",
        "Mensaje": ""
      },
      "Ilha Grande": {
        "Nombre": "Ilha Grande",
        "Descripcion": "Ilha de mata e praias sem carros. Chega-se de barco desde Angra dos Reis ou Conceição de Jacareí.",
        "Mensaje": ""
      },
      "Centro Histórico de Paraty": {
        "Nombre": "Centro Histórico de Paraty",
        "Descripcion": "Ruas de pedra e casarões coloniais do século XVIII. Patrimônio Mundial da UNESCO.",
        "Mensaje": "Paraty por perto: seu centro histórico é Patrimônio da Humanidade."
      },
      "Trindade": {
        "Nombre": "Trindade",
        "Descripcion": "Vila costeira com praias cercadas de mata, ao sul de Paraty.",
        "Mensaje": ""
      },
      "Mirante da Praia Vermelha do Norte": {
        "Nombre": "Mirante da Praia Vermelha do Norte",
        "Descripcion": "Mirante com vista da praia e da costa de Ubatuba.",
        "Mensaje": ""
      },
      "Projeto Tamar Ubatuba": {
        "Nombre": "Projeto Tamar Ubatuba",
        "Descripcion": "Centro de conservação de tartarugas marinhas, com aquário e visitação.",
        "Mensaje": ""
      },
      "Centro Histórico de Ouro Preto": {
        "Nombre": "Centro Histórico de Ouro Preto",
        "Descripcion": "Cidade colonial da época do ouro, Patrimônio Mundial da UNESCO desde 1980.",
        "Mensaje": "Ouro Preto por perto: seu centro histórico é Patrimônio da Humanidade."
      },
      "Igreja de São Francisco de Assis": {
        "Nombre": "Igreja de São Francisco de Assis",
        "Descripcion": "Igreja barroca com obras de Aleijadinho, um dos grandes do barroco brasileiro.",
        "Mensaje": ""
      },
      "Museu da Inconfidência": {
        "Nombre": "Museu da Inconfidência",
        "Descripcion": "Museu sobre a Inconfidência Mineira, a conspiração de 1789, na antiga Câmara e Cadeia.",
        "Mensaje": ""
      },
      "Mina do Chico Rei": {
        "Nombre": "Mina do Chico Rei",
        "Descripcion": "Antiga mina de ouro que pode ser visitada.",
        "Mensaje": ""
      },
      "Igreja Matriz de Nossa Senhora do Pilar": {
        "Nombre": "Igreja Matriz de Nossa Senhora do Pilar",
        "Descripcion": "Igreja com altares entalhados e cobertos de ouro, típica do barroco mineiro.",
        "Mensaje": ""
      },
      "Mirante do Morro São Sebastião": {
        "Nombre": "Mirante do Morro São Sebastião",
        "Descripcion": "Vista dos telhados e das igrejas de Ouro Preto.",
        "Mensaje": ""
      },
      "Museu Regional de São João del-Rei": {
        "Nombre": "Museu Regional de São João del-Rei",
        "Descripcion": "Casarão colonial com móveis e objetos da época.",
        "Mensaje": ""
      },
      "Estação Ferroviária de São João del-Rei (Maria Fumaça)": {
        "Nombre": "Estação Ferroviária de São João del-Rei (Maria Fumaça)",
        "Descripcion": "Saída da Maria Fumaça, o trem a vapor histórico entre São João del-Rei e Tiradentes. Confira os dias de funcionamento.",
        "Mensaje": ""
      },
      "Chafariz de São José": {
        "Nombre": "Chafariz de São José",
        "Descripcion": "Chafariz colonial de pedra no centro histórico de Tiradentes.",
        "Mensaje": "Tiradentes por perto: um centro histórico para percorrer a pé."
      },
      "Museu Casa Padre Toledo": {
        "Nombre": "Museu Casa Padre Toledo",
        "Descripcion": "Casa histórica de Tiradentes, ligada à Inconfidência Mineira.",
        "Mensaje": ""
      },
      "Labirinto Verde": {
        "Nombre": "Labirinto Verde",
        "Descripcion": "Labirinto de arbustos e jardins em Nova Petrópolis.",
        "Mensaje": ""
      },
      "Mirante do Vale do Rio Caí": {
        "Nombre": "Mirante do Vale do Rio Caí",
        "Descripcion": "Vista do vale do rio Caí desde a estrada.",
        "Mensaje": ""
      },
      "Rua Coberta de Gramado": {
        "Nombre": "Rua Coberta de Gramado",
        "Descripcion": "Rua coberta no coração de Gramado, com cafés e lojas.",
        "Mensaje": ""
      },
      "Lago Negro": {
        "Nombre": "Lago Negro",
        "Descripcion": "Lago cercado de mata em Gramado, ideal para um passeio.",
        "Mensaje": ""
      },
      "Cascata Véu de Noiva": {
        "Nombre": "Cascata Véu de Noiva",
        "Descripcion": "Cachoeira perto do centro de Gramado.",
        "Mensaje": ""
      },
      "Catedral de Pedra de Canela": {
        "Nombre": "Catedral de Pedra de Canela",
        "Descripcion": "Catedral neogótica de pedra, ícone de Canela.",
        "Mensaje": "Canela por perto: não perca a Catedral de Pedra."
      },
      "Cascata do Caracol": {
        "Nombre": "Cascata do Caracol",
        "Descripcion": "Cachoeira de mais de 100 metros dentro do Parque Estadual do Caracol. Desvio curto desde Canela.",
        "Mensaje": "Cascata do Caracol a poucos quilômetros: desvio curto desde Canela."
      }
    }
  }
};
PREARMADOS.push(...PREARMADOS_PAISES);
for (const l of ['en', 'pt']) {
  Object.assign(TRAD_PREARMADOS[l].rutas, TRAD_PAISES[l].rutas);
  Object.assign(TRAD_PREARMADOS[l].pois, TRAD_PAISES[l].pois);
}
// <<<

// Agrega el campo Traducciones a la ruta y a cada punto de interés.
function conTraducciones(id, datos) {
  const idiomas = ['en', 'pt'];
  const ruta = {};
  for (const l of idiomas) if (TRAD_PREARMADOS[l].rutas[id]) ruta[l] = TRAD_PREARMADOS[l].rutas[id];
  return {
    ...datos,
    Pais: datos.Pais || 'AR',
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
    if ((actual.Pais || '') !== datos.Pais) {
      await ref.update({ Pais: datos.Pais });
      console.log(`I) país "${datos.Pais}" en "${datos.Nombre}"`);
    }
    if (estable(actual.Traducciones || {}) !== estable(datos.Traducciones || {})) {
      await ref.update({ Traducciones: datos.Traducciones || {} });
      console.log(`I) traducciones actualizadas en "${datos.Nombre}"`);
    }
  }
}

// Carrusel de Inicio: la lista COMPLETA y en orden de los auspiciantes que
// aparecen, con la imagen y la página a la que lleva el toque (Link vacío =
// el banner no es cliqueable; Paises = en qué países se muestra, vacío = en
// todos, ej. ['AR'] o ['BR', 'CL']). Es la única fuente: para sumar, sacar o
// cambiar un link, editar esta lista y volver a correr el robot — no hace
// falta build de la app. Ojo: lo que se edite a mano en Firestore
// (config/auspiciantes.Auspiciantes) se pisa en la próxima corrida.
const AUSPICIANTES_INICIO = [
  { Nombre: 'FOS', Imagen: 'https://motoappviajes.web.app/auspiciantes/fos.jpg', Link: 'https://www.fos.com.ar/', Paises: ['AR'] },
  // Oyambre va con WhatsApp (https://wa.me/549<código de área><número>, sin 0 ni 15); falta el número.
  { Nombre: 'Café Oyambre', Imagen: 'https://motoappviajes.web.app/auspiciantes/oyambre.jpg', Link: '', Paises: ['AR'] },
  { Nombre: 'MR Services', Imagen: 'https://motoappviajes.web.app/auspiciantes/mr.jpg', Link: 'https://mrservices.com.ar/', Paises: ['AR'] },
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
