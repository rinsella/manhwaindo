const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { load } = require("cheerio");
const { buildBrowserGuard, isBlockedUrl, sanitizeDocument } = require("../ad-filter");

test("removes snapshot ads without removing comic image hosts", () => {
  const snapshotPath = path.join(__dirname, "..", "hasilviewsource.txt");
  const $ = load(fs.readFileSync(snapshotPath, "utf8"));

  sanitizeDocument($);

  const remainingScripts = $("script:not(#mirror-ad-guard)")
    .map((_, element) => `${$(element).attr("src") || ""} ${$(element).html() || ""}`)
    .get()
    .join("\n");

  assert.doesNotMatch(remainingScripts, /linkfast\.asia|puShown1|doOpen1/i);
  assert.doesNotMatch(remainingScripts, /histats|googletagmanager/i);
  assert.equal($("a[href*='linkfast.asia']").length, 0);
  assert.equal($("#mirror-ad-guard").length, 1);
  assert.equal($("#mirror-ad-styles").length, 1);
  assert.ok($("img[src*='kacu.gmbr.pro'], img[data-src*='kacu.gmbr.pro']").length > 0);
  assert.ok($("img[src*='cdnxyz.xyz'], img[data-src*='cdnxyz.xyz']").length > 0);
});

test("removes ad elements, popups, and suspicious event handlers", () => {
  const $ = load(`
    <html>
      <head>
        <script src="https://cdn.popcash.net/pop.js"></script>
        <script>window.open("about:blank");</script>
        <script>window.open("/reader/help");</script>
      </head>
      <body>
        <div style="position: fixed; bottom: 0" class="banner-ad">
          <a href="https://linkfast.asia/campaign"><img src="banner.jpg"></a>
        </div>
        <button onclick="window.open('https://linkfast.asia/campaign')">Open</button>
        <a id="chapter" href="/chapter/1">Chapter 1</a>
      </body>
    </html>
  `);

  sanitizeDocument($);

  assert.equal($("script[src*='popcash.net']").length, 0);
  assert.equal($(".banner-ad").length, 0);
  assert.equal($("button").attr("onclick"), undefined);
  assert.equal($("#chapter").attr("href"), "/chapter/1");
  assert.match($("script:not(#mirror-ad-guard)").text(), /reader\/help/);
});

test("matches blocked hostnames without blocking similarly named or content hosts", () => {
  assert.equal(isBlockedUrl("https://sub.magsrv.com/ad.js"), true);
  assert.equal(isBlockedUrl("https://linkfast.asia/offer"), true);
  assert.equal(isBlockedUrl("https://notlinkfast.asia.example.com/file.js"), false);
  assert.equal(isBlockedUrl("https://cdn.vuukle.com/platform.js"), true);
  assert.equal(isBlockedUrl("https://kacu.gmbr.pro/uploads/chapter.jpg"), false);
  assert.equal(isBlockedUrl("https://cdnxyz.xyz/web/cover.png"), false);
});

test("browser guard executes blocked-link checks without runtime errors", () => {
  let clickHandler;
  let linkRemoved = false;
  const documentElement = {
    nodeType: 1,
    getAttribute: () => null,
    matches: () => false,
    querySelectorAll: () => [],
  };
  const document = {
    baseURI: "https://mirror.example/",
    documentElement,
    addEventListener: (name, handler) => {
      if (name === "click") clickHandler = handler;
    },
  };
  const window = {
    location: { origin: "https://mirror.example" },
    open: () => ({ opened: true }),
  };
  class MutationObserver {
    observe() {}
  }

  const runGuard = new Function(
    "window",
    "document",
    "location",
    "MutationObserver",
    "URL",
    buildBrowserGuard()
  );
  runGuard(window, document, window.location, MutationObserver, URL);

  assert.doesNotThrow(() => clickHandler({
    target: {
      closest: () => ({
        href: "https://ad.a-ads.com/banner",
        remove: () => { linkRemoved = true; },
      }),
    },
    preventDefault() {},
    stopImmediatePropagation() {},
  }));
  assert.equal(linkRemoved, true);
  assert.equal(window.open("https://example.com/popup"), null);
});