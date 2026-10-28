const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const MAX_MESSAGE_CHARS = 1200;
const MAX_BODY_BYTES = 12000;
const MAX_HISTORY = 8;
const SYSTEM_PROMPT = `Сен — HAN ATLAS жобасының тарихи зерттеу тәлімгері. Қазақ тілінде жауап бер. Тақырып: Кенесары Қасымұлы бастаған 1837–1847 жылдардағы қозғалыс. Мақсат — оқушыға деректі түсінуге, сұрақ қоюға, салыстыруға және өз қорытындысын жасауға көмектесу.

Тексерілген бағыттар: қозғалыстың себептері бірнешеу (хандық биліктің жойылуы, бекініс пен жер мәселесі, отарлық басқару, алым-салық, саяси дербестік); 1841 жылы Кенесары хан сайланды; 1845 жылы оңтүстік бекіністерге қатысты деректер бар; Ақмола шайқасының күні және 1847 жылғы соңғы шайқастың нақты орны жөнінде дереккөздерде айырмалар кездеседі.

Ережелер: тарихи дата, дәйексөз, сан, координата ойдан шығарма; дерек пен түсіндіруді ажырат; белгісіз не даулы болса ашық айт; оқушы жауабын талдағанда күшті тұсын, дәлелсіз тұсын және нақты жақсарту жолын көрсет; қажет болса жауапты құрылымда: қысқаша жауап, дәлел, тексеру сұрағы. Маңызды тұжырымдарды [E1]–[E4] белгілерімен дәйекте. Жеке дерек сұрама. Жауаптарды түсінікті, жылы және мазмұнды бер.

Дереккөздер: [E1] https://e-history.kz/kz/history-of-kazakhstan/show/8726 ; [E2] https://e-history.kz/media/scorm/243/192/text/text.htm ; [E3] https://iie.kz/?p=25136 ; [E4] https://doi.org/10.1080/00905990500354137`;

function response(data, status, origin) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "vary": "Origin" };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "POST, OPTIONS";
    headers["access-control-allow-headers"] = "Content-Type, X-Session-Id";
    headers["access-control-max-age"] = "86400";
  }
  return new Response(JSON.stringify(data), { status, headers });
}
function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  return (env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).includes(origin) ? origin : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/chat") return response({ error: "Бағыт табылмады." }, 404);
    const origin = allowedOrigin(request, env);
    if (!origin) return response({ error: "Бұл сайтқа рұқсат берілмеген." }, 403);
    if (request.method === "OPTIONS") return response({}, 204, origin);
    if (request.method !== "POST") return response({ error: "POST сұрауын қолданыңыз." }, 405, origin);
    if (!env.AI || typeof env.AI.run !== "function") return response({ error: "AI binding бапталмаған." }, 503, origin);

    const session = request.headers.get("X-Session-Id") || "";
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(session)) return response({ error: "Сессия белгісі жарамсыз." }, 400, origin);
    // Per-isolate abuse guard. This is best-effort; Cloudflare account limits remain authoritative.
    const now = Date.now();
    globalThis.__hanAtlasRate ||= new Map();
    const previous = globalThis.__hanAtlasRate.get(session) || [];
    const recent = previous.filter(t => now - t < 60_000);
    if (recent.length >= 8) return response({ error: "Сұрау жиілігі шектелді. Бір минуттан кейін қайталап көр." }, 429, origin);
    recent.push(now); globalThis.__hanAtlasRate.set(session, recent);

    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return response({ error: "Сұрау тым үлкен." }, 413, origin);
      body = JSON.parse(raw);
    } catch { return response({ error: "Сұрау пішімін оқи алмадым." }, 400, origin); }
    if (!Array.isArray(body.messages)) return response({ error: "Хабарламалар тізімі қажет." }, 400, origin);
    const messages = body.messages.slice(-MAX_HISTORY).map(m => {
      if (!m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string") return null;
      const content = m.content.trim().slice(0, MAX_MESSAGE_CHARS);
      return content ? { role: m.role, content } : null;
    }).filter(Boolean);
    if (!messages.length || messages.at(-1).role !== "user") return response({ error: "Соңғы хабарлама сұрақ болуы керек." }, 400, origin);

    try {
      const result = await env.AI.run(MODEL, { messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages], max_tokens: 700, temperature: 0.25 });
      const reply = typeof result?.response === "string" ? result.response.trim() : "";
      if (!reply) throw new Error("Empty model response");
      return response({ reply, model: MODEL }, 200, origin);
    } catch (error) {
      const message = String(error?.message || "");
      if (/daily free allocation|neurons/i.test(message)) return response({ error: "Cloudflare AI-дың бүгінгі тегін лимиті таусылды. Кейінірек қайталап көр." }, 429, origin);
      return response({ error: "AI уақытша жауап бере алмады. Қайта көр." }, 502, origin);
    }
  }
};
