// Vercel serverless function. Node 18+.
// Sends a morning running verdict to an ntfy topic at 06:10 Israel time (03:10 UTC).

const LAT = 31.68778;
const LON = 34.98361;
const TZ = "Asia/Jerusalem";

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

    const aqTime = aqJson?.hourly?.time || [];
    const aqIdx = aqTime.findIndex(t => t.startsWith(`${y}-${m}-${d}T${targetHour}`));
    const aqi = aqIdx >= 0 ? aqJson.hourly.us_aqi[aqIdx] : null;
    const pm25 = aqIdx >= 0 ? aqJson.hourly.pm2_5[aqIdx] : null;
    const pm10 = aqIdx >= 0 ? aqJson.hourly.pm10[aqIdx] : null;

    const v = verdictForAsthma({ tempC, rh, windKmh, aqi });
    const line = `${v.icon} ${v.text} – ${fmt(tempC,0)} °C, RH ${fmt(rh,0)}%, wind ${fmt(windKmh,0)} km/h, AQI ${fmt(aqi,0)}`;

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
