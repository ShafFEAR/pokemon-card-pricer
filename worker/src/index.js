/**
 * Pokemon Card Pricer - Cloudflare Worker backend.
 *
 * Routes:
 *   POST /api/identify   { image: base64 (no data: prefix), mediaType: "image/png" }
 *                         -> asks Claude vision to read the card, then matches it
 *                         against the Pokemon TCG database. Returns candidates for
 *                         the user to confirm.
 *
 *   GET  /api/search?q=&number=&set=
 *                         -> manual fallback search against the Pokemon TCG database.
 *
 *   GET  /api/price?cardId=xxx
 *                         -> loose/ungraded price (Pokemon TCG API / TCGplayer + Cardmarket)
 *                         and graded price estimates (PokemonPriceTracker.com, free tier).
 *
 * Required secrets (see README for how to set these with `wrangler secret put`):
 *   ANTHROPIC_API_KEY           - console.anthropic.com
 *   POKEMONPRICETRACKER_API_KEY - pokemonpricetracker.com/api (free tier)
 *
 * No key is required for the Pokemon TCG API (api.pokemontcg.io) at the traffic
 * levels a personal tool like this generates (1000 req/day unauthenticated).
 */

const POKEMONTCG_BASE = "https://api.pokemontcg.io/v2";
const PRICETRACKER_BASE = "https://www.pokemonpricetracker.com/api/v2";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      let response;
      if (url.pathname === "/api/identify" && request.method === "POST") {
        response = await handleIdentify(request, env);
      } else if (url.pathname === "/api/search" && request.method === "GET") {
        response = await handleSearch(url, env);
      } else if (url.pathname === "/api/price" && request.method === "GET") {
        response = await handlePrice(url, env);
      } else if (url.pathname === "/" || url.pathname === "/api") {
        response = jsonResponse({
          ok: true,
          message: "Pokemon Card Pricer API is running.",
          routes: ["POST /api/identify", "GET /api/search", "GET /api/price"],
        });
      } else {
        response = jsonResponse({ error: "Not found" }, 404);
      }
      return withCors(response, cors);
    } catch (err) {
      console.error(err);
      return withCors(
        jsonResponse({ error: "Server error", detail: String(err && err.message || err) }, 500),
        cors
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleIdentify(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse(
      { error: "Server is missing ANTHROPIC_API_KEY. Run: wrangler secret put ANTHROPIC_API_KEY" },
      500
    );
  }

  const body = await safeJson(request);
  const { image, mediaType } = body || {};
  if (!image || !mediaType) {
    return jsonResponse({ error: "Expected JSON body { image: base64String, mediaType: 'image/png' }" }, 400);
  }

  const aiResult = await identifyWithClaude(image, mediaType, env);
  if (aiResult.error) {
    return jsonResponse({ error: aiResult.error }, 502);
  }

  const guesses = Array.isArray(aiResult.cards) ? aiResult.cards.slice(0, 3) : [];
  if (guesses.length === 0) {
    return jsonResponse({
      aiNotes: aiResult.notes || "Could not make out a card in this image.",
      guesses: [],
      candidates: [],
    });
  }

  // For each AI guess, look up real card records so the user picks from actual
  // cards (with images and exact pricing IDs) rather than trusting free-text OCR.
  const candidateLists = await Promise.all(
    guesses.map((g) => searchPokemonTcg({ name: g.name, number: g.number }, env))
  );

  const seen = new Set();
  const candidates = [];
  for (const list of candidateLists) {
    for (const c of list) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        candidates.push(c);
      }
    }
  }

  return jsonResponse({
    aiNotes: aiResult.notes || null,
    guesses,
    candidates: candidates.slice(0, 12),
  });
}

async function handleSearch(url, env) {
  const q = url.searchParams.get("q") || "";
  const number = url.searchParams.get("number") || "";
  const set = url.searchParams.get("set") || "";
  if (!q.trim()) {
    return jsonResponse({ error: "Query param 'q' (card name) is required" }, 400);
  }
  const candidates = await searchPokemonTcg({ name: q, number, setName: set }, env);
  return jsonResponse({ candidates });
}

async function handlePrice(url, env) {
  const cardId = url.searchParams.get("cardId");
  if (!cardId) {
    return jsonResponse({ error: "Query param 'cardId' is required (Pokemon TCG API card id)" }, 400);
  }

  const card = await getPokemonTcgCard(cardId, env);
  if (!card) {
    return jsonResponse({ error: `No card found for id ${cardId}` }, 404);
  }

  const loose = extractLoosePrices(card);

  let graded = { available: false, prices: {}, source: "pokemonpricetracker.com" };
  if (env.POKEMONPRICETRACKER_API_KEY) {
    try {
      graded = await fetchGradedPrices(card, env);
    } catch (err) {
      console.error("Graded price lookup failed:", err);
      graded = {
        available: false,
        prices: {},
        source: "pokemonpricetracker.com",
        error: "Lookup failed: " + String(err && err.message || err),
      };
    }
  } else {
    graded.error = "Server is missing POKEMONPRICETRACKER_API_KEY. Run: wrangler secret put POKEMONPRICETRACKER_API_KEY";
  }

  return jsonResponse({
    card: {
      id: card.id,
      name: card.name,
      number: card.number,
      set: card.set ? { id: card.set.id, name: card.set.name, series: card.set.series } : null,
      rarity: card.rarity || null,
      images: card.images || null,
    },
    loose,
    graded,
  });
}

// ---------------------------------------------------------------------------
// Claude vision identification
// ---------------------------------------------------------------------------

async function identifyWithClaude(imageBase64, mediaType, env) {
  const prompt = `You are looking at a photo or screenshot of one or more Pokemon Trading Card Game cards.
Identify each card as precisely as you can. Respond with ONLY a single JSON object, no markdown fences,
no commentary, matching exactly this shape:

{
  "cards": [
    {
      "name": "exact card name as printed, e.g. 'Charizard' or 'Pikachu VMAX'",
      "set_name": "the set/expansion name if visible or inferable, else null",
      "number": "the card's collector number as printed, e.g. '4' or '025/198', else null",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "notes": "one short sentence about anything uncertain (glare, cropped card, back of card instead of front, etc), or null"
}

If you cannot identify any Pokemon card in the image, return {"cards": [], "notes": "<why not>"}.`;

  const res = await fetch(ANTHROPIC_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: `Anthropic API error ${res.status}: ${text.slice(0, 300)}` };
  }

  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("\n").trim();
  const parsed = extractJson(text);
  if (!parsed) {
    return { error: "Could not parse a JSON response from Claude", raw: text.slice(0, 500) };
  }
  return parsed;
}

/** Pull the first {...} JSON object out of a string, tolerating stray text/markdown fences. */
function extractJson(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pokemon TCG API (card identity + ungraded/market prices)
// ---------------------------------------------------------------------------

async function searchPokemonTcg({ name, number, setName }, env) {
  if (!name) return [];
  const clauses = [`name:"${escapeLucene(name)}"`];
  if (number) clauses.push(`number:${escapeLucene(String(number).split("/")[0])}`);
  if (setName) clauses.push(`set.name:"${escapeLucene(setName)}"`);

  const params = new URLSearchParams({
    q: clauses.join(" "),
    pageSize: "10",
    orderBy: "-set.releaseDate",
  });

  const headers = {};
  if (env.POKEMONTCG_API_KEY) headers["X-Api-Key"] = env.POKEMONTCG_API_KEY;

  let res = await fetch(`${POKEMONTCG_BASE}/cards?${params.toString()}`, { headers });
  if (!res.ok && number) {
    // Retry without the number filter -- OCR/vision often gets the number wrong or
    // reads "4/102" as "4102", so falling back to a name-only search is safer than
    // returning nothing.
    const looseParams = new URLSearchParams({ q: `name:"${escapeLucene(name)}"`, pageSize: "10" });
    res = await fetch(`${POKEMONTCG_BASE}/cards?${looseParams.toString()}`, { headers });
  }
  if (!res.ok) return [];

  const data = await res.json();
  return (data.data || []).map(toCandidate);
}

async function getPokemonTcgCard(cardId, env) {
  const headers = {};
  if (env.POKEMONTCG_API_KEY) headers["X-Api-Key"] = env.POKEMONTCG_API_KEY;
  const res = await fetch(`${POKEMONTCG_BASE}/cards/${encodeURIComponent(cardId)}`, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  return data.data || null;
}

function toCandidate(card) {
  return {
    id: card.id,
    name: card.name,
    number: card.number,
    set: card.set ? { id: card.set.id, name: card.set.name, series: card.set.series } : null,
    rarity: card.rarity || null,
    images: card.images || null,
  };
}

/** Ungraded / loose market price, pulled from whatever pricing data the card has. */
function extractLoosePrices(card) {
  const result = { currency: "USD", variants: {}, cardmarketEUR: null, source: [] };

  if (card.tcgplayer && card.tcgplayer.prices) {
    result.source.push("tcgplayer");
    for (const [variant, p] of Object.entries(card.tcgplayer.prices)) {
      result.variants[variant] = {
        low: numOrNull(p.low),
        mid: numOrNull(p.mid),
        high: numOrNull(p.high),
        market: numOrNull(p.market),
      };
    }
    result.tcgplayerUrl = card.tcgplayer.url || null;
  }

  if (card.cardmarket && card.cardmarket.prices) {
    result.source.push("cardmarket");
    result.cardmarketEUR = {
      averageSellPrice: numOrNull(card.cardmarket.prices.averageSellPrice),
      trendPrice: numOrNull(card.cardmarket.prices.trendPrice),
      lowPrice: numOrNull(card.cardmarket.prices.lowPrice),
    };
    result.cardmarketUrl = card.cardmarket.url || null;
  }

  // Convenience "best guess average" = the market price of whichever variant looks
  // most likely to be the "plain" printing, falling back to the first variant found.
  const variantOrder = ["normal", "holofoil", "reverseHolofoil", "1stEditionHolofoil", "unlimitedHolofoil"];
  let bestMarket = null;
  for (const v of variantOrder) {
    if (result.variants[v] && result.variants[v].market != null) {
      bestMarket = result.variants[v].market;
      break;
    }
  }
  if (bestMarket == null) {
    const first = Object.values(result.variants)[0];
    bestMarket = first ? first.market : null;
  }
  result.averageMarketUSD = bestMarket;

  return result;
}

// ---------------------------------------------------------------------------
// PokemonPriceTracker.com (graded PSA prices, free tier)
// ---------------------------------------------------------------------------

async function fetchGradedPrices(card, env) {
  const params = new URLSearchParams({ search: card.name });
  if (card.set && card.set.name) params.set("setName", card.set.name);

  const res = await fetch(`${PRICETRACKER_BASE}/cards?${params.toString()}`, {
    headers: { Authorization: `Bearer ${env.POKEMONPRICETRACKER_API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      available: false,
      prices: {},
      source: "pokemonpricetracker.com",
      error: `API error ${res.status}: ${text.slice(0, 300)}`,
    };
  }

  const data = await res.json();
  const list = Array.isArray(data) ? data : data.data || data.cards || [];
  if (!list.length) {
    return { available: false, prices: {}, source: "pokemonpricetracker.com", error: "No matching card found" };
  }

  const match = pickBestMatch(list, card);
  const prices = extractGradedPricesFromRecord(match);

  return {
    available: Object.values(prices).some((v) => v != null),
    prices,
    matchedName: match.name || null,
    matchedSet: match.setName || match.set || null,
    source: "pokemonpricetracker.com",
    // NOTE: PokemonPriceTracker's exact response shape can change / vary by plan.
    // If `prices` comes back empty but you know the card has graded sales data,
    // log `rawSample` (see below) and adjust extractGradedPricesFromRecord().
  };
}

function pickBestMatch(list, card) {
  const wantNumber = card.number ? String(card.number).split("/")[0] : null;
  if (wantNumber) {
    const exact = list.find((r) => {
      const n = r.cardNumber || r.number;
      return n != null && String(n).split("/")[0] === wantNumber;
    });
    if (exact) return exact;
  }
  return list[0];
}

/**
 * PokemonPriceTracker returns graded prices under varying key names depending on
 * endpoint/plan. This scans the record defensively for anything that looks like a
 * PSA/BGS/CGC grade price so the app still works even if the exact schema shifts.
 */
function extractGradedPricesFromRecord(record) {
  const out = { psa8: null, psa9: null, psa10: null };

  const directPaths = [
    ["psa8"], ["psa9"], ["psa10"],
    ["prices", "psa8"], ["prices", "psa9"], ["prices", "psa10"],
    ["gradedPrices", "psa8"], ["gradedPrices", "psa9"], ["gradedPrices", "psa10"],
    ["grades", "psa8", "market"], ["grades", "psa9", "market"], ["grades", "psa10", "market"],
  ];
  for (const path of directPaths) {
    const key = path[path.length - 1] === "market" ? path[path.length - 2] : path[path.length - 1];
    const grade = key.replace("psa", "");
    const slot = `psa${grade}`;
    if (out[slot] != null) continue;
    const val = getPath(record, path);
    const num = numOrNull(typeof val === "object" && val ? val.market ?? val.value ?? val.price : val);
    if (num != null) out[slot] = num;
  }

  // Fallback: recursively scan for any key matching psa8/psa9/psa10 (case-insensitive)
  // in case the API nests them somewhere we didn't anticipate.
  if (out.psa8 == null || out.psa9 == null || out.psa10 == null) {
    scanForGradeKeys(record, out);
  }

  return out;
}

function scanForGradeKeys(obj, out, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return;
  for (const [key, value] of Object.entries(obj)) {
    const m = /^psa[\s_-]?(\d{1,2})$/i.exec(key.trim());
    if (m) {
      const slot = `psa${m[1]}`;
      if (slot in out && out[slot] == null) {
        const num = numOrNull(typeof value === "object" && value ? value.market ?? value.value ?? value.price : value);
        if (num != null) out[slot] = num;
      }
    }
    if (value && typeof value === "object") scanForGradeKeys(value, out, depth + 1);
  }
}

function getPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeLucene(str) {
  return String(str).replace(/["\\]/g, "");
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": (env && env.ALLOWED_ORIGIN) || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function withCors(response, cors) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

// Exported only so the pure parsing/matching helpers can be unit-tested without
// spinning up a real Worker runtime. Doesn't affect the `export default` that
// Wrangler deploys.
export {
  extractLoosePrices,
  extractGradedPricesFromRecord,
  extractJson,
  toCandidate,
  pickBestMatch,
};
