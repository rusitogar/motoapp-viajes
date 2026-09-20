// Baja el precio promedio de la nafta súper y lo escribe en nafta.json (que
// lee la app). Lo corre la GitHub Action una vez por mes.
//   - Argentina: promedio nacional de la Secretaría de Energía (datos abiertos).
//     Va en los campos de siempre (precio_litro_super…) para las versiones viejas.
//   - Otros países: dentro de `paises` (clave = código de país), en su moneda:
//       BR: ANP (Agência Nacional do Petróleo), levantamiento semanal de precios.
//       CL: CNE (Comisión Nacional de Energía), planilla mensual de precios a público
//           por región (gasolina 93), sin necesidad de token.
//     Para sumar otro país: escribir su función `precioXX()` y agregarla a PAISES.
// Cada fuente es independiente: si una falla se conserva el último valor.
import { writeFileSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const UA = { 'User-Agent': 'motoapp-viajes-bot' };
const hoy = new Date().toISOString().slice(0, 10);

let anterior = {};
try {
  anterior = JSON.parse(readFileSync('nafta.json', 'utf8'));
} catch {}

/** Si el salto es enorme (>40%) casi seguro es un error de la fuente. */
function saltoRaro(previo, nuevo) {
  if (!previo) return false;
  const r = nuevo / previo;
  return r > 1.4 || r < 0.6;
}

// --- Argentina --------------------------------------------------------------
async function precioAR() {
  const RESOURCE = '80ac25de-a44a-4445-9215-090cf55cfda5';
  const PRODUCTO = 'Nafta (súper) entre 92 y 95 Ron';
  const sql =
    `SELECT ROUND(AVG(precio)::numeric,2) AS prom, COUNT(*) AS n ` +
    `FROM "${RESOURCE}" WHERE producto = '${PRODUCTO.replace(/'/g, "''")}'`;
  const url =
    `http://datos.energia.gob.ar/api/3/action/datastore_search_sql?sql=` +
    encodeURIComponent(sql);
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const row = (await res.json())?.result?.records?.[0];
  const precio = Number(row?.prom);
  const n = Number(row?.n);
  if (!precio || !isFinite(precio) || precio < 100 || n < 100) {
    throw new Error(`Dato sospechoso: precio=${precio} n=${n}`);
  }
  if (saltoRaro(anterior.precio_litro_super, precio)) {
    throw new Error(`Cambio demasiado grande (${anterior.precio_litro_super} -> ${precio})`);
  }
  return {
    precio_litro_super: precio,
    muestras: n,
    producto: PRODUCTO,
    fuente: 'Secretaría de Energía (datos.energia.gob.ar) - Resolución 314/2016',
    actualizado: hoy,
  };
}

// --- Brasil -----------------------------------------------------------------
async function precioBR() {
  const url =
    'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus/ultimas-4-semanas-gasolina-etanol.csv';
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const texto = (await res.text()).replace(/^﻿/, '');
  const lineas = texto.split(/\r?\n/);
  const cab = lineas[0].split(';').map((c) => c.trim());
  const iProd = cab.indexOf('Produto');
  const iValor = cab.indexOf('Valor de Venda');
  if (iProd < 0 || iValor < 0) throw new Error('Cambió el formato del archivo de la ANP');
  let suma = 0;
  let n = 0;
  for (let i = 1; i < lineas.length; i++) {
    const c = lineas[i].split(';');
    if ((c[iProd] || '').trim() !== 'GASOLINA') continue; // gasolina común
    const v = Number((c[iValor] || '').replace(',', '.'));
    if (v > 2 && v < 20) {
      suma += v;
      n++;
    }
  }
  if (n < 1000) throw new Error(`Pocas muestras de la ANP: ${n}`);
  const precio = Math.round((suma / n) * 100) / 100;
  const previo = anterior.paises && anterior.paises.BR && anterior.paises.BR.precio_litro;
  if (saltoRaro(previo, precio)) throw new Error(`Cambio demasiado grande (${previo} -> ${precio})`);
  return {
    precio_litro: precio,
    moneda: 'BRL',
    simbolo: 'R$',
    muestras: n,
    producto: 'Gasolina comum',
    fuente: 'ANP - Levantamento de Preços de Combustíveis (gov.br/anp)',
    actualizado: hoy,
  };
}


// --- Chile ------------------------------------------------------------------
/** Lee un .xlsx (que es un zip) con lo que trae Node, sin instalar nada. */
function leerZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('No es un zip válido');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const archivos = new Map();
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Directorio del zip dañado');
    const metodo = buf.readUInt16LE(p + 10);
    const tam = buf.readUInt32LE(p + 20);
    const nombreLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const comLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('utf8', p + 46, p + 46 + nombreLen);
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.subarray(ini, ini + tam);
    archivos.set(nombre, metodo === 0 ? datos : inflateRawSync(datos));
    p += 46 + nombreLen + extraLen + comLen;
  }
  return archivos;
}

async function precioCL() {
  // El nombre del archivo cambia cada mes: se busca el link en la página de la CNE.
  const pagina = await (await fetch('https://www.cne.cl/en/estadisticas/hidrocarburo/', { headers: UA })).text();
  const m = pagina.match(/https:\/\/www\.cne\.cl\/wp-content\/uploads\/[^"'\s]*precios_comb_liquidos_en_el_pais[^"'\s]*\.xlsx/);
  if (!m) throw new Error('No encontré el link de la planilla de la CNE');
  const res = await fetch(m[0], { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} bajando la planilla`);
  const zip = leerZip(Buffer.from(await res.arrayBuffer()));

  // hoja "Gasolina 93 sp"
  const libro = zip.get('xl/workbook.xml').toString('utf8');
  const rels = zip.get('xl/_rels/workbook.xml.rels').toString('utf8');
  const hoja = [...libro.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
    .find((x) => /93/.test(x[1]) && /gasolina/i.test(x[1]));
  if (!hoja) throw new Error('No encontré la hoja de gasolina 93');
  const rel = [...rels.matchAll(/<Relationship [^>]*>/g)].map((x) => x[0])
    .find((t) => t.includes(`Id="${hoja[2]}"`));
  const destino = rel && rel.match(/Target="([^"]+)"/);
  if (!destino) throw new Error('No encontré la hoja en el libro');
  const xml = zip.get('xl/' + destino[1].replace(/^\/?(xl\/)?/, '')).toString('utf8');

  // última fila con precios (columnas C..R = Región Metropolitana y las demás regiones)
  const filas = [...xml.matchAll(/<row [^>]*>(.*?)<\/row>/gs)].map((x) => x[1]);
  let valores = [];
  let fecha = null;
  for (let i = filas.length - 1; i >= 0; i--) {
    const cel = {};
    for (const c of filas[i].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<f>.*?<\/f>)?(?:<v>(.*?)<\/v>)?)/gs)) {
      if (c[3] === undefined || /t="(s|str|inlineStr)"/.test(c[2])) continue;
      cel[c[1]] = Number(c[3]);
    }
    const v = 'CDEFGHIJKLMNOPQR'.split('').map((k) => cel[k]).filter((n) => n > 500 && n < 5000);
    if (v.length >= 10) {
      valores = v;
      if (cel.B) fecha = new Date(Math.round((cel.B - 25569) * 86400000)).toISOString().slice(0, 10);
      break;
    }
  }
  if (valores.length < 10) throw new Error('No encontré una fila con precios');
  const precio = Math.round(valores.reduce((a, b) => a + b, 0) / valores.length);
  const previo = anterior.paises && anterior.paises.CL && anterior.paises.CL.precio_litro;
  if (saltoRaro(previo, precio)) throw new Error(`Cambio demasiado grande (${previo} -> ${precio})`);
  return {
    precio_litro: precio,
    moneda: 'CLP',
    simbolo: '$',
    muestras: valores.length,
    producto: 'Gasolina 93 (promedio de las regiones)',
    fuente: 'CNE - Precios observados a público, promedios por región (cne.cl)',
    dato_de: fecha,
    actualizado: hoy,
  };
}

const PAISES = { BR: precioBR, CL: precioCL };

const salida = { ...anterior };
let fallas = 0;

try {
  Object.assign(salida, await precioAR());
  console.log('AR actualizado:', salida.precio_litro_super);
} catch (e) {
  fallas++;
  console.error('AR: no se actualiza (se conserva el anterior):', e.message);
}

salida.paises = { ...(anterior.paises || {}) };
for (const [codigo, fn] of Object.entries(PAISES)) {
  try {
    salida.paises[codigo] = await fn();
    console.log(`${codigo} actualizado:`, salida.paises[codigo].precio_litro);
  } catch (e) {
    fallas++;
    console.error(`${codigo}: no se actualiza (se conserva el anterior):`, e.message);
  }
}

writeFileSync('nafta.json', JSON.stringify(salida, null, 2) + '\n');
console.log('nafta.json escrito. Fuentes con problemas:', fallas);
