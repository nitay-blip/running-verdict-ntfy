// Vercel serverless function (Node 18+).
// Sends a friendly morning running verdict to your ntfy topic at 06:10 local (via Vercel cron set in vercel.json).

// Netiv HaLamed-Heh
const LAT = 31.68778;
const LON = 34.98361;
const TZ  = "Asia/Jerusalem";

// ---------- Helpers ----------
function verdictForAsthma({ tempC, rh, windKmh, aqi }) {
  // Safety-first for asthma & 30-min morning run
  if (Number.isFinite(aqi) && aqi >= 101) return { icon: "🔴", text: "Indoor only" };
  if (Number.isFinite(aqi) && aqi >= 51) {
    if (Number.isFinite(tempC) && tempC >= 32) return { icon: "🔴", text: "Indoor only" };
    return { icon: "🟡", text: "Caution" };
  }
  if (Number.isFinite(tempC) && tempC >= 32) return { icon: "🔴", text: "Indoor only" };
  if ((Number.isFinite(tempC) && tempC >= 28) || (Number.isFinite(rh) && rh >= 75)) return { icon: "🟡", text: "Caution" };
  return { icon: "🟢", text: "Safe to run" };
}

function fmt(n, d = 0) { return Number.isFinite(n) ? n.toFixed(d) : "NA"; }

function aqiCategoryFromNumber(aqiVal) {
  if (!Number.isFinite(aqiVal)) return "Unknown";
  if (aqiVal <= 50)  return "Good";
  if (aqiVal <= 100) return "Moderate";
  if (aqiVal <= 150) return "Unhealthy for Sensitive Groups";
  if (aqiVal <= 200) return "Unhealthy";
  if (aqiVal <= 300) return "Very Unhealthy";
  return "Hazardous";
}

function findNearestAqi(aqJson, targetISO) {
  const times = aqJson?.hourly?.time   || [];
  const aqiArr = aqJson?.hourly?.us_aqi || [];

  const exactIdx = times.findIndex(t => t.startsWith(targetISO));
  const hasVal = i => i >= 0 && i < aqiArr.length && Number.isFinite(aqiArr[i]);

  if (hasVal(exactIdx)) return { aqi: aqiArr[exactIdx], category: aqiCategoryFromNumber(aqiArr[exactIdx]) };
  for (let i = exactIdx - 1; i >= 0; i--) if (hasVal(i)) return { aqi: aqiArr[i], category: aqiCategoryFromNumber(aqiArr[i]) };
  for (let i = Math.max(exactIdx + 1, 0); i < times.length; i++) if (hasVal(i)) return { aqi: aqiArr[i], category: aqiCategoryFromNumber(aqiArr[i]) };
  return { aqi: null, category: "Unknown" };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    const topic = process.env.NTFY_TOPIC;
    if (!topic) throw new Error("Missing NTFY_TOPIC env var");

    // Build target date (today) at 06:00 local time (closest hourly slot to 06:10)
    const now = new Date();
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const [y, m, d] = ymd.split("-");
    const targetHour = "06:00";
    const targetISO  = `${y}-${m}-${d}T${targetHour}`;

    // Fetch weather + AQI (only stable fields)
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=${encodeURIComponent(TZ)}`;
    const aqUrl      = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}&hourly=us_aqi,pm2_5,pm10&timezone=${encodeURIComponent(TZ)}`;

    const [wRes, aqRes] = await Promise.all([fetch(weatherUrl), fetch(aqUrl)]);
    if (!wRes.ok) throw new Error(`weather fetch failed: ${wRes.status}`);
    if (!aqRes.ok) throw new Error(`aq fetch failed: ${aqRes.status}`);

    const [wJson, aqJson] = await Promise.all([wRes.json(), aqRes.json()]);

    const times = wJson?.hourly?.time || [];
    const i = times.findIndex(t => t.startsWith(targetISO));

    const tempC  = i >= 0 ? wJson.hourly.temperature_2m[i]       : null;
    const rh     = i >= 0 ? wJson.hourly.relative_humidity_2m[i] : null;
    const windMs = i >= 0 ? wJson.hourly.wind_speed_10m[i]       : null;
    const windKmh = Number.isFinite(windMs) ? windMs * 3.6 : null;

    const { aqi, category: aqiCat } = findNearestAqi(aqJson, targetISO);
    const verdict = verdictForAsthma({ tempC, rh, windKmh, aqi });

    // Friendly, personal, emoji-rich one-liner
    const aqiText = Number.isFinite(aqi) ? `${fmt(aqi,0)} (${aqiCat})` : "NA";
    const line = `🌅 Good morning, Nitay! 🏃‍♂️ ${verdict.icon} ${verdict.text} • 🌡️ ${fmt(tempC,0)}°C • 💧 ${fmt(rh,0)}% • 💨 ${fmt(windKmh,0)} km/h • 🌫️ AQI ${aqiText}`;

    // Push to ntfy
    const ntfyUrl = `https://ntfy.sh/${encodeURIComponent(topic)}`;
    const push = await fetch(ntfyUrl, {
      method: "POST",
      headers: {
        "Title": "Morning run",
        "Click": "https://chat.openai.com", // optional tap target
        "Priority": "5"                     // 1..5 (5 = highest)
      },
      body: line
    });
    if (!push.ok) throw new Error(`ntfy push failed: ${push.status}`);

    return res.status(200).json({ ok: true, message: line });
  } catch (e) {
    console.error("ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
