const BLOCKED_HOSTS = Object.freeze([
  "a-ads.com",
  "adservice.google.com",
  "adsterra.com",
  "akseskaiko.cam",
  "bergurukecina.fun",
  "cek.to",
  "clickadu.com",
  "doubleclick.net",
  "dub.link",
  "exoclick.com",
  "gacor.vin",
  "gacor.zone",
  "goid.space",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "goratu.site",
  "happylink.pro",
  "histats.com",
  "injd.site",
  "joiboy.ink",
  "juicyads.com",
  "kegz.site",
  "klik.best",
  "klik.gg",
  "klik.top",
  "klik.zeus.fun",
  "linkfast.asia",
  "magsrv.com",
  "mamba.top-vip.online",
  "menujupenta.site",
  "monetag.com",
  "onclckbn.net",
  "onclckmn.com",
  "onclicka.com",
  "orangarab.fun",
  "popads.net",
  "popcash.net",
  "propellerads.com",
  "pubadx.one",
  "sstatic1.histats.com",
  "tapme.ink",
  "terbangrusia.site",
  "vuukle.com",
  "wongso.top-vip.online",
  "z6v2p9a8.bkcdn.net",
]);

const BLOCKED_URL_FRAGMENTS = Object.freeze([
  "tinyurl.com/momoplay",
  "kps.link-mantap.ink",
]);

const STATIC_AD_SELECTORS = Object.freeze([
  "div.blox.mlb.kln",
  "div.blox.mlb",
  "div.blox.kln",
  ".exo-native-widget",
  ".adsbygoogle",
  ".ad-container",
  ".ad-wrapper",
  ".advertisement",
  ".popup-ad",
  ".popunder",
  "[class~='iklan']",
  "[id~='iklan']",
  "[data-aa]",
  "[data-ad-client]",
  "[data-ad-slot]",
  "[data-banner-id]",
  "[id^='adsterra-']",
  "[id^='bg-ssp-']",
]);

const DISPOSABLE_AD_CONTAINERS = [
  "div.blox.mlb",
  "div.blox.kln",
  ".ad-container",
  ".ad-wrapper",
  ".advertisement",
  ".popup-ad",
  ".popunder",
  "[class~='iklan']",
  "[id~='iklan']",
  "[data-banner-id]",
].join(",");

const INLINE_AD_PATTERNS = Object.freeze([
  /\b(?:puShown|PopWidth|PopHeight|PopFocus|PopURL)\d*\b/i,
  /\b(?:doOpen|initPu|generateURL|checkTarget)\d*\s*\(/i,
  /\b(?:popunder|popundr|popads|disqusads|ads-iframe)\b/i,
  /\b(?:setRealHref|exo-native-widget|adsbygoogle)\b/i,
  /(?:window|_Top)\.open\s*\(\s*(?:["']about:blank["']|popURL)/i,
  /\b_Hasync\b|Histats\.(?:start|fasi|track_hits)/i,
  /\bgtag\s*\(\s*["']config["']\s*,\s*["']UA-/i,
]);

const EVENT_HANDLER_ATTRIBUTES = Object.freeze([
  "onclick",
  "onmousedown",
  "onmouseup",
  "onpointerdown",
  "ontouchstart",
]);

function normalizeUrlValue(value) {
  return String(value || "")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .trim();
}

function hostMatches(hostname, blockedHost) {
  return hostname === blockedHost || hostname.endsWith(`.${blockedHost}`);
}

function isBlockedUrl(value) {
  const normalized = normalizeUrlValue(value);
  if (!normalized) return false;

  const lowered = normalized.toLowerCase();
  if (BLOCKED_URL_FRAGMENTS.some((fragment) => lowered.includes(fragment))) {
    return true;
  }

  try {
    const parsed = new URL(normalized, "https://mirror.invalid");
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "mirror.invalid") return false;
    return BLOCKED_HOSTS.some((blockedHost) => hostMatches(hostname, blockedHost));
  } catch {
    return BLOCKED_HOSTS.some((blockedHost) => lowered.includes(blockedHost));
  }
}

function containsBlockedReference(value) {
  const lowered = normalizeUrlValue(value).toLowerCase();
  return (
    BLOCKED_HOSTS.some((blockedHost) => lowered.includes(blockedHost)) ||
    BLOCKED_URL_FRAGMENTS.some((fragment) => lowered.includes(fragment))
  );
}

function removeBlockedUrlElements($) {
  const urlAttributes = ["href", "src", "data-src", "data-href", "data-url"];
  const selector = urlAttributes.map((attribute) => `[${attribute}]`).join(",");

  $(selector).each((_, element) => {
    const node = $(element);
    const blocked = urlAttributes.some((attribute) => isBlockedUrl(node.attr(attribute)));
    if (!blocked) return;

    if (element.tagName === "a") {
      const container = node.closest(DISPOSABLE_AD_CONTAINERS);
      if (container.length) {
        container.first().remove();
      } else {
        node.remove();
      }
      return;
    }

    node.remove();
  });
}

function removeInlineAdScripts($) {
  $("script").each((_, element) => {
    const node = $(element);
    const source = node.attr("src") || "";
    const content = node.html() || "";
    if (
      isBlockedUrl(source) ||
      containsBlockedReference(content) ||
      INLINE_AD_PATTERNS.some((pattern) => pattern.test(content))
    ) {
      node.remove();
    }
  });
}

function removeAdEventHandlers($) {
  const selector = EVENT_HANDLER_ATTRIBUTES
    .map((attribute) => `[${attribute}]`)
    .join(",");

  $(selector).each((_, element) => {
    const node = $(element);
    for (const attribute of EVENT_HANDLER_ATTRIBUTES) {
      const handler = node.attr(attribute) || "";
      if (
        containsBlockedReference(handler) ||
        /(?:window\.open|doOpen\d*|initPu\d*|popunder|popundr)/i.test(handler)
      ) {
        node.removeAttr(attribute);
      }
    }
  });
}

function removeAdOverlays($) {
  $("[style]").each((_, element) => {
    const node = $(element);
    const style = (node.attr("style") || "").replace(/\s+/g, "").toLowerCase();
    if (!/position:(?:fixed|sticky)/.test(style)) return;

    const marker = [
      node.attr("id") || "",
      node.attr("class") || "",
      node.html() || "",
    ].join(" ");
    const hasAdMarker = /(?:^|[\s_-])(?:ad|ads|advert|banner|iklan|popup)(?:[\s_-]|$)/i.test(marker);
    if (hasAdMarker || containsBlockedReference(marker) || node.find("iframe").length) {
      node.remove();
    }
  });
}

function buildBrowserGuardTemplate() {
  const hosts = JSON.stringify(BLOCKED_HOSTS);
  const fragments = JSON.stringify(BLOCKED_URL_FRAGMENTS);
  const selectors = JSON.stringify(STATIC_AD_SELECTORS);

  return `(function(){"use strict";const blockedHosts=${hosts};const blockedFragments=${fragments};const adSelectors=${selectors};const matchesHost=(hostname,blocked)=>hostname===blocked||hostname.endsWith("."+blocked);const isBlockedUrl=(value)=>{if(!value)return false;const normalized=String(value).replace(/\\\\\//g,"/").toLowerCase();if(blockedFragments.some((fragment)=>normalized.includes(fragment)))return true;try{const parsed=new URL(normalized,document.baseURI);return blockedHosts.some((host)=>matchesHost(parsed.hostname,host));}catch{return blockedHosts.some((host)=>normalized.includes(host));}};const purge=(root)=>{if(!root||root.nodeType!==1)return;if(root.matches(adSelectors.join(","))){root.remove();return;}for(const element of root.querySelectorAll(adSelectors.join(",")))element.remove();const candidates=[root,...root.querySelectorAll("[href],[src],[data-src],[data-href],[data-url]")];for(const element of candidates){const blocked=["href","src","data-src","data-href","data-url"].some((attribute)=>isBlockedUrl(element.getAttribute(attribute)));if(blocked)element.remove();}};const nativeOpen=window.open;window.open=function(url){if(!url||String(url).toLowerCase()==="about:blank")return null;try{const target=new URL(String(url),document.baseURI);if(target.origin!==location.origin||isBlockedUrl(target.href))return null;}catch{return null;}return nativeOpen.apply(this,arguments);};document.addEventListener("click",(event)=>{const link=event.target&&event.target.closest?event.target.closest("a[href]"):null;if(link&&isBlockedUrl(link.href)){event.preventDefault();event.stopImmediatePropagation();link.remove();}},true);const start=()=>{purge(document.documentElement);new MutationObserver((mutations)=>{for(const mutation of mutations){for(const node of mutation.addedNodes)purge(node);}}).observe(document.documentElement,{childList:true,subtree:true});};if(document.documentElement)start();else document.addEventListener("DOMContentLoaded",start,{once:true});})();`;
}

function buildBrowserGuard() {
  const template = buildBrowserGuardTemplate();
  const normalizerStart = template.indexOf("String(value).replace(");
  const normalizerEndMarker = ".toLowerCase()";
  const normalizerEnd = template.indexOf(normalizerEndMarker, normalizerStart);

  if (normalizerStart === -1 || normalizerEnd === -1) {
    throw new Error("Browser ad guard normalizer is missing");
  }

  return [
    template.slice(0, normalizerStart),
    "String(value).toLowerCase()",
    template.slice(normalizerEnd + normalizerEndMarker.length),
  ].join("");
}

function injectBrowserGuard($) {
  $("#mirror-ad-guard, #mirror-ad-styles").remove();

  const css = `${STATIC_AD_SELECTORS.join(",")} { display: none !important; visibility: hidden !important; pointer-events: none !important; }`;
  const style = $("<style></style>")
    .attr("id", "mirror-ad-styles")
    .text(css);
  const script = $("<script></script>")
    .attr("id", "mirror-ad-guard")
    .html(buildBrowserGuard());

  $("head").prepend(style);
  $("head").prepend(script);
}

function sanitizeDocument($) {
  $(STATIC_AD_SELECTORS.join(",")).remove();
  removeInlineAdScripts($);
  removeBlockedUrlElements($);
  removeAdEventHandlers($);
  removeAdOverlays($);

  $("noscript").each((_, element) => {
    const node = $(element);
    if (containsBlockedReference(node.html() || "")) node.remove();
  });

  injectBrowserGuard($);
}

module.exports = {
  BLOCKED_HOSTS,
  buildBrowserGuard,
  isBlockedUrl,
  sanitizeDocument,
};