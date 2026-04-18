/**
 * Full Mirror Reverse Proxy - manhwaindo
 * With Cloudflare Bypass (Puppeteer + Stealth)
 *
 * Strategy:
 * 1. Maintain a stealth browser instance to solve CF challenges
 * 2. Extract cf_clearance cookies from browser
 * 3. Use cookies for fast fetch() requests on subsequent calls
 * 4. If fetch gets blocked, fall back to full browser rendering
 * 5. Cache everything aggressively (LRU cache)
 *
 * SEO Fixes:
 * - Canonical URL rewriting
 * - Full URL rewriting in HTML/CSS/JS
 * - Structured data / JSON-LD / Breadcrumb fixing
 * - Redirect handling
 * - Sitemap & robots.txt rewriting
 */

const express = require("express");
const compression = require("compression");
const { load: cheerioLoad } = require("cheerio");
const { LRUCache } = require("lru-cache");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

// ============ CONFIGURATION ============
const SOURCE_HOST = process.env.SOURCE_HOST || "www.manhwaindo.my";
const SOURCE_ORIGIN = `https://${SOURCE_HOST}`;
const MIRROR_HOST = process.env.MIRROR_HOST || "";
const PORT = parseInt(process.env.PORT, 10) || 3000;
const USER_AGENT =
  process.env.CUSTOM_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Cache settings
const CACHE_HTML_TTL = 1000 * 60 * 5;        // 5 min for HTML
const CACHE_ASSET_TTL = 1000 * 60 * 60 * 24; // 24 hours for assets
const CACHE_MAX_ITEMS = 500;
const COOKIE_REFRESH_INTERVAL = 1000 * 60 * 10; // Refresh cookies every 10 min
// =======================================

const app = express();
app.use(compression());
app.set("trust proxy", true);

// ---------- CACHE ----------
const cache = new LRUCache({
  max: CACHE_MAX_ITEMS,
  ttl: CACHE_HTML_TTL,
});

// ---------- BROWSER MANAGER ----------
let browser = null;
let cfCookies = [];
let cfCookieString = "";
let lastCookieRefresh = 0;
let browserLaunching = false;

async function getBrowser() {
  if (browser && browser.connected) return browser;
  if (browserLaunching) {
    while (browserLaunching) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (browser && browser.connected) return browser;
  }

  browserLaunching = true;
  try {
    console.log("[BROWSER] Launching stealth browser...");
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--window-size=1920,1080",
        "--lang=id-ID,id,en-US,en",
      ],
      defaultViewport: { width: 1920, height: 1080 },
    });

    browser.on("disconnected", () => {
      console.log("[BROWSER] Disconnected, will relaunch on next request");
      browser = null;
    });

    console.log("[BROWSER] Stealth browser launched");
    return browser;
  } finally {
    browserLaunching = false;
  }
}

/**
 * Solve Cloudflare challenge and extract cookies
 */
async function solveCfChallenge(targetUrl) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    console.log(`[CF-SOLVE] Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Wait for CF challenge to resolve
    let retries = 0;
    const maxRetries = 30;
    while (retries < maxRetries) {
      const title = await page.title();
      const url = page.url();

      if (
        !title.includes("Just a moment") &&
        !title.includes("Checking") &&
        !title.includes("Attention Required") &&
        !title.includes("Security") &&
        !url.includes("__cf_chl")
      ) {
        console.log(`[CF-SOLVE] Challenge passed! Title: "${title}"`);
        break;
      }

      console.log(
        `[CF-SOLVE] Waiting... (${retries + 1}/${maxRetries}) Title: "${title}"`
      );
      await new Promise((r) => setTimeout(r, 2000));
      retries++;
    }

    // Extract cookies
    const cookies = await page.cookies();
    cfCookies = cookies;
    cfCookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    lastCookieRefresh = Date.now();

    console.log(
      `[CF-SOLVE] Got ${cookies.length} cookies: ${cookies.map((c) => c.name).join(", ")}`
    );

    // Don't use page.content() - it returns rendered DOM which differs from source
    // Instead, now that we have cookies, we'll fetch raw HTML separately
    return { content: null, status: 200, cookies };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fetch raw HTML source using HTTP after CF cookies are obtained.
 * This is preferred over page.content() which returns rendered DOM.
 */
async function fetchRawHtml(targetUrl) {
  try {
    const response = await fetchWithCookies(targetUrl, "GET");
    if (response.ok || (response.status >= 200 && response.status < 400)) {
      const body = await response.text();
      // Verify it's not a CF challenge
      if (!isCfChallenge(response, body)) {
        return { content: body, status: response.status };
      }
    }
  } catch (e) {
    console.log(`[FETCH-RAW] Failed: ${e.message}`);
  }
  return null;
}

/**
 * Fetch a page using full browser rendering (last resort fallback).
 * Intercepts the raw network response to get original HTML source,
 * NOT the rendered DOM from page.content() which breaks layout.
 */
async function fetchWithBrowser(targetUrl) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    if (cfCookies.length > 0) {
      await page.setCookie(...cfCookies);
    }

    // Intercept the main document response to capture raw HTML
    let rawHtml = null;
    let responseStatus = 200;

    page.on("response", async (resp) => {
      try {
        // Capture document responses for the target URL
        const reqType = resp.request().resourceType();
        if (reqType === "document") {
          console.log(`[BROWSER-INTERCEPT] Document response: ${resp.url()} (${resp.status()})`);
        }
        if (
          resp.url() === targetUrl &&
          reqType === "document" &&
          !rawHtml
        ) {
          responseStatus = resp.status();
          const ct = (resp.headers()["content-type"] || "").toLowerCase();
          if (ct.includes("text/html")) {
            rawHtml = await resp.text();
            console.log(`[BROWSER-INTERCEPT] Captured raw HTML (${rawHtml.length} bytes, status ${responseStatus})`);
          }
        }
      } catch (e) {
        console.log(`[BROWSER-INTERCEPT] Error: ${e.message}`);
      }
    });

    const response = await page.goto(targetUrl, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Wait for CF challenge if present
    let retries = 0;
    while (retries < 15) {
      const title = await page.title();
      if (
        !title.includes("Just a moment") &&
        !title.includes("Checking") &&
        !title.includes("Security")
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
      retries++;
    }

    // Refresh cookies after passing challenge
    const cookies = await page.cookies();
    cfCookies = cookies;
    cfCookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    lastCookieRefresh = Date.now();

    // If we intercepted the raw HTML, try to also fetch it cleanly with new cookies
    // (the intercepted one might be a CF challenge page)
    if (!rawHtml || rawHtml.includes("Just a moment") || rawHtml.includes("cf_chl_opt")) {
      console.log(`[BROWSER] Raw HTML ${rawHtml ? 'is CF challenge' : 'was not intercepted'}, trying fetchRawHtml...`);
      // Cookies are fresh now, try a clean fetch
      const raw = await fetchRawHtml(targetUrl);
      if (raw) {
        console.log(`[BROWSER→FETCH] Got raw HTML after cookie refresh (${raw.content.length} bytes)`);
        return { content: raw.content, status: raw.status, headers: {} };
      }
      // Absolute last resort: use rendered DOM
      console.log(`[BROWSER] Using page.content() as last resort`);
      rawHtml = await page.content();
    } else {
      console.log(`[BROWSER] Using intercepted raw HTML (${rawHtml.length} bytes)`);
    }

    const status = responseStatus || (response ? response.status() : 200);
    const headers = response ? response.headers() : {};

    return { content: rawHtml, status, headers };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fetch using regular HTTP with CF cookies (fast path)
 * Mimics a real browser request as closely as possible
 */
async function fetchWithCookies(targetUrl, method = "GET") {
  const headers = {
    Host: SOURCE_HOST,
    "User-Agent": USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-CH-UA": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    Cookie: cfCookieString,
    Referer: SOURCE_ORIGIN + "/",
  };

  return await fetch(targetUrl, {
    method,
    headers,
    redirect: "manual",
  });
}

/**
 * Check if response is a CF challenge page
 */
function isCfChallenge(response, bodyText) {
  if (response.status === 403 || response.status === 503) {
    if (bodyText) {
      return (
        bodyText.includes("Just a moment") ||
        bodyText.includes("cf-challenge") ||
        bodyText.includes("challenge-platform") ||
        bodyText.includes("cf_chl_opt") ||
        bodyText.includes("Checking your browser")
      );
    }
    return true;
  }
  return false;
}

// ---------- URL REWRITING ----------

function getMirrorOrigin(req) {
  if (MIRROR_HOST) {
    const proto = req.protocol || "https";
    return `${proto}://${MIRROR_HOST}`;
  }
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function getMirrorHost(req) {
  if (MIRROR_HOST) return MIRROR_HOST;
  return req.headers["x-forwarded-host"] || req.headers.host || "localhost";
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteUrls(text, mirrorOrigin, mirrorHost) {
  if (!text) return text;
  let result = text;

  result = result.split(`https://${SOURCE_HOST}`).join(mirrorOrigin);
  result = result.split(`http://${SOURCE_HOST}`).join(mirrorOrigin);

  const mirrorProtoRelative = mirrorOrigin.replace(/^https?:/, "");
  result = result.split(`//${SOURCE_HOST}`).join(mirrorProtoRelative);

  result = result
    .split(`https:\\/\\/${SOURCE_HOST}`)
    .join(mirrorOrigin.replace(/\//g, "\\/"));
  result = result
    .split(`http:\\/\\/${SOURCE_HOST}`)
    .join(mirrorOrigin.replace(/\//g, "\\/"));

  result = result
    .split(encodeURIComponent(`https://${SOURCE_HOST}`))
    .join(encodeURIComponent(mirrorOrigin));

  return result;
}

function rewriteHtml(html, mirrorOrigin, mirrorHost, requestPath) {
  let rewritten = rewriteUrls(html, mirrorOrigin, mirrorHost);

  // Upgrade ALL http:// URLs to https:// (fixes mixed content for external domains)
  rewritten = rewritten.replace(/http:\/\//g, 'https://');

  const $ = cheerioLoad(rewritten, { decodeEntities: false });
  const fullCanonical = `${mirrorOrigin}${requestPath}`;

  // ---- REMOVE GAMBLING / JUDI ADS ----
  // Known gambling/judi domains
  const judiDomains = [
    'gacor.zone', 'gacor.vin', 'cek.to', 'klik.zeus.fun', 'klik.top',
    'klik.gg', 'klik.best', 'dub.link', 'happylink.pro', 'joiboy.ink',
    'menujupenta.site', 'akseskaiko.cam', 'terbangrusia.site', 'kegz.site',
    'goratu.site', 'bergurukecina.fun', 'injd.site', 'goid.space',
    'orangarab.fun', 'tinyurl.com/momoplay', 'mamba.top-vip.online',
    'wongso.top-vip.online', 'kps.link-mantap.ink',
    'upload.gmbr.pro', 'kacu.gmbr.pro',
    'tapme.ink',
    'linkfast.asia',
  ];
  const judiPattern = judiDomains.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const judiRegex = new RegExp(judiPattern, 'i');

  // Remove banner ad containers
  $('div.blox.mlb.kln').remove();
  $('div.blox.mlb').remove();
  $('div.blox.kln').remove();

  // Remove sticky bottom ad banners (fixed position ad overlays)
  $('div[style*="position:fixed"][style*="bottom"]').each((_, el) => {
    const html = $(el).html() || '';
    if (html.includes('blox kln') || html.includes('btn_close.gif') || judiRegex.test(html)) {
      $(el).remove();
    }
  });
  $('div[style*="position: fixed"][style*="bottom"]').each((_, el) => {
    const html = $(el).html() || '';
    if (html.includes('blox kln') || html.includes('btn_close.gif') || judiRegex.test(html)) {
      $(el).remove();
    }
  });

  // Remove links to known gambling/judi domains
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (judiRegex.test(href)) {
      $(el).remove();
    }
  });

  // Remove ExoClick native widget ads
  $('.exo-native-widget').remove();
  $('div[data-uid]').each((_, el) => {
    const html = $(el).html() || '';
    if (html.includes('exo-native-widget') || html.includes('magsrv.com') || html.includes('z6v2p9a8.bkcdn.net')) {
      $(el).remove();
    }
  });

  // Remove ad network scripts and iframes
  $('script[src*="pubadx.one"]').remove();
  $('script[src*="onclckmn.com"]').remove();
  $('script[src*="onclicka.js"]').remove();
  $('div[id^="bg-ssp-"]').remove();
  $('iframe[src*="a-ads.com"]').remove();
  $('iframe[src*="onclckbn.net"]').remove();
  $('iframe[data-aa]').remove();
  $('[data-banner-id]').remove();

  // Remove popunder/popup ad scripts
  $('script').each((_, el) => {
    const src = $(el).attr('src') || '';
    const content = $(el).html() || '';
    if (
      src.includes('pubadx') || src.includes('onclckmn') || src.includes('onclicka') ||
      src.includes('a-ads.com') || src.includes('juicyads') || src.includes('exoclick') ||
      src.includes('magsrv.com') || src.includes('z6v2p9a8.bkcdn.net') ||
      content.includes('ads-iframe') || content.includes('disqusads') ||
      content.includes('setRealHref') || content.includes('exo-native-widget') ||
      content.includes('magsrv.com') ||
      // Popunder/click hijacker patterns
      content.includes('puShown') || content.includes('doOpen1') ||
      content.includes('initPu1') || content.includes('checkTarget') ||
      content.includes('generateURL1') || content.includes('linkfast.asia') ||
      content.includes('popundr') || content.includes('PopWidth1') ||
      content.includes('PopHeight1') || content.includes('popads')
    ) {
      $(el).remove();
    }
  });

  // Remove remaining ad iframes
  $('iframe').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (
      src.includes('a-ads.com') || src.includes('onclckbn.net') ||
      src.includes('pubadx') || src.includes('juicyads') || src.includes('exoclick')
    ) {
      $(el).remove();
    }
  });
  // ---- END AD REMOVAL ----

  // Add upgrade-insecure-requests as safety net for any remaining http links
  if (!$('meta[http-equiv="Content-Security-Policy"]').length) {
    $("head").prepend('<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">');
  }

  // Canonical
  let canonicalTag = $('link[rel="canonical"]');
  if (canonicalTag.length) {
    canonicalTag.attr("href", fullCanonical);
  } else {
    $("head").append(`<link rel="canonical" href="${fullCanonical}" />`);
  }
  const canonicals = $('link[rel="canonical"]');
  if (canonicals.length > 1) canonicals.slice(1).remove();

  // Meta tags
  $('meta[property="og:url"]').attr("content", fullCanonical);
  $('meta[name="twitter:url"]').attr("content", fullCanonical);
  $('meta[property="og:site_name"]').each((_, el) => {
    const c = $(el).attr("content") || "";
    if (c.includes(SOURCE_HOST))
      $(el).attr("content", c.replace(SOURCE_HOST, mirrorHost));
  });

  // JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      let jsonText = $(el).html();
      if (!jsonText) return;
      jsonText = rewriteUrls(jsonText, mirrorOrigin, mirrorHost);
      let jsonData = JSON.parse(jsonText);
      jsonData = fixStructuredData(jsonData, mirrorOrigin, mirrorHost);
      $(el).html(JSON.stringify(jsonData, null, 0));
    } catch (e) {
      let jsonText = $(el).html() || "";
      jsonText = rewriteUrls(jsonText, mirrorOrigin, mirrorHost);
      try {
        jsonText = jsonText.replace(/,\s*([\]}])/g, "$1");
        const jsonData = JSON.parse(jsonText);
        $(el).html(JSON.stringify(jsonData, null, 0));
      } catch (e2) {
        $(el).remove();
      }
    }
  });

  // Alternate/hreflang
  $('link[rel="alternate"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.includes(SOURCE_HOST)) {
      $(el).attr(
        "href",
        href.replace(new RegExp(`https?://${escapeRegex(SOURCE_HOST)}`, "g"), mirrorOrigin)
      );
    }
  });

  // Base tag
  $("base").each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.includes(SOURCE_HOST)) {
      $(el).attr(
        "href",
        href.replace(new RegExp(`https?://${escapeRegex(SOURCE_HOST)}`, "g"), mirrorOrigin)
      );
    }
  });

  // Hreflang
  if (!$('link[rel="alternate"][hreflang]').length) {
    $("head").append(
      `<link rel="alternate" hreflang="id" href="${fullCanonical}" />`
    );
    $("head").append(
      `<link rel="alternate" hreflang="x-default" href="${fullCanonical}" />`
    );
  }

  // Internal links
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.includes(SOURCE_HOST)) {
      $(el).attr(
        "href",
        href.replace(new RegExp(`https?://${escapeRegex(SOURCE_HOST)}`, "g"), mirrorOrigin)
      );
    }
  });

  $("form[action]").each((_, el) => {
    const action = $(el).attr("action");
    if (action && action.includes(SOURCE_HOST)) {
      $(el).attr(
        "action",
        action.replace(new RegExp(`https?://${escapeRegex(SOURCE_HOST)}`, "g"), mirrorOrigin)
      );
    }
  });

  return $.html();
}

function fixStructuredData(data, mirrorOrigin, mirrorHost) {
  if (Array.isArray(data)) {
    return data.map((item) => fixStructuredData(item, mirrorOrigin, mirrorHost));
  }
  if (data && typeof data === "object") {
    const fixed = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") {
        fixed[key] = rewriteUrls(value, mirrorOrigin, mirrorHost);
      } else if (typeof value === "object") {
        fixed[key] = fixStructuredData(value, mirrorOrigin, mirrorHost);
      } else {
        fixed[key] = value;
      }
    }
    if (fixed["@type"] === "BreadcrumbList" && fixed.itemListElement) {
      fixed.itemListElement = ensureValidBreadcrumb(fixed.itemListElement, mirrorOrigin);
    }
    return fixed;
  }
  return data;
}

function ensureValidBreadcrumb(items, mirrorOrigin) {
  if (!Array.isArray(items)) return items;
  return items
    .filter((item) => item && (item.position !== undefined || item.name || item.item))
    .map((item, index) => {
      const fixed = { ...item, position: index + 1 };
      if (fixed.item) {
        if (typeof fixed.item === "string" && fixed.item.startsWith("/")) {
          fixed.item = `${mirrorOrigin}${fixed.item}`;
        } else if (typeof fixed.item === "object" && fixed.item["@id"] && fixed.item["@id"].startsWith("/")) {
          fixed.item["@id"] = `${mirrorOrigin}${fixed.item["@id"]}`;
        }
      }
      if (!fixed["@type"]) fixed["@type"] = "ListItem";
      return fixed;
    });
}

// ---------- SKIP HEADERS ----------
const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding",
  "connection", "keep-alive", "alt-svc", "cf-ray",
  "cf-cache-status", "cf-request-id", "expect-ct",
  "nel", "report-to", "server", "x-powered-by",
]);

/**
 * Normalize browser-rendered content back to source domain URLs.
 * Puppeteer's page.content() may contain the source domain or localhost URLs.
 * We normalize everything to SOURCE_ORIGIN so rewriteUrls() can work correctly.
 */
function normalizeToSource(text) {
  if (!text) return text;
  // Remove any localhost references that Puppeteer may have introduced
  // (shouldn't happen, but just in case)
  return text;
}

// ---------- MAIN PROXY HANDLER ----------

app.all("*", async (req, res) => {
  const mirrorOrigin = getMirrorOrigin(req);
  const mirrorHost = getMirrorHost(req);
  const targetUrl = `${SOURCE_ORIGIN}${req.originalUrl}`;

  // Check cache — cache stores ORIGINAL (source-domain) content
  // Rewriting happens per-request so different hosts get correct URLs
  const cacheKey = req.originalUrl;
  const cached = cache.get(cacheKey);
  if (cached && req.method === "GET") {
    console.log(`[CACHE HIT] ${cacheKey}`);
    return serveCachedResponse(req, res, cached, mirrorOrigin, mirrorHost);
  }

  try {
    // Binary = no URL rewriting needed; Text assets = need rewriting
    const isBinaryAsset =
      /\.(jpg|jpeg|png|gif|webp|svg|ico|woff|woff2|ttf|eot|otf|mp4|mp3|pdf|zip|rar|gz|bmp|tiff|avif)$/i.test(req.path);
    const isTextAsset =
      /\.(css|js|mjs|xml|json|txt)$/i.test(req.path);
    const isAsset = isBinaryAsset || isTextAsset;
    const isFont =
      /\.(woff|woff2|ttf|eot|otf)$/i.test(req.path);

    let bodyText = null;
    let status = 200;
    let responseHeaders = {};

    // --- TRY FAST PATH: fetch with cookies ---
    if (cfCookieString) {
      try {
        const response = await fetchWithCookies(targetUrl, req.method);

        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          let location = response.headers.get("location") || "";
          if (location.startsWith("/")) {
            location = `${mirrorOrigin}${location}`;
          } else {
            location = location.replace(
              new RegExp(`https?://${escapeRegex(SOURCE_HOST)}`, "g"),
              mirrorOrigin
            );
          }
          res.status(response.status);
          res.set("Location", location);
          res.set("Cache-Control", "no-cache");
          return res.end();
        }

        // Binary assets (images, fonts, etc): serve directly without rewriting
        if (isBinaryAsset && response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          const ct = response.headers.get("content-type") || "application/octet-stream";
          const assetHeaders = {
            "Content-Type": ct,
            "Cache-Control": "public, max-age=2592000, s-maxage=31536000",
            "Content-Length": buffer.length.toString(),
            "Access-Control-Allow-Origin": "*",
          };

          cache.set(cacheKey, { status: 200, headers: assetHeaders, body: buffer }, { ttl: CACHE_ASSET_TTL });

          res.status(200);
          for (const [k, v] of Object.entries(assetHeaders)) res.set(k, v);
          return res.send(buffer);
        }

        // Text content
        const responseBody = await response.text();

        if (!isCfChallenge(response, responseBody)) {
          bodyText = responseBody;
          status = response.status;
          for (const [key, value] of response.headers.entries()) {
            if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
              responseHeaders[key] = value;
            }
          }
          console.log(`[FETCH OK] ${req.path} (${status})`);
        } else {
          console.log(`[FETCH BLOCKED] ${req.path} - CF challenge, falling back to browser`);
        }
      } catch (e) {
        console.log(`[FETCH ERROR] ${req.path}: ${e.message}`);
      }
    }

    // --- SLOW PATH: solve CF then fetch raw HTML ---
    if (bodyText === null) {
      if (!cfCookieString || Date.now() - lastCookieRefresh > COOKIE_REFRESH_INTERVAL) {
        console.log(`[CF-SOLVE] Solving challenge for ${req.path}...`);
        try {
          await solveCfChallenge(SOURCE_ORIGIN + "/");
          // Now try fetching with fresh cookies
          const raw = await fetchRawHtml(targetUrl);
          if (raw) {
            bodyText = raw.content;
            status = raw.status;
            console.log(`[FETCH-RAW OK] ${req.path} (${status})`);
          }
        } catch (e) {
          console.error(`[CF-SOLVE ERROR] ${e.message}`);
        }
      }

      // If still null, try browser rendering as absolute last resort
      if (bodyText === null) {
        try {
          console.log(`[BROWSER FALLBACK] ${req.path}`);
          const result = await fetchWithBrowser(targetUrl);
          bodyText = result.content;
          status = result.status;
        } catch (e) {
          console.error(`[BROWSER ERROR] ${e.message}`);
          return res.status(502).send("Origin server unreachable");
        }
      }
    }

    // --- DETERMINE CONTENT TYPE ---
    const ct = (responseHeaders["content-type"] || "text/html").toLowerCase();
    const isHtml = ct.includes("text/html") || (!isAsset && !req.path.match(/\.\w{2,5}$/));
    const isCss = ct.includes("text/css") || req.path.endsWith(".css");
    const isJs = ct.includes("javascript") || req.path.endsWith(".js");
    const isXml = ct.includes("xml") || req.path.endsWith(".xml");
    const isRobotsTxt = req.path === "/robots.txt";
    const contentCategory = isHtml ? "html" : (isCss || isJs || isXml || isRobotsTxt) ? "text" : "other";

    // Cache the ORIGINAL content (before rewriting) so different hosts work
    if (req.method === "GET" && status >= 200 && status < 400) {
      const ttl = isHtml ? CACHE_HTML_TTL : CACHE_ASSET_TTL;
      cache.set(cacheKey, {
        status,
        headers: { ...responseHeaders },
        originalBody: bodyText,
        contentCategory,
        isRobotsTxt,
      }, { ttl });
    }

    // Rewrite and send
    return sendRewrittenResponse(req, res, {
      status, headers: responseHeaders, originalBody: bodyText,
      contentCategory, isRobotsTxt,
    }, mirrorOrigin, mirrorHost);
  } catch (error) {
    console.error(`[PROXY ERROR] ${req.method} ${req.originalUrl}:`, error.message);
    if (!res.headersSent) {
      res.status(502).send("Bad Gateway - Origin server unreachable");
    }
  }
});

// ---------- RESPONSE HELPERS ----------

/**
 * Rewrite and send a response (used for both cache hits and fresh fetches)
 */
function sendRewrittenResponse(req, res, entry, mirrorOrigin, mirrorHost) {
  const { status, headers, originalBody, contentCategory, isRobotsTxt } = entry;
  let bodyText = originalBody;
  const responseHeaders = { ...headers };

  if (contentCategory === "html") {
    bodyText = rewriteHtml(bodyText, mirrorOrigin, mirrorHost, req.path);
    responseHeaders["Content-Type"] = "text/html; charset=utf-8";
    responseHeaders["X-Robots-Tag"] = "index, follow";
    responseHeaders["Cache-Control"] = "public, max-age=300, s-maxage=600";
  } else if (contentCategory === "text") {
    bodyText = rewriteUrls(bodyText, mirrorOrigin, mirrorHost);
    if (isRobotsTxt && !bodyText.includes("Sitemap:")) {
      bodyText += `\nSitemap: ${mirrorOrigin}/sitemap.xml\n`;
    }
    responseHeaders["Cache-Control"] = "public, max-age=3600, s-maxage=7200";
  } else {
    bodyText = rewriteUrls(bodyText, mirrorOrigin, mirrorHost);
  }

  // Rewrite source domain in headers
  for (const [key, value] of Object.entries(responseHeaders)) {
    if (typeof value === "string" && value.includes(SOURCE_HOST)) {
      responseHeaders[key] = value.replace(
        new RegExp(escapeRegex(SOURCE_HOST), "g"),
        mirrorHost
      );
    }
  }

  const resultBuffer = Buffer.from(bodyText, "utf-8");
  responseHeaders["Content-Length"] = resultBuffer.length.toString();
  responseHeaders["Access-Control-Allow-Origin"] = "*";

  res.status(status);
  for (const [k, v] of Object.entries(responseHeaders)) {
    try { res.set(k, v); } catch (e) {}
  }
  return res.send(resultBuffer);
}

/**
 * Serve a cached response with per-request URL rewriting
 */
function serveCachedResponse(req, res, cached, mirrorOrigin, mirrorHost) {
  // Binary assets don't need rewriting
  if (cached.body) {
    res.status(cached.status);
    for (const [k, v] of Object.entries(cached.headers || {})) {
      try { res.set(k, v); } catch (e) {}
    }
    return res.send(cached.body);
  }
  // Text content: rewrite per-request
  return sendRewrittenResponse(req, res, cached, mirrorOrigin, mirrorHost);
}

// ---------- STARTUP ----------

async function startup() {
  console.log("[STARTUP] Initializing mirror proxy...");

  try {
    await solveCfChallenge(SOURCE_ORIGIN + "/");
    console.log("[STARTUP] Initial CF challenge solved!");
  } catch (e) {
    console.warn(`[STARTUP] Could not solve CF on startup: ${e.message}`);
    console.warn("[STARTUP] Will retry on first request...");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`========================================`);
    console.log(`  Mirror Proxy Server Started`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Source: ${SOURCE_ORIGIN}`);
    console.log(`  Mirror Host: ${MIRROR_HOST || "(auto-detect)"}`);
    console.log(`  CF Cookies: ${cfCookies.length > 0 ? "YES ✓" : "Pending..."}`);
    console.log(`========================================`);
  });
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[SHUTDOWN] Closing browser...");
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[SHUTDOWN] Closing browser...");
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

startup();
