// ─────────────────────────────────────────────────────────────────────────────
// scraper.js — Agente 1: Scraper diario del fixture
//
// Estructura real del HTML:
//   <table> Marzo&nbsp;&nbsp;2026 </table>      ← header de mes
//   <table> 26 | Jueves | TorIdd=X | Nombre     ← torneo (día + semana + link)
//   <table> 19 | Jueves | TorIdd=Y | Nombre
//   ...
//   <table> Febrero&nbsp;&nbsp;2026 </table>    ← siguiente mes
//   <table> 28 | Sábado | TorIdd=Z | Nombre
//
// Estrategia:
//   1. Dividir HTML por headers de mes
//   2. En cada sección, extraer torneos con su día y día de semana
//   3. Fecha = día del HTML + mes/año del header de sección
// ─────────────────────────────────────────────────────────────────────────────

import fs    from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const CLUB        = process.env.CLUB || "JURADO";
const FIXTURE_URL = `http://www.vistagolf.com.ar/paginas/inclusion/aspb/fixture.asp?club=${CLUB}`;
const OUTPUT_FILE = "./tournaments.json";
const TIMEOUT_MS  = 60000;

const MONTH_MAP = {
  enero: "01", febrero: "02", marzo: "03", abril: "04",
  mayo: "05", junio: "06", julio: "07", agosto: "08",
  septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

// ─── Función principal ────────────────────────────────────────────────────────

async function scrapeTournaments() {
  console.log(`🔍 Scrapeando fixture de ${CLUB}...`);
  console.log(`   URL: ${FIXTURE_URL}\n`);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  let html;
  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(FIXTURE_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-AR,es;q=0.9",
        "Connection":      "keep-alive",
      },
    });

    clearTimeout(timer);
    const buffer = await res.arrayBuffer();
    html = new TextDecoder("iso-8859-1").decode(buffer);
    console.log(`   📄 HTML recibido: ${html.length} chars\n`);

  } catch (err) {
    if (err.name === "AbortError") {
      console.error(`❌ Timeout: la página no respondió en ${TIMEOUT_MS / 1000} segundos`);
    } else {
      console.error("❌ Error al obtener el fixture:", err.message);
    }
    process.exit(1);
  }

  // ── Dividir HTML por secciones de mes ─────────────────────────────────────
  // El header de mes tiene formato: "Marzo&nbsp;&nbsp;2026" dentro de un <td>
  // Regex para detectar headers de mes:
  const monthHeaderRegex = /([A-Za-záéíóúñ]+)(?:&nbsp;)+(\d{4})/gi;

  // Encontrar todas las posiciones de headers de mes en el HTML
  const sections = [];
  let mh;
  while ((mh = monthHeaderRegex.exec(html)) !== null) {
    const monthName = mh[1].toLowerCase();
    const year      = mh[2];
    if (MONTH_MAP[monthName]) {
      sections.push({
        monthNum:  MONTH_MAP[monthName],
        monthName: mh[1],
        year,
        startPos:  mh.index,
      });
    }
  }

  // Agregar posición final para delimitar la última sección
  sections.push({ startPos: html.length });

  console.log(`   📅 Secciones de mes encontradas: ${sections.length - 1}`);
  sections.slice(0, -1).forEach(s =>
    console.log(`      ${s.monthName} ${s.year} (pos: ${s.startPos})`)
  );
  console.log();

  // ── Parsear torneos por sección ───────────────────────────────────────────
  const tournaments = [];
  const seen        = new Set();

  for (let i = 0; i < sections.length - 1; i++) {
    const section    = sections[i];
    const nextStart  = sections[i + 1].startPos;
    const sectionHtml = html.substring(section.startPos, nextStart);

    const { monthNum, monthName, year } = section;

    // Regex para cada torneo dentro de la sección:
    // Captura: día numérico, día de semana, TorIdd, nombre del torneo
    //
    // Estructura:
    //   <span class="style6"> 26 </span></td>
    //   <td ... class="style6"> Jueves </td>
    //   ...
    //   <a href="carga.asp?TorIdd=-666641582&amp;club=JURADO" class="style6">
    //   18 HOYOS MEDAL PLAY JUEVES 26/03/2026 </a>

    const tournamentRegex =
      /class="style6">\s*(\d{1,2})\s*<\/span><\/td>\s*<td[^>]+class="style6">\s*(Lunes|Martes|Mi[eé]rcoles|Jueves|Viernes|S[aá]bado|Domingo)\s*<\/td>[\s\S]{0,600}?href="carga\.asp\?TorIdd=(-?\d+)&amp;club=[^"]+"\s+class="[^"]*">\s*\n?\s*([^\n<]+?)\s*<\/a>/gi;

    let match;
    while ((match = tournamentRegex.exec(sectionHtml)) !== null) {
      const day     = match[1].trim().padStart(2, "0");
      const weekDay = match[2].trim();
      const torIdd  = match[3].trim();
      const name    = match[4].trim();

      if (seen.has(torIdd)) continue;
      seen.add(torIdd);

      // Fecha usando día del HTML + mes/año del header de sección
      const fecha = `${year}-${monthNum}-${day}`;

      tournaments.push({
        torIdd,
        name,
        date:       fecha,
        weekDay,
        club:       CLUB,
        teeTimeUrl: `http://www.vistagolf.com.ar/paginas/inclusion/aspb/tee_time.asp?TorIdd=${torIdd}&club=${CLUB}`,
      });
    }
  }

  // ── Resultado ─────────────────────────────────────────────────────────────
  if (tournaments.length === 0) {
    console.warn("⚠️  No se encontraron torneos. Guardando HTML para debug...");
    fs.writeFileSync("./debug_fixture.html", html, "utf-8");
    process.exit(1);
  }

  // Ordenar por fecha ascendente
  tournaments.sort((a, b) => a.date.localeCompare(b.date));

  // Detectar el mes más reciente para el label
  const latestSection = sections.slice(0, -1).sort((a, b) =>
    `${b.year}-${b.monthNum}`.localeCompare(`${a.year}-${a.monthNum}`)
  )[0];
  const monthLabel = latestSection
    ? `${latestSection.monthName} ${latestSection.year}`
    : "";

  const output = {
    club:      CLUB,
    fetchedAt: new Date().toISOString(),
    month:     monthLabel,
    tournaments,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");

  console.log(`✅ ${tournaments.length} torneos guardados en ${OUTPUT_FILE}\n`);

  // Mostrar solo los próximos 10
  const todayStr  = new Date().toISOString().split("T")[0];
  const upcoming  = tournaments.filter(t => t.date >= todayStr).slice(0, 10);
  console.log(`📅 Próximos ${upcoming.length} torneos:`);
  upcoming.forEach(t =>
    console.log(`   ${t.date} (${t.weekDay}) — ${t.name} [${t.torIdd}]`)
  );
}

scrapeTournaments();