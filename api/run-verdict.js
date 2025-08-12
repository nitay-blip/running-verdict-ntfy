// Vercel serverless function. Node 18+.
// Sends a morning running verdict to an ntfy topic at 06:10 Israel time (03:10 UTC).

const LAT = 31.68778;
const LON = 34.98361;
const TZ = "Asia/Jerusalem";

// Map EPA category text, or derive from numeric AQI if text is missing
function aqiCategory(catStr, aqiVal) {
  if (catStr) return catStr; // e.g., "Moderate", "Unhealthy"
  if (aqiVal == null || !Number.isFinite(aqiVal)) return "Unknown";
  if (aqiVal <= 50) return "Good";
  if (aqiVal <= 100) return "Moderate";
  if (aqiVal <= 150) return "Unhealthy for Sensitive Groups";
  if (aqiVal <= 200) return "Unhealthy";
  if (aqiVal <= 300) return "Very Unhealthy";
  return "Hazardous";
}

// Find the nearest hour with a valid AQI if the target hour is missing
function findNearestAqi(aqJson, targetISO) {
  const times = aqJson?.hourly?.time || [];
  const aqiArr = aqJson?.hourly?.us_aqi || [];
  const catArr = aqJson?.hourly?.epa_health_concern || [];

  const exactIdx = times.findIndex(t => t.startsWith(targetISO));
  const hasVal = i => i >= 0 && i < aqiArr.length && aqiArr[i] != null;

  // 1) Try exact 06:00
  if (hasVal(exactIdx)) {
    return { aqi: aqiArr[exactIdx], category: aqiCategory(catArr?.[exactIdx], aqiArr[exactIdx]), time: times[exactIdx] };
  }

  // 2) Walk backward from 06:00 (05:00, 04:00, …)
  for (let i = exactIdx - 1; i >= 0; i--) {
    if (hasVal(i)) {
      return { aqi: aqiArr[i], category: aqiCategory(catArr?.[i], aqiArr[i]), time: times[i] };
    }
  }

  // 3) Walk forward (07:00, 08:00, …)
  for (let i = Math.max(exactIdx + 1, 0); i < times.length; i++) {
    if (hasVal(i)) {
      return { aqi: aqiArr[i], category: aqiCategory(catArr?.[i], aqiArr[i]), time: times[i] };
    }
  }

  // 4) Nothing found
  return { aqi: null, category: "Unknown", time: null };
}
/

// Build a verdict tuned for asthma and a 30-minute outdoor run
function verdictForAsthma({ tempC, rh, windKmh, aqi }) {
  if (aqi >= 101) return { icon: "🔴", text: "Indoor only" };
  if (aqi >= 51) {
    if (tempC >= 32) return { icon: "🔴", text: "Indoor only" };
    return { icon: "🟡", text: "Caution" };
  }
  if (tempC >= 32) return { icon: "🔴", text: "Indoor only" };
  if (tempC >= 28 || rh >= 75) return { icon: "🟡", text: "Caution" };
  return { icon: "🟢", text: "Safe to run" };
}

function fmt(n, d = 0) { return Number.isFinite(n) ? n.toFixed(d) : "NA"; }

export default async function handler(req, res) {
  try {
    const now = new Date();

    // YYYY-MM-DD in Israel time
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(now);
    const [y, m, d] = ymd.split("-");
    const targetHour = "06:00"; // Open-Meteo hourly slot closest to 06:10

    const weatherUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
      `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=${encodeURIComponent(TZ)}`;

    const aqUrl =
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}` +
      `&hourly=pm2_5,pm10,us_aqi,epa_health_concern&timezone=${encodeURIComponent(TZ)}`;

    const [wRes, aqRes] = await Promise.all([fetch(weatherUrl), fetch(aqUrl)]);
    const [wJson, aqJson] = await Promise.all([wRes.json(), aqRes.json()]);

    const wTime = wJson?.hourly?.time || [];
    const idx = wTime.findIndex(t => t.startsWith(`${y}-${m}-${d}T${targetHour}`));

    const tempC = idx >= 0 ? wJson.hourly.temperature_2m[idx] : null;
    const rh = idx >= 0 ? wJson.hourly.relative_humidity_2m[idx] : null;
    const windMs = idx >= 0 ? wJson.hourly.wind_speed_10m[idx] : null;
    const windKmh = windMs != null ? windMs * 3.6 : null;

    const targetISO = `${y}-${m}-${d}T${targetHour}`;
const aqiInfo = findNearestAqi(aqJson, targetISO);
const aqi = aqiInfo.aqi;
const aqiCat = aqiInfo.category;
const pm25 = null; // keep for future if you want to show these
const pm10 = null;


    const v = verdictForAsthma({ tempC, rh, windKmh, aqi });
    const line = `🌅 Good morning! Here’s your run check: ${v.icon} ${v.text}  
🌡️ Temp: ${fmt(tempC,0)}°C | 💧 Humidity: ${fmt(rh,0)}% | 💨 Wind: ${fmt(windKmh,0)} km/h | 🌫️ AQI: ${fmt(aqi,0)}`;


    // Send to ntfy
    const topic = process.env.NTFY_TOPIC; // your exact topic string from the app
    if (!topic) throw new Error("Missing NTFY_TOPIC env var");

    const ntfyUrl = `https://ntfy.sh/${encodeURIComponent(topic)}`;
    const resp = await fetch(ntfyUrl, {
      method: "POST",
      headers: {
        "Title": "Running verdict",
        "Click": "chat.openai.com", // optional, any URL to open on tap
        "Priority": "5" // 5 = max, adjust in the app if you want
      },
      body: line
    });

    if (!resp.ok) throw new Error(`ntfy push failed: ${resp.status}`);

    return res.status(200).json({
      ok: true,
      message: line,
      sentTo: topic,
      details: { tempC, humidity: rh, windKmh, aqi, pm25, pm10, time: `${y}-${m}-${d} ${targetHour} ${TZ}` }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}


