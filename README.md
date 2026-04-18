# ManhwaIndo Mirror Proxy

Full mirror reverse proxy untuk `www.manhwaindo.my` dengan fix SEO lengkap agar bisa diindex Google tanpa masalah.

## Masalah SEO yang Diperbaiki

| Masalah Google Search Console | Solusi |
|------|--------|
| Duplikat, Google memilih versi kanonis yang berbeda | Canonical URL di-rewrite ke domain mirror |
| Tidak ditemukan (404) | Status code diteruskan dengan benar dari origin |
| Halaman dengan pengalihan | Redirect Location header di-rewrite ke domain mirror |
| Data terstruktur Breadcrumb | BreadcrumbList JSON-LD diperbaiki (URL, position, @type) |
| Data terstruktur tidak dapat diurai | JSON-LD yang rusak diperbaiki atau dihapus |

## Fitur

- **Full URL Rewriting** — Semua URL di HTML, CSS, JS, JSON-LD, sitemap, robots.txt di-rewrite ke domain mirror
- **Canonical Tag Fix** — Otomatis set canonical ke URL mirror
- **Structured Data Fix** — JSON-LD/Breadcrumb diperbaiki agar valid per standar Google
- **Redirect Handling** — 301/302 redirect di-rewrite supaya tidak loop
- **Open Graph Fix** — `og:url`, `twitter:url` di-rewrite
- **Hreflang Tags** — Ditambahkan jika belum ada
- **Sitemap Rewriting** — URL dalam sitemap.xml di-rewrite
- **Robots.txt** — Di-rewrite + pastikan Sitemap URL benar
- **Binary Passthrough** — Gambar, font, video langsung diproxy tanpa modifikasi
- **Gzip/Brotli Support** — Decompress otomatis dari origin, re-compress ke client
- **Cache Control** — Header cache yang optimal per tipe konten

## Deploy

### Railway

1. Push repo ini ke GitHub
2. Buka [railway.app](https://railway.app), buat project baru dari GitHub repo
3. Set environment variables:
   - `SOURCE_HOST` = `www.manhwaindo.my`
   - `MIRROR_HOST` = domain mirror kamu (misalnya `manhwaindo.railway.app`)
4. Railway otomatis deploy via Dockerfile

### Render

1. Push repo ini ke GitHub
2. Buka [render.com](https://render.com), buat Web Service baru dari GitHub repo
3. Settings:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. Set environment variables sama seperti Railway

### VPS (Docker)

```bash
# Clone repo
git clone https://github.com/rinsella/manhwaindo.git
cd manhwaindo

# Build & run
docker build -t manhwaindo-mirror .
docker run -d \
  -p 3000:3000 \
  -e SOURCE_HOST=www.manhwaindo.my \
  -e MIRROR_HOST=yourdomain.com \
  --name manhwaindo-mirror \
  --restart unless-stopped \
  manhwaindo-mirror
```

### VPS (Langsung Node.js)

```bash
# Clone & install
git clone https://github.com/rinsella/manhwaindo.git
cd manhwaindo
npm install

# Set environment variables
export SOURCE_HOST=www.manhwaindo.my
export MIRROR_HOST=yourdomain.com
export PORT=3000

# Jalankan
node server.js

# Atau pakai PM2 untuk production
npm install -g pm2
pm2 start server.js --name manhwaindo-mirror
pm2 save
pm2 startup
```

## Environment Variables

| Variable | Default | Keterangan |
|----------|---------|------------|
| `SOURCE_HOST` | `www.manhwaindo.my` | Domain asal yang dimirror |
| `MIRROR_HOST` | _(auto-detect)_ | Domain mirror kamu. Kosongkan untuk auto-detect dari request header |
| `PORT` | `3000` | Port server (Railway/Render set otomatis) |
| `CUSTOM_UA` | `Mozilla/5.0 (compatible; MirrorBot/1.0)` | User-Agent untuk request ke origin |

## Tips untuk Google Search Console

1. **Submit Sitemap** — Setelah deploy, submit `https://yourdomain.com/sitemap.xml` di GSC
2. **Request Indexing** — Gunakan URL Inspection tool di GSC untuk request index halaman penting
3. **Pastikan MIRROR_HOST diset** — Ini penting supaya canonical URL benar
4. **Custom Domain** — Gunakan custom domain (bukan subdomain railway/render) untuk SEO yang lebih baik