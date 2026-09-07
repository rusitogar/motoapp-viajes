// Baja el promedio nacional de nafta súper de la Secretaría de Energía y
// lo escribe en nafta.json (que lee la app). Lo corre la GitHub Action.
import { writeFileSync, readFileSync } from 'node:fs';

const RESOURCE = '80ac25de-a44a-4445-9215-090cf55cfda5';
const PRODUCTO = 'Nafta (súper) entre 92 y 95 Ron';

const sql =
  `SELECT ROUND(AVG(precio)::numeric,2) AS prom, COUNT(*) AS n ` +
  `FROM "${RESOURCE}" WHERE producto = '${PRODUCTO.replace(/'/g, "''")}'`;
const url =
  `http://datos.energia.gob.ar/api/3/action/datastore_search_sql?sql=` +
  encodeURIComponent(sql);

const res = await fetch(url, { headers: { 'User-Agent': 'motoapp-viajes-bot' } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const json = await res.json();

const row = json?.result?.records?.[0];
const precio = Number(row?.prom);
const n = Number(row?.n);
if (!precio || !isFinite(precio) || precio < 100 || n < 100) {
  throw new Error(`Dato sospechoso de la fuente: precio=${precio} n=${n}`);
}

let anterior = {};
try {
  anterior = JSON.parse(readFileSync('nafta.json', 'utf8'));
} catch {}

// Si el salto es enorme (>40%) no piso el valor: casi seguro es un error.
if (anterior.precio_litro_super) {
  const ratio = precio / anterior.precio_litro_super;
  if (ratio > 1.4 || ratio < 0.6) {
    console.error(
      `Cambio demasiado grande (${anterior.precio_litro_super} -> ${precio}). No se actualiza.`
    );
    process.exit(0);
  }
}

const salida = {
  precio_litro_super: precio,
  muestras: n,
  producto: PRODUCTO,
  fuente:
    'Secretaría de Energía (datos.energia.gob.ar) - Resolución 314/2016',
  actualizado: new Date().toISOString().slice(0, 10),
};

writeFileSync('nafta.json', JSON.stringify(salida, null, 2) + '\n');
console.log('nafta.json actualizado:', salida);
