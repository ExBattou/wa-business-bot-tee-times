// ─────────────────────────────────────────────────────────────────────────────
// index.js — Servidor principal con agente de tee times integrado
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import config from "./config.js";
import { isTournamentQuery, getTournamentInfo } from "./teeTimeAgent.js";
import { logConversation } from "./conversationAgent.js";

dotenv.config();

const app = express();
app.use(express.json());

// ─── Cliente Groq ─────────────────────────────────────────────────────────────

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// ─── Historial de conversaciones ─────────────────────────────────────────────

const conversationHistory = new Map();

// ─── System prompt ────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `
Sos un asistente virtual de WhatsApp. Tu nombre es "${config.botName}".

CONTEXTO DEL NEGOCIO:
${config.businessContext}

INSTRUCCIONES:
${config.instructions}
`.trim();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentDateTimeContext() {
  const timeZone = config.businessHours?.timezone || "America/Argentina/Buenos_Aires";

  const dateFormatter = new Intl.DateTimeFormat("es-AR", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const timeFormatter = new Intl.DateTimeFormat("es-AR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `Fecha y hora actual del club: ${dateFormatter.format(new Date())}, ${timeFormatter.format(new Date())} hs (${timeZone}). Si el usuario dice "hoy", "mañana" o "pasado mañana", interpretalo usando esta fecha local.`;
}

function buildSystemPrompt() {
  return `${BASE_SYSTEM_PROMPT}\n\nCONTEXTO TEMPORAL:\n${getCurrentDateTimeContext()}`;
}

function isWithinBusinessHours() {
  if (!config.businessHours.enabled) return true;
  const now  = new Date(new Date().toLocaleString("en-US", { timeZone: config.businessHours.timezone }));
  const day  = now.getDay();
  const hour = now.getHours();
  return config.businessHours.days.includes(day) && hour >= config.businessHours.openHour && hour < config.businessHours.closeHour;
}

function shouldEscalate(text) {
  return config.escalationKeywords.some((kw) => text.toLowerCase().includes(kw));
}

// ─── Respuesta de Groq ────────────────────────────────────────────────────────

async function getAIResponse(userPhone, userMessage) {
  if (!conversationHistory.has(userPhone)) conversationHistory.set(userPhone, []);
  const history = conversationHistory.get(userPhone);
  history.push({ role: "user", content: userMessage });
  if (history.length > config.ai.maxHistoryMessages) history.splice(0, 2);

  try {
    const response = await groq.chat.completions.create({
      model:       config.ai.model,
      max_tokens:  config.ai.maxTokens,
      temperature: config.ai.temperature,
      messages:    [{ role: "system", content: buildSystemPrompt() }, ...history],
    });
    const reply = response.choices[0].message.content.trim();
    history.push({ role: "assistant", content: reply });
    console.log(`  📊 Tokens: ${response.usage?.total_tokens ?? "?"}`);
    return reply;
  } catch (error) {
    console.error("❌ Error Groq:", error.message);
    return "En este momento no puedo procesar tu consulta. Por favor intentá más tarde.";
  }
}

// ─── Enviar mensaje WhatsApp ──────────────────────────────────────────────────

async function sendWhatsAppMessage(to, text) {
  // Normalizar número argentino
  to = to.replace(/^549/, "54");

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) console.error("❌ Error WA:", JSON.stringify(data.error));
  return data;
}

// ─── Notificar al encargado ───────────────────────────────────────────────────

async function notifyManager(clientPhone, clientMessage) {
  if (!config.managerPhone) return;
  await sendWhatsAppMessage(
    config.managerPhone,
    `⚠️ *Escalada requerida*\nCliente: +${clientPhone}\nMensaje: "${clientMessage}"\nContactalo a la brevedad.`
  );
}

// ─── GET /webhook — verificación Meta ────────────────────────────────────────

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    console.warn("⚠️  Verificación fallida");
    res.sendStatus(403);
  }
});

// ─── POST /webhook — mensajes entrantes ──────────────────────────────────────

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (
    body.object !== "whatsapp_business_account" ||
    !body.entry?.[0]?.changes?.[0]?.value?.messages
  ) return;

  const messages = body.entry[0].changes[0].value.messages;

  for (const msg of messages) {
    const userPhone = msg.from;

    // Mensaje sin texto
    if (msg.type !== "text") {
      const botReply = "Recibí tu mensaje 👋 Por ahora solo proceso texto. ¿En qué te puedo ayudar?";
      await sendWhatsAppMessage(userPhone, botReply);
      logConversation({
        userPhone,
        receivedMessage: `[${msg.type}]`,
        botResponse: botReply,
      });
      continue;
    }

    const userMessage = msg.text.body.trim();
    console.log(`\n📩 [${userPhone}] "${userMessage}"`);

    // Fuera de horario
    if (!isWithinBusinessHours()) {
      await sendWhatsAppMessage(userPhone, config.offHoursMessage);
      logConversation({
        userPhone,
        receivedMessage: userMessage,
        botResponse: config.offHoursMessage,
      });
      console.log(`  🕐 Fuera de horario`);
      continue;
    }

    // Escalada a humano
    if (shouldEscalate(userMessage)) {
      const botReply = "Entendido, un asesor se va a comunicar con vos a la brevedad. 🙏";
      await sendWhatsAppMessage(userPhone, botReply);
      logConversation({
        userPhone,
        receivedMessage: userMessage,
        botResponse: botReply,
      });
      await notifyManager(userPhone, userMessage);
      console.log(`  🚨 Escalada`);
      continue;
    }

    // ── Agente de torneos/tee times ───────────────────────────────────────
    if (isTournamentQuery(userMessage)) {
      console.log(`  ⛳ Derivando al agente de tee times...`);
      const teeReply = await getTournamentInfo(userMessage);
      await sendWhatsAppMessage(userPhone, teeReply);
      logConversation({
        userPhone,
        receivedMessage: userMessage,
        botResponse: teeReply,
      });
      console.log(`  🤖 Respuesta tee time enviada`);
      continue;
    }

    // ── Respuesta general con Groq ────────────────────────────────────────
    const aiReply = await getAIResponse(userPhone, userMessage);
    await sendWhatsAppMessage(userPhone, aiReply);
    logConversation({
      userPhone,
      receivedMessage: userMessage,
      botResponse: aiReply,
    });
    console.log(`  🤖 "${aiReply.substring(0, 80)}${aiReply.length > 80 ? "..." : ""}"`);
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "ok", bot: config.botName, model: config.ai.model, uptime: `${Math.floor(process.uptime())}s` });
});

// ─── Inicio ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  🚀 Puerto ${PORT}`);
  console.log(`  🤖 Bot: ${config.botName}`);
  console.log(`  🧠 Modelo: ${config.ai.model} (Groq)`);
  console.log(`  ⛳ Agente tee times: activo`);
  console.log(`  📡 Webhook: http://localhost:${PORT}/webhook`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("\n💡 Tip: corré 'node scraper.js' para cargar los torneos del mes\n");
});
