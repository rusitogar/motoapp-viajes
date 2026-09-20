// Baja el precio promedio de la nafta súper y lo escribe en nafta.json (que
// lee la app). Lo corre la GitHub Action una vez por mes.
//   - Argentina: promedio nacional de la Secretaría de Energía (datos abiertos).
//     Va en los campos de siempre (precio_litro_super…) para las versiones viejas.
//   - Otros países: dentro de `paises` (clave = código de país), en su moneda:
//       BR: ANP (Agência Nacional do Petróleo), levantamiento semanal de precios.
//     Para sumar otro país: escribir su función `precioXX()` y agregarla a PAISES.
// Cada fuente es independiente: si una falla se conserva el último valor.
import { writeFileSync, readFileSync } from 'node:fs';

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

const PAISES = { BR: precioBR };

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
