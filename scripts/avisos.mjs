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

async function sembrarPrearmados() {
  for (const { id, ...datos } of PREARMADOS) {
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
    // Los puntos de interés se definen acá (única fuente): si cambian, se pisan.
    if (JSON.stringify(actual.Puntos_Interes || []) !== JSON.stringify(datos.Puntos_Interes || [])) {
      await ref.update({ Puntos_Interes: datos.Puntos_Interes || [] });
      console.log(`I) puntos de interés actualizados en "${datos.Nombre}" (${(datos.Puntos_Interes || []).length})`);
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
