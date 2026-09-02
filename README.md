# Pokémon Card Pricer

Upload a photo of a Pokémon card, confirm which card it is, and see its loose
(ungraded) market price alongside estimated graded (PSA 8/9/10) prices.

**How it works:**

1. A static frontend (plain HTML/CSS/JS) runs on GitHub Pages. You upload or
   paste a screenshot there.
2. The frontend sends the image to a small backend — a Cloudflare Worker —
   which asks Claude (vision) to read the card's name/set/number, matches
   that against the [Pokémon TCG API](https://pokemontcg.io) to find the
   exact card, and returns candidates for you to confirm.
3. Once you confirm a card, the Worker fetches its ungraded market price from
   the Pokémon TCG API (TCGplayer + Cardmarket data) and its graded PSA
   price estimates from [PokemonPriceTracker.com](https://www.pokemonpricetracker.com)
   (free tier, sourced from eBay sold listings).

The Worker exists so your API keys never end up sitting in public,
client-side JavaScript on GitHub Pages.

```
repo/
├── index.html, app.js, styles.css, config.js   ← GitHub Pages frontend
└── worker/                                      ← Cloudflare Worker backend
    ├── src/index.js
    ├── wrangler.toml
    └── package.json
```

## What you'll need

- A free [GitHub](https://github.com) account (you probably have this already)
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account (for the Worker)
- Node.js installed locally (to run `wrangler`, Cloudflare's CLI)
- An [Anthropic API key](https://console.anthropic.com/settings/keys) — this
  is pay-as-you-go, but identifying one card with the default model
  (`claude-haiku-4-5-20251001`) costs a small fraction of a cent, so casual
  use is cents per month. Anthropic gives new accounts a small free credit.
- A free [PokemonPriceTracker API key](https://www.pokemonpricetracker.com/api)
  — the free tier gives you 100 lookups/day, no credit card required.

No key is needed for the Pokémon TCG API itself — it allows 1,000
unauthenticated requests/day, which is plenty for personal use.

## 1. Deploy the backend (Cloudflare Worker)

```bash
cd worker
npm install
npx wrangler login          # opens a browser to authorize Cloudflare

# store your API keys as encrypted secrets (never committed to the repo)
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put POKEMONPRICETRACKER_API_KEY

npx wrangler deploy
```

`wrangler deploy` prints a URL that looks like:

```
https://pokemon-card-pricer-api.<your-subdomain>.workers.dev
```

Copy it — you need it in the next step.

## 2. Point the frontend at your Worker

Open `config.js` at the repo root and replace the placeholder:

```js
const WORKER_URL = "https://pokemon-card-pricer-api.<your-subdomain>.workers.dev";
```

## 3. Push this repo to GitHub

If you haven't already:

```bash
git init
git add .
git commit -m "Pokemon card pricer"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 4. Turn on GitHub Pages

In your GitHub repo: **Settings → Pages → Build and deployment → Source:
Deploy from a branch → Branch: `main`, folder: `/ (root)` → Save**.

GitHub gives you a URL like `https://<your-username>.github.io/<your-repo>/`.
Give it a minute or two after the first push, then open it.

## 5. (Recommended) Lock the Worker down to your site

By default the Worker accepts requests from any origin (`ALLOWED_ORIGIN =
"*"` in `worker/wrangler.toml`), which is fine while you're testing. Once
your GitHub Pages URL is live, tighten it so random sites can't spend your
Anthropic/PokemonPriceTracker credits through your Worker:

```toml
# worker/wrangler.toml
[vars]
ALLOWED_ORIGIN = "https://<your-username>.github.io"
```

Then redeploy: `cd worker && npx wrangler deploy`.

## Local development

Run the Worker locally:

```bash
cd worker
npx wrangler dev
```

This prints a local URL (usually `http://localhost:8787`). Temporarily point
`config.js` at that URL, then serve the frontend locally too:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Remember to switch `config.js` back to your deployed Worker URL before you
push.

## Notes and limitations

- **Identification accuracy** depends on photo quality — a clear, front-on,
  well-lit shot of the card works best. If the AI guess is wrong or nothing
  matches, use the "Search by name" fallback on the results screen.
- **Ungraded prices** come straight from the Pokémon TCG API's TCGplayer
  (USD) and Cardmarket (EUR) data, which is well-documented and reliable.
- **Graded prices** come from PokemonPriceTracker's free tier. Their exact
  JSON response shape isn't fully documented publicly, so
  `worker/src/index.js` (`extractGradedPricesFromRecord`) parses it
  defensively — it looks for PSA 8/9/10 values under several likely key
  names and falls back to scanning the response for anything that looks
  like a grade price. If graded prices come back empty for cards you know
  have PSA sales data, sign in to your PokemonPriceTracker account, check
  their [API reference](https://www.pokemonpricetracker.com/api-reference)
  for the exact field names your plan returns, and adjust that function —
  it's isolated on purpose so this is a small, contained edit.
- **Costs**: Cloudflare Workers free tier (100k requests/day), Pokémon TCG
  API free (1,000 req/day unauthenticated), PokemonPriceTracker free tier
  (100 req/day), Anthropic pay-as-you-go (~fractions of a cent per scan with
  Haiku). Nothing here requires a paid plan for personal use.
- **Rate limits**: if you hit PokemonPriceTracker's 100/day free cap,
  graded prices will just report "lookup failed" until it resets — loose
  prices are unaffected since they come from a different API.
