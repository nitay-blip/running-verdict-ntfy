// Vercel serverless function (Node 18+).
// Friendly morning running verdict, pushed to ntfy at 06:10 local (cron in vercel.json).
// Location: Netiv HaLamed-Heh, Israel

const LAT = 31.68778;
const LON = 34.98361;
const TZ  = "Asia/Jerusalem";

// ---------- Helpers ----------
function fmt(n, d = 0) { return Number.isFinite(n) ? n.toFixed(d) : "NA"; }

// US AQI calculator for PM2.5 and PM10 (EPA breakpoints)
function usAqiFromConcentration(conc, pollutant) {
  if (!Number.isFinite(conc)) return null;

  // Breakpoints: [C_low, C_high, I_low, I_high]
  // PM2.5 in µg/m³, 24-hr avg (we apply to the hourly model value as an approximation)
  const PM25 = [
    [0.0, 12.0, 0, 50],
    [12.1, 35.4, 51, 100],
    [35.5, 55.4, 101, 150],
    [55.5, 150.4, 151, 200],
    [150.5, 250.4, 201, 300],
    [250.5, 350.4, 301, 400],
    [350.5, 500.4, 401, 500]
  ];
  // PM10 in µg/m³, 24-hr avg
  const PM10 = [
    [0, 54, 0, 50],
    [55, 154, 51, 100],
    [155, 254, 101, 150],
    [255, 354, 151, 200],
    [355, 424, 201, 300],
    [425, 504, 301, 400],
    [505, 604, 401, 500]
  ];

  const table = pollutant === "pm10" ? PM10 : PM25;
  for (const [Cl, Ch, Il, Ih] of table) {
    if (conc >= Cl && conc <= Ch) {
      // Linear interpolation: I = (Ih-Il)/(Ch-Cl)*(C-Cl) + Il
      const I = ( (Ih - Il) / (Ch - Cl) ) * (conc - Cl) + Il;
      return Math.round(I);
    }
  }
  return 500; // beyond table
}

function aqiCategoryFromNumber(aqiVal) {
  if (!Number.isFinite(aqiVal)) return "Unknown";
  if (aqiVal <= 50)  return "Good";
  if (aqiVal <= 100) return "Moderate";
  if (aqiVal <= 150) return "Unhealthy for Sensitive Groups";
  if (aqiVal <= 200) return "Unhealthy";
  if (aqiVal <= 300) return "Very Unhealthy";
  return "Hazardous";
}

// Safety-first for asthma & 30-min morning run
function verdictForAsthma({ tempC, rh, windKmh, aqi }) {
  if (Number.isFinite(aqi) && aqi >= 101) return { icon: "🔴", text: "Indoor only" };
  if (Number.isFinite(aqi) && aqi >= 51) {
    if (Number.isFinite(tempC) && tempC >= 32) return { icon: "🔴", text: "Indoor only" };
    return { icon: "🟡", text: "Caution" };
  }
  if (Number.isFinite(tempC) && tempC >= 32) return { icon: "🔴", text: "Indoor only" };
  if ((Number.isFinite(tempC) && tempC >= 28) || (Number.isFinite(rh) && rh >= 75)) return { icon: "🟡", text: "Caution" };
  return { icon: "🟢", text: "Safe to run" };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    const topic = process.env.NTFY_TOPIC;
    if (!topic) throw new Error("Missing NTFY_TOPIC env var");

    // Target date (today) at 06:00 local (closest hourly slot to 06:10)
    const now = new Date();
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const [y, m, d] = ymd.split("-");
    const targetHour = "06:00";
    const targetISO  = `${y}-${m}-${d}T${targetHour}`;

    // Weather (temp, humidity, wind)
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=${encodeURIComponent(TZ)}`;
    // Air quality: request PM only (hourly), we’ll compute US AQI ourselves
    const aqUrl      = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}&hourly=pm2_5,pm10&timezone=${encodeURIComponent(TZ)}`;

    const [wRes, aqRes] = await Promise.all([fetch(weatherUrl), fetch(aqUrl)]);
    if (!wRes.ok) throw new Error(`weather fetch failed: ${wRes.status}`);
    if (!aqRes.ok) throw new Error(`aq fetch failed: ${aqRes.status}`);

    const [wJson, aqJson] = await Promise.all([wRes.json(), aqRes.json()]);

    // Weather values at 06:00
    const times = wJson?.hourly?.time || [];
    const i = times.findIndex(t => t.startsWith(targetISO));
    const tempC  = i >= 0 ? wJson.hourly.temperature_2m[i]       : null;
    const rh     = i >= 0 ? wJson.hourly.relative_humidity_2m[i] : null;
    const windMs = i >= 0 ? wJson.hourly.wind_speed_10m[i]       : null;
    const windKmh = Number.isFinite(windMs) ? windMs * 3.6 : null;

    // Nearest PM values at/around 06:00 (prefer exact, else previous, else next)
    const aqtimes = aqJson?.hourly?.time || [];
    const jExact = aqtimes.findIndex(t => t.startsWith(targetISO));
    const pm25Arr = aqJson?.hourly?.pm2_5 || [];
    const pm10Arr = aqJson?.hourly?.pm10  || [];
    const pickNearest = (arr) => {
      const has = idx => idx >= 0 && idx < arr.length && Number.isFinite(arr[idx]);
      if (has(jExact)) return arr[jExact];
      for (let k = jExact - 1; k >= 0; k--) if (has(k)) return arr[k];
      for (let k = Math.max(jExact + 1, 0); k < arr.length; k++) if (has(k)) return arr[k];
      return null;
    };
    const pm25 = pickNearest(pm25Arr);
    const pm10 = pickNearest(pm10Arr);

    // Compute US AQI from PM2.5 (fallback to PM10)
    const aqiFromPm25 = usAqiFromConcentration(pm25, "pm25");
    const aqiFromPm10 = usAqiFromConcentration(pm10, "pm10");
    const aqi = Number.isFinite(aqiFromPm25) ? aqiFromPm25 : aqiFromPm10;
    const aqiCat = aqiCategoryFromNumber(aqi);

    // Verdict & message
    const verdict = verdictForAsthma({ tempC, rh, windKmh, aqi });
    const aqiText = Number.isFinite(aqi) ? `${fmt(aqi,0)} (${aqiCat})` : "NA";
    const line = `🌅 Good morning, Nitay! 🏃‍♂️ ${verdict.icon} ${verdict.text} • 🌡️ ${fmt(tempC,0)}°C • 💧 ${fmt(rh,0)}% • 💨 ${fmt(windKmh,0)} km/h • 🌫️ AQI ${aqiText}`;

    // Push to ntfy
    const ntfyUrl = `https://ntfy.sh/${encodeURIComponent(topic)}`;
    const push = await fetch(ntfyUrl, {
      method: "POST",
      headers: {
        "Title": "Morning run",
        "Click": "https://chat.openai.com", // optional tap target
        "Priority": "5"                     // 1..5
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
