// ─────────────────────────────────────────────────────────────────────────────
// teeTimeAgent.js — Agente 2: Consultor de tee times
//
// Exporta:
//   isTournamentQuery(message) → boolean
//   getTournamentInfo(message) → string con respuesta para WhatsApp
// ─────────────────────────────────────────────────────────────────────────────

import fs    from "fs";
import fetch from "node-fetch";
import config from "./config.js";

const TOURNAMENTS_FILE = "./tournaments.json";
const CLUB             = process.env.CLUB || "JURADO";
const TIMEOUT_MS       = 30000;
const MAX_RETRIES      = 3;
const BOT_TIMEZONE     = config.businessHours?.timezone || "America/Argentina/Buenos_Aires";

// ─── Helpers de fecha ─────────────────────────────────────────────────────────

function getZonedDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  return { year, month, day };
}

function createDateAtNoon(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function today() {
  const { year, month, day } = getZonedDateParts();
  return createDateAtNoon(year, month, day);
}

function daysFromNow(n) {
  const d = today();
  d.setDate(d.getDate() + n);
  return d;
}

function toDate(dateStr) {
  // dateStr formato: YYYY-MM-DD
  const [y, m, d] = dateStr.split("-").map(Number);
  return createDateAtNoon(y, m, d);
}

function toDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isFuture(dateStr) {
  return toDate(dateStr) >= today();
}

function isWithinDays(dateStr, days) {
  const d = toDate(dateStr);
  return d >= today() && d <= daysFromNow(days);
}

// ─── Cache de torneos ─────────────────────────────────────────────────────────

let tournamentsCache = null;
let cacheDate        = null;

function loadTournaments() {
  const todayStr = toDateString(today());
  if (tournamentsCache && cacheDate === todayStr) return tournamentsCache;

  try {
    const raw        = fs.readFileSync(TOURNAMENTS_FILE, "utf-8");
    tournamentsCache = JSON.parse(raw);
    cacheDate        = todayStr;
    console.log(`  📋 Torneos cargados: ${tournamentsCache.tournaments.length}`);
    return tournamentsCache;
  } catch {
    console.error("  ❌ No se pudo leer tournaments.json — corré node scraper.js primero");
    return null;
  }
}

function getRelativeTargetDate(message) {
  const lower = message.toLowerCase();

  if (lower.includes("pasado mañana") || lower.includes("pasado manana")) {
    return daysFromNow(2);
  }

  if (lower.includes("mañana") || lower.includes("manana")) {
    return daysFromNow(1);
  }

  if (lower.includes("hoy")) {
    return today();
  }

  return null;
}

function getRelativeDateLabel(message) {
  const lower = message.toLowerCase();

  if (lower.includes("pasado mañana") || lower.includes("pasado manana")) {
    return "pasado mañana";
  }

  if (lower.includes("mañana") || lower.includes("manana")) {
    return "mañana";
  }

  if (lower.includes("hoy")) {
    return "hoy";
  }

  return null;
}

// ─── Limpiar texto de celda HTML ──────────────────────────────────────────────

function cleanCell(raw) {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Franjas horarias ─────────────────────────────────────────────────────────

function getSlotFranja(hora) {
  const [h, m] = hora.split(":").map(Number);
  const mins = h * 60 + m;
  if (mins < 11 * 60)  return "mañana";
  if (mins < 14 * 60)  return "mediodia";
  if (mins < 17 * 60)  return "tarde";
  return "ultimas";
}

const FRANJA_CONFIG = {
  "mañana":   { emoji: "🌅", label: "Mañana (hasta las 11)" },
  "mediodia": { emoji: "☀️",  label: "Mediodía (11 - 14)" },
  "tarde":    { emoji: "🌤️", label: "Tarde (14 - 17)" },
  "ultimas":  { emoji: "🌇", label: "Últimas horas (17+)" },
};

const FRANJA_ORDEN = ["mañana", "mediodia", "tarde", "ultimas"];

// ─── Fetch con reintentos ─────────────────────────────────────────────────────

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res        = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      console.warn(`  ⚠️  Intento ${attempt}/${retries} fallido: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ─── Fetch de tee times ───────────────────────────────────────────────────────

async function fetchTeeTimeData(torIdd) {
  const url = `http://www.vistagolf.com.ar/paginas/inclusion/aspb/tee_time.asp?TorIdd=${torIdd}&club=${CLUB}`;
  console.log(`  🌐 Fetching: ${url}`);

  try {
    const res = await fetchWithRetry(url, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-AR,es;q=0.9",
        "Connection":      "keep-alive",
      },
    });

    const buffer = await res.arrayBuffer();
    const html   = new TextDecoder("iso-8859-1").decode(buffer);
    console.log(`  📄 HTML recibido: ${html.length} chars`);
    return parseTeeTimeHtml(html, torIdd);

  } catch (err) {
    console.error(`  ❌ Error fetching tee times:`, err.message);
    return null;
  }
}

// ─── Parser de tee times ──────────────────────────────────────────────────────
// Cada horario es una <table id="TABLE1"> separada.
// Extrae el texto limpio de cada <td> y lo procesa.

function parseTeeTimeHtml(html, torIdd) {
  const slots = [];

  const titleMatch     = html.match(/href="[^"]*fixture\.asp[^"]*">\s*([^<]+?)\s*<\/a>/i);
  const tournamentName = titleMatch ? titleMatch[1].trim() : "Torneo";

  // Dividir por cada tabla de tee time
  const tableBlocks = html.split(/<table[^>]+id="TABLE1"[^>]*>/i);

  for (let i = 1; i < tableBlocks.length; i++) {
    const block     = tableBlocks[i];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells     = [];
    let cellMatch;

    while ((cellMatch = cellRegex.exec(block)) !== null) {
      const text = cleanCell(cellMatch[1]);
      if (text) cells.push(text);
    }

    if (cells.length < 5) continue;

    // La primera celda con formato HH:MM Hx es la hora
    const horaCell = cells.find(c => /^\d{2}:\d{2}\s+H\d/.test(c));
    if (!horaCell) continue;

    const hora      = horaCell.match(/(\d{2}:\d{2})/)[1];
    const horaIndex = cells.indexOf(horaCell);
    const players   = cells
      .slice(horaIndex + 1, horaIndex + 5)
      .map(p => p.replace(/\s*H\d\s*$/, "").trim());

    if (players.length < 4) continue;

    const isEmpty     = players.every(p => p === "-" || p === "");
    const allFull     = players.every(p => p !== "-" && p !== "" && p.toUpperCase() !== "RESERVADO");
    const hasReserved = players.some(p => p.toUpperCase() === "RESERVADO");
    const freePlaces  = players.filter(p => p === "-" || p === "").length;

    let status;
    if (isEmpty)          status = "libre";
    else if (allFull)     status = "completo";
    else if (hasReserved) status = "reservado";
    else                  status = "parcial";

    slots.push({ hora, status, players, freePlaces });
  }

  console.log(`  ⛳ Slots: ${slots.length} | libres: ${slots.filter(s => s.status === "libre").length} | parciales: ${slots.filter(s => s.status === "parcial").length}`);
  return { tournamentName, torIdd, slots };
}

// ─── Detectar intención del usuario ──────────────────────────────────────────

export function isTournamentQuery(message) {
  const lower = message.toLowerCase();
  const strongKeywords = [
    "tee time", "teetime", "horario disponible", "horarios disponibles",
    "turno disponible", "turnos disponibles", "hay lugar", "hay lugares",
    "queda lugar", "quedan lugares", "disponibilidad", "slot",
    "reserva", "reservar", "anotarme", "inscrib", "inscripcion",
    "torneo", "fixture",
  ];

  const dayKeywords = [
    "hoy", "mañana", "manana", "pasado mañana", "pasado manana",
    "lunes", "martes", "miercoles", "miércoles", "jueves",
    "viernes", "sabado", "sábado", "domingo",
    "esta semana", "este fin", "fin de semana", "este mes",
  ];

  const hasStrongKeyword = strongKeywords.some(kw => lower.includes(kw));
  const hasDayKeyword = dayKeywords.some(kw => lower.includes(kw));
  const hasDatePattern =
    /\b\d{1,2}\/\d{1,2}\b/.test(lower) ||
    /\b\d{1,2}\s+de\s+[a-záéíóú]+\b/i.test(lower);

  // Evitar derivar consultas generales tipo "quiero aprender/jugar golf".
  if (lower.includes("jugar al golf") || lower.includes("aprender golf") || lower.includes("como jugar al golf") || lower.includes("cómo jugar al golf")) {
    return false;
  }

  // Derivar solo si hay intención clara de agenda/disponibilidad o torneo puntual.
  return hasStrongKeyword || hasDayKeyword || hasDatePattern;
}

// ─── Respuesta principal ──────────────────────────────────────────────────────

export async function getTournamentInfo(userMessage) {
  const data = loadTournaments();

  if (!data) {
    return "No tengo información de torneos cargada. Por favor contactate con la secretaría del club. 📋";
  }

  const { tournaments, month } = data;
  const lower = userMessage.toLowerCase();

  // ── Consulta general: qué torneos hay ────────────────────────────────────
  const isGeneralQuery =
    lower.includes("qué hay")     || lower.includes("que hay")  ||
    lower.includes("cuáles")      || lower.includes("cuales")   ||
    lower.includes("fixture")     || lower.includes("este mes") ||
    lower.includes("esta semana") ||
    (lower.includes("torneo") &&
      !lower.includes("horario") && !lower.includes("tee")      &&
      !lower.includes("sábado")  && !lower.includes("sabado")   &&
      !lower.includes("domingo") && !lower.includes("disponible"));

  if (isGeneralQuery) {
    const upcoming = tournaments.filter(t => isFuture(t.date));

    if (upcoming.length === 0) {
      return `No hay torneos próximos para ${month}. Consultá la secretaría para más info. 📋`;
    }

    let response = `📅 *Torneos próximos — ${month}:*\n\n`;
    upcoming.slice(0, 8).forEach(t => {
      const [y, m, d] = t.date.split("-");
      response += `• *${d}/${m}* (${t.weekDay}) — ${t.name}\n`;
    });
    if (upcoming.length > 8) response += `\n_...y ${upcoming.length - 8} torneos más._`;
    response += `\n\n¿Querés ver los horarios de alguno? Decime el nombre o la fecha 🏌️`;
    return response;
  }

  // ── Buscar torneo específico ───────────────────────────────────────────────
  let targetTournament = null;

  // 0. Por fecha relativa: hoy / mañana / pasado mañana
  const relativeTargetDate = getRelativeTargetDate(lower);
  const relativeDateLabel = getRelativeDateLabel(lower);
  if (relativeTargetDate) {
    const relativeDateStr = toDateString(relativeTargetDate);
    targetTournament = tournaments.find(t => t.date === relativeDateStr);

    if (!targetTournament) {
      const day = String(relativeTargetDate.getDate()).padStart(2, "0");
      const month = String(relativeTargetDate.getMonth() + 1).padStart(2, "0");
      return `No encontré torneos para *${relativeDateLabel}* (${day}/${month}). Si querés, decime otra fecha y te digo los tee times. 📅`;
    }
  }

  // 1. Por día de semana — buscar el próximo que coincida (solo futuros)
  const weekDayMap = {
    "lunes":      "Lunes",
    "martes":     "Martes",
    "miércoles":  "Miércoles",
    "miercoles":  "Miércoles",
    "jueves":     "Jueves",
    "viernes":    "Viernes",
    "sábado":     "Sábado",
    "sabado":     "Sábado",
    "domingo":    "Domingo",
  };
  for (const [key, val] of Object.entries(weekDayMap)) {
    if (lower.includes(key)) {
      targetTournament = tournaments.find(t =>
        isWithinDays(t.date, 7) && t.weekDay === val
      );
      if (!targetTournament) {
        targetTournament = tournaments.find(t =>
          isWithinDays(t.date, 30) && t.weekDay === val
        );
      }
      if (targetTournament) break;
    }
  }

  // 2. Por número de día y mes mencionados — ej: "26 de abril", "25/04"
  if (!targetTournament) {
    const dayMesMatch = userMessage.match(/(\d{1,2})\s+de\s+([a-záéíóú]+)/i) ||
                        userMessage.match(/(\d{1,2})\/(\d{1,2})/);

    const MONTH_NAMES = {
      enero:"01", febrero:"02", marzo:"03", abril:"04",
      mayo:"05", junio:"06", julio:"07", agosto:"08",
      septiembre:"09", octubre:"10", noviembre:"11", diciembre:"12",
    };

    if (dayMesMatch) {
      const dayNum  = dayMesMatch[1].padStart(2, "0");
      const mesRaw  = dayMesMatch[2].toLowerCase();
      const mesNum  = MONTH_NAMES[mesRaw] || mesRaw.padStart(2, "0");
      const yearStr = new Date().getFullYear();

      const targetDateStr = `${yearStr}-${mesNum}-${dayNum}`;
      const targetDate    = toDate(targetDateStr);

      targetTournament = tournaments.find(t => {
        const tDate = toDate(t.date);
        return tDate.getDate()     === targetDate.getDate() &&
               tDate.getMonth()    === targetDate.getMonth() &&
               tDate.getFullYear() === targetDate.getFullYear() &&
               isFuture(t.date);
      });
    }
  }

  // 3. Por número de día solo — buscar solo en futuros
  if (!targetTournament) {
    const dayMatch = userMessage.match(/\b(\d{1,2})\b/);
    if (dayMatch) {
      const dayNum = parseInt(dayMatch[1]);

      targetTournament = tournaments.find(t => {
        const tDate = toDate(t.date);
        return tDate.getDate() === dayNum && isWithinDays(t.date, 7);
      });

      if (!targetTournament) {
        targetTournament = tournaments.find(t => {
          const tDate = toDate(t.date);
          return tDate.getDate() === dayNum && isWithinDays(t.date, 30);
        });
      }
    }
  }

  // 4. Por palabras del nombre — solo futuros
  if (!targetTournament) {
    const words = lower.split(/\s+/).filter(w => w.length > 4);
    targetTournament = tournaments.find(t =>
      isFuture(t.date) && words.some(w => t.name.toLowerCase().includes(w))
    );
  }

  // 5. Fallback: próximo torneo futuro
  if (!targetTournament) {
    targetTournament = tournaments.find(t => isFuture(t.date));
  }

  if (!targetTournament) {
    return "No encontré torneos próximos. ¿Podés decirme la fecha o el nombre del torneo? 📅";
  }

  // ── Fetch tee times en tiempo real ────────────────────────────────────────
  console.log(`  ⛳ Consultando: ${targetTournament.name} [${targetTournament.torIdd}]`);

  const teeData   = await fetchTeeTimeData(targetTournament.torIdd);
  const [y, m, d] = targetTournament.date.split("-");

  if (!teeData || teeData.slots.length === 0) {
    return (
      `No pude obtener los horarios de *${targetTournament.name}* (${d}/${m}). ` +
      `El servidor del club puede estar lento. Intentá de nuevo en unos minutos o consultá en: ${targetTournament.teeTimeUrl}`
    );
  }

  // ── Filtrar slots disponibles ─────────────────────────────────────────────
  const availableSlots = teeData.slots.filter(s => s.status === "libre" || s.status === "parcial");
  const totalSlots     = teeData.slots.length;

  if (availableSlots.length === 0) {
    return (
      `El torneo *${targetTournament.name}* del *${d}/${m} (${targetTournament.weekDay})* ` +
      `no tiene lugares disponibles. Está completo. 🏌️`
    );
  }

  // ── Agrupar por franja horaria ────────────────────────────────────────────
  const porFranja = {};
  for (const slot of availableSlots) {
    const franja = getSlotFranja(slot.hora);
    if (!porFranja[franja]) porFranja[franja] = [];
    porFranja[franja].push(slot);
  }

  // ── Armar respuesta ───────────────────────────────────────────────────────
  let response =
    `⛳ *${targetTournament.name}*\n` +
    `📅 ${d}/${m} (${targetTournament.weekDay})\n` +
    `_${availableSlots.length} lugares disponibles de ${totalSlots} horarios_\n\n`;

  for (const franja of FRANJA_ORDEN) {
    if (!porFranja[franja]) continue;
    const { emoji, label } = FRANJA_CONFIG[franja];
    const slots = porFranja[franja];

    response += `${emoji} *${label}*\n`;
    slots.forEach(s => {
      if (s.status === "libre") {
        response += `  🕐 ${s.hora} — libre\n`;
      } else {
        response += `  🕐 ${s.hora} — ${s.freePlaces} lugar${s.freePlaces > 1 ? "es" : ""}\n`;
      }
    });
    response += "\n";
  }

  response += `Para reservar contactate con la secretaría del club. 📞`;
  return response;
}
