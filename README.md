<div align="center">

# 🎨 SiberSlice

**Satu prompt. Satu sprite sheet. Semua aset siap dipakai.**

Buat satu set aset visual dari satu deskripsi. SiberSlice mengatur aset dalam sprite sheet transparan, mendeteksi batas objek dari piksel, lalu memotong setiap aset menjadi file PNG bernama dan paket ZIP.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-43853d.svg)](https://nodejs.org)
[![npm workspaces](https://img.shields.io/badge/npm-workspaces-cb3837.svg)](https://docs.npmjs.com/cli/using-npm/workspaces)
[![AI](https://img.shields.io/badge/AI-OpenAI--compatible-6e56cf.svg)](#konfigurasi-provider-ai)
[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](#)

</div>

---

> 🌐 Bagian dari **Ekosistem Siber** — dibangun dan dirawat oleh **dataSiber Lab**.

SiberSlice membantu game developer dan pembuat produk mengubah satu prompt menjadi kumpulan aset gambar. AI membuat satu sheet dan menyiapkan nama aset; engine mendeteksi batas objek dari piksel lalu memotong dan mengemas hasilnya.

Satu proses menerima **4 sampai 50 aset dengan jumlah genap**. Setiap objek boleh memiliki ukuran dan posisi berbeda; engine memetakan batas tiap objek dari gambar, bukan membagi sheet ke dalam sel berukuran sama.

Landing page menampilkan grup aset dari **semua sesi** secara publik. Preview tiap kartu berisi maksimal 4 PNG individual (disebar merata, lebih ringan daripada sheet penuh) beserta badge status penyimpanan (S3/LOCAL); klik kartu membuka detail berisi prompt dan seluruh PNG individual, dengan opsi mengunduh satu aset atau paket ZIP.

## Hasil yang bisa dibuat

- Item dan perlengkapan game, seperti pedang, perisai, potion, dan loot.
- Ikon UI untuk aplikasi, inventory, status, atau toolbar.
- Tanaman, dekorasi, props, dan objek environment.
- Set aset dengan tema dan gaya yang konsisten.

Setiap hasil menyediakan:

- Sprite sheet sumber dalam format PNG transparan.
- PNG terpisah untuk tiap aset, dengan nama yang dibuat AI dari gambar.
- ZIP berisi sheet dan semua file PNG, dengan nama file mengikuti nama grup aset.
- Nama grup hasil yang dibuat AI, beserta thumbnail publik untuk galeri landing page.

## Mulai menggunakan SiberSlice

### 1. Tulis prompt

Masukkan objek yang diinginkan beserta tema atau detail visualnya. Contoh:

```text
Set perlengkapan petualang fantasi: pedang pendek, perisai kayu,
ramuan kesehatan, kantong koin, peta tua, dan item pendukung lainnya.
Gunakan pixel art dengan palet warna yang konsisten dan bentuk yang mudah dibedakan.
```

Tombol contoh cepat di Studio dapat mengisi prompt, tema, dan gaya untuk item RPG, ikon UI, atau tanaman.

### 2. Atur tema, gaya, dan jumlah

Pilih tema, gaya visual, lalu tentukan jumlah aset genap dari **4 hingga 50**.

### 3. Generate dan unduh

SiberSlice menampilkan progres saat sheet dibuat, batas objek ditemukan dari piksel, lalu aset dipotong dan divalidasi. Ukuran objek boleh berbeda dan posisi tidak harus mengikuti grid tetap. Setelah selesai, tab **Assets** terbuka otomatis. Buka tab **Sheet** untuk melihat gambar sumber, unduh satu aset dengan memilih gambarnya, atau unduh seluruh paket.

## Cara kerja

Satu permintaan pengguna memulai satu proses AI. Sistem mempertahankan tool loop selama proses tersebut agar AI dapat melanjutkan dari hasil tiap tool tanpa meminta prompt ulang. Setelah semua aset berhasil dipotong, AI memberi nama grup untuk ditampilkan di Studio dan galeri.

```text
Prompt → Generate → Local connected-component slicing → Crop validation → Group naming → PNG + ZIP
```

Agent menggunakan empat tool:

| Tool | Fungsi |
|---|---|
| `image_gen` | Membuat sprite sheet PNG transparan dengan jumlah tepat dan daftar nama aset; ukuran dan posisi boleh berbeda. Sheet dapat dibuat ulang sekali jika segmentasi gagal menemukan jumlah yang diminta. |
| `crop_assets` | Membuat mask dari alpha PNG, mendeteksi komponen tersambung secara lokal, menggabungkan fragmen berdekatan hingga jumlah kelompok sesuai, lalu memotong dan memvalidasi PNG. Tidak meminta koordinat dari model AI. Untuk gambar tanpa transparansi, tool menghapus latar putih yang tersambung ke tepi crop sehingga detail putih tertutup outline tetap ada. |
| `name_asset_group` | Memberi nama pada grup setelah seluruh aset berhasil dipotong. |
| `exec` | Menjalankan perintah shell di folder kerja proses jika AI memerlukan pemrosesan tambahan. |

Slicing memakai pemrosesan piksel lokal: sistem mencoba beberapa ambang alpha, membuang komponen kecil, lalu menggabungkan fragmen berdekatan sampai jumlah kelompok sesuai jumlah aset yang diminta. AI utama menyiapkan nama file dalam urutan baca; provider image analyzer tidak dipanggil untuk menentukan batas crop.

Nama file dibuat dalam format aman seperti `iron-sword.png` atau `health-potion.png`. Jika model memberi nama yang sama untuk lebih dari satu aset, sistem menambahkan akhiran agar file tidak saling menimpa. Nama tersebut juga ditampilkan di bawah tiap aset pada Studio.

## Penyiapan untuk pengelola aplikasi

### Persyaratan

- Node.js 20 atau lebih baru.
- Python 3, Pillow, dan NumPy untuk auto-slicing (`python3 -m pip install Pillow numpy`).
- Dua konfigurasi API yang kompatibel dengan OpenAI: AI utama dengan tool calling dan image generation. Image analysis multimodal kini opsional.

### Menjalankan lokal

```bash
cp .env.example .env
npm install
python3 -m pip install Pillow numpy
npm run dev
```

Buka [http://localhost:8200](http://localhost:8200). Untuk menjalankan tanpa watch mode:

```bash
npm start
```

### Menjalankan dengan PM2

`ecosystem.config.cjs` menjalankan server langsung melalui Node.js pada port `8200`.

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
```

Untuk melihat log proses:

```bash
pm2 logs siberslice
```

Lengkapi konfigurasi AI utama dan image generation di `.env` sebelum generate. Indikator **PROVIDERS 2/2** di Studio menunjukkan kedua provider wajib sudah tersedia. Provider image analysis bersifat opsional dan tidak dipanggil oleh auto-slicing.

### Konfigurasi provider AI

Setiap provider memiliki base URL, API key, dan nama model sendiri. Base URL umumnya menyertakan prefix `/v1`.

| Variabel | Digunakan untuk |
|---|---|
| `SIBERSLICE_MAIN_AI_BASE_URL` | Endpoint chat completions untuk agent utama. |
| `SIBERSLICE_MAIN_AI_API_KEY` | API key agent utama. |
| `SIBERSLICE_MAIN_AI_MODEL` | Model chat yang mendukung tool/function calling. |
| `SIBERSLICE_MAIN_AI_REASONING_EFFORT` | `reasoning_effort` untuk AI utama: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, atau `max`; default `none`. |
| `SIBERSLICE_MAIN_AI_MAX_OUTPUT_TOKENS` | Batas token output per request AI utama, dikirim sebagai `max_tokens`; opsional, tanpa nilai memakai default provider. |
| `SIBERSLICE_IMAGE_GEN_BASE_URL` | Endpoint image generation. |
| `SIBERSLICE_IMAGE_GEN_API_KEY` | API key image generation. |
| `SIBERSLICE_IMAGE_GEN_MODEL` | Nama model gambar. |
| `SIBERSLICE_IMAGE_GEN_SIZE` | Ukuran sprite sheet; default `1536x1024`. |
| `SIBERSLICE_IMAGE_ANALYZE_BASE_URL` | Opsional; disimpan untuk penggunaan image analysis di masa depan. Tidak dipanggil dalam alur auto-slicing. |
| `SIBERSLICE_IMAGE_ANALYZE_API_KEY` | Opsional; API key image analysis. |
| `SIBERSLICE_IMAGE_ANALYZE_MODEL` | Opsional; nama model vision. |
| `SIBERSLICE_PORT` | Port HTTP server; default `8200`. |
| `SIBERSLICE_DATA_DIR` | Folder data sesi; default `./data`. |
| `SIBERSLICE_MAX_ITERATIONS` | Batas iterasi agent AI utama per proses generate; bilangan bulat positif, default `50`. |
| `SIBERSLICE_GALLERY_PAGE_SIZE` | Jumlah grup aset per halaman di `/api/gallery` dan galeri landing; default `20`, maksimal `100`. |
| `SIBERSLICE_GALLERY_PREVIEW_COUNT` | Jumlah gambar preview per kartu galeri; default `4`, maksimal `8`. Grid kartu menyesuaikan jumlah baris otomatis. |
| `SIBERSLICE_ADMIN_PASSWORD` | Password bersama untuk masuk ke `/admin`; wajib diisi agar endpoint admin aktif. |
| `SIBERSLICE_S3_BUCKET` | Bucket S3-compatible untuk menyimpan hasil generate. Kosong = penyimpanan lokal saja. |
| `SIBERSLICE_S3_ACCESS_KEY` / `SIBERSLICE_S3_SECRET_KEY` | Kredensial bucket. Keduanya wajib bersama bucket agar mode S3 aktif. |
| `SIBERSLICE_S3_REGION` | Region S3; default `us-east-1` (MinIO/R2 sering menerima nilai ini). |
| `SIBERSLICE_S3_ENDPOINT` | Endpoint khusus untuk MinIO/R2/Wasabi/B2. Kosong = AWS S3 asli. |
| `SIBERSLICE_S3_PUBLIC_BASE_URL` | Opsional; origin publik bucket (mis. custom domain Cloudflare R2 `https://siberslice-s3.datasiber.com`). Jika diisi, tampilan gambar dan akses eksternal memakai URL publik stabil `<base>/<key>` yang bisa di-cache CDN — tanpa presign. Tombol download tetap memakai presigned URL agar nama file benar. Kosong = semua lewat presigned URL. |
| `SIBERSLICE_S3_FORCE_PATH_STYLE` | `true` (default) untuk MinIO/self-hosted; `false` untuk AWS S3/R2 virtual-host style. |
| `SIBERSLICE_S3_PREFIX` | Prefiks key objek di bucket; default `runs`. |
| `SIBERSLICE_S3_PURGE_LOCAL` | `true` = file lokal dihapus setelah upload sukses; default `false` (file lokal tetap disimpan). |
| `SIBERSLICE_S3_PRESIGN_TTL` | Umur presigned URL dalam detik; default `900`. |

Contoh `.env.example`:

```ini
# AI utama: chat completions dan tool calling
SIBERSLICE_MAIN_AI_BASE_URL=https://api.example.com/v1
SIBERSLICE_MAIN_AI_API_KEY=replace-me
SIBERSLICE_MAIN_AI_MODEL=your-tool-calling-model
SIBERSLICE_MAIN_AI_REASONING_EFFORT=none
# Opsional; kosongkan agar provider memakai batas output bawaannya.
# SIBERSLICE_MAIN_AI_MAX_OUTPUT_TOKENS=8192

# Image generation: PNG transparan
SIBERSLICE_IMAGE_GEN_BASE_URL=https://images.example.com/v1
SIBERSLICE_IMAGE_GEN_API_KEY=replace-me
SIBERSLICE_IMAGE_GEN_MODEL=your-image-model
SIBERSLICE_IMAGE_GEN_SIZE=1536x1024

# Opsional dan saat ini tidak dipakai untuk auto-slicing.
SIBERSLICE_IMAGE_ANALYZE_BASE_URL=https://vision.example.com/v1
SIBERSLICE_IMAGE_ANALYZE_API_KEY=replace-me
SIBERSLICE_IMAGE_ANALYZE_MODEL=your-vision-model

SIBERSLICE_PORT=8200
SIBERSLICE_DATA_DIR=./data
SIBERSLICE_MAX_ITERATIONS=50
SIBERSLICE_ADMIN_PASSWORD=

# Opsional: simpan hasil generate di penyimpanan S3-compatible.
SIBERSLICE_S3_BUCKET=
SIBERSLICE_S3_ACCESS_KEY=
SIBERSLICE_S3_SECRET_KEY=
SIBERSLICE_S3_REGION=us-east-1
SIBERSLICE_S3_ENDPOINT=
SIBERSLICE_S3_FORCE_PATH_STYLE=true
SIBERSLICE_S3_PREFIX=runs
SIBERSLICE_S3_PURGE_LOCAL=false
SIBERSLICE_S3_PRESIGN_TTL=900
```

Atur password admin yang unik di `.env`; jangan gunakan nilai contoh atau commit password ke Git. Kamu bisa membuat password acak dengan `openssl rand -base64 32`.

#### Penyimpanan S3 (MinIO, Cloudflare R2, Wasabi, Backblaze, AWS S3, CloudHost iS3)

Jika `SIBERSLICE_S3_BUCKET`, `SIBERSLICE_S3_ACCESS_KEY`, dan `SIBERSLICE_S3_SECRET_KEY` terisi, setiap run yang selesai otomatis diunggah ke bucket (`<prefix>/<sessionId>/<runId>/...`) secara paralel (8 request bersamaan). Frontend tetap memakai URL `/api/sessions/...` yang sama; server hanya me-redirect ke presigned URL S3, sehingga trafik gambar/ZIP besar mengalir langsung dari S3, bukan dari server Node. Aset dan ZIP yang diunduh dengan tombol download mendapat `Content-Disposition: attachment` di dalam presigned URL sehingga tersimpan sebagai file, bukan terbuka di tab.

- **Fallback lokal:** jika upload gagal (atau run dibuat sebelum mode S3 aktif), hasil tetap aman di disk dan tetap bisa ditampilkan/diunduh — server melayani dari file lokal. Galeri dan Studio menampilkan badge status penyimpanan per grup: **S3** (hijau, tersimpan di cloud) atau **LOCAL** (merah, tersimpan di disk server).
- **Migrasi lokal → S3:** `npm run migrate:s3 --workspace @siberslice/web` (tambahkan `-- --purge-local` untuk menghapus file lokal setelah upload sukses).
- **Restore S3 → lokal (mengembalikan):** `npm run restore:s3 --workspace @siberslice/web` mengunduh kembali seluruh objek run ke disk dan menghapus manifest S3-nya sehingga serve kembali lewat lokal. Opsi: `-- --session <id>` (satu sesi) dan `-- --purge-remote` (hapus salinan cloud setelah unduhan berhasil). Tersedia juga dari panel admin: tombol **Kembalikan ke Lokal** di detail sesi, dengan checkbox *Hapus dari S3*.
- **Menghapus sesi dari admin** juga menghapus objek S3 milik sesi tersebut; kegagalan cleanup S3 tidak memblokir penghapusan lokal dan dicatat di `server-errors.jsonl` (`s3_delete_failed`).
- **Diagnostik kecepatan server → S3:** `npm run speedtest:s3 --workspace @siberslice/web -- --mb 2` mengukur latensi handshake (DNS+TCP+TLS), latensi API (HeadBucket), throughput PUT/GET, dan jalur presigned URL. Hanya menulis objek uji sementara lalu menghapusnya.
- `SIBERSLICE_S3_PURGE_LOCAL=true` menghapus sheet/aset/ZIP lokal setiap habis upload; log di `logs/` selalu tetap di disk. Untuk provider seperti CloudHost iS3, endpoint wajib mencakup `https://` (mis. `https://is3.cloudhost.id`) dan umumnya `SIBERSLICE_S3_FORCE_PATH_STYLE=true`; bucket harus sudah dibuat sebelumnya (lewat panel atau API).

#### Kebutuhan kompatibilitas API

- Provider utama harus menyediakan `/chat/completions` dan mendukung tool calling.
- Image generator menerima permintaan `/images/generations` dengan `background: "transparent"` dan `output_format: "png"`. Hasil harus berupa PNG langsung, `data[0].b64_json`, `data[0].url`, atau field gambar kompatibel yang didukung provider.
- Provider image analysis opsional; alur auto-slicing tidak mengirim gambar ke model vision.

API key hanya digunakan di server dan tidak dikirim ke browser.

## Sesi dan penyimpanan

Sesi membuat ruang kerja sendiri dan tetap menyimpan hasil generate. Setiap proses generate mempunyai folder kerja terpisah di dalam sesi tersebut. Tool loop AI berlangsung hanya selama satu proses; prompt sebelumnya tidak dikirim sebagai riwayat percakapan ke permintaan generate berikutnya.

Panel pengelola tersedia di `/admin`. Panel ini menampilkan daftar sesi, metadata session, prompt, sheet, aset PNG, ZIP, log percakapan AI, event proses, dan log error server. Pengelola dapat menghapus satu sesi beserta seluruh run, file lokal, dan objek S3-nya, serta memulihkan run dari S3 kembali ke disk lewat tombol **Kembalikan ke Lokal**. Pemeriksaan runtime di panel memverifikasi executable `python3`, versi Python, serta paket Pillow dan NumPy yang dipakai slicing.

Panel admin memakai satu password bersama dari `SIBERSLICE_ADMIN_PASSWORD` dan cookie sesi HttpOnly yang berakhir setelah 8 jam. Jika password belum disetel, login dan endpoint admin dinonaktifkan. Autentikasi pengguna per akun belum tersedia; galeri dan endpoint generate tetap publik.

Data disimpan di `SIBERSLICE_DATA_DIR`:

```text
data/
├── logs/
│   └── server-errors.jsonl
└── sessions/
    └── <session-id>/
        ├── session.json
        └── runs/
            └── <run-id>/
                ├── sheet.png
                ├── assets/
                │   ├── iron-sword.png
                │   └── health-potion.png
                ├── assets.zip
                └── logs/
                    ├── conversation.jsonl
                    └── events.jsonl
```

Setiap kali Studio dibuka, aplikasi membuat sesi kosong dan tidak memulihkan hasil dari sesi sebelumnya. Satu proses generate memakai satu sesi; saat pengguna menekan **Generate** lagi, Studio membuat sesi baru dan mempertahankan prompt serta pengaturan untuk proses baru. Tombol **Session baru** tetap tersedia untuk membersihkan builder secara manual.

Grup yang selesai disimpan bersama nama AI, prompt, tema, gaya, jumlah aset, dan daftar nama PNG agar galeri publik dapat memuat hasil lintas sesi.

Setiap run menyimpan `logs/conversation.jsonl` berisi payload request dan response AI utama serta image generator yang dipakai. Pemotongan tidak mengirim gambar ke image analyzer; batas objek dideteksi secara lokal. API key dan header autentikasi tidak dicatat. `logs/events.jsonl` menyimpan input run, progres tool, error beserta stack, dan status selesai/gagal. Error request server dicatat di `data/logs/server-errors.jsonl`. File log tetap di folder data dan tidak disajikan oleh endpoint file publik.

## API aplikasi

| Method | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/api/config` | Status kesiapan dan nama model provider, tanpa API key. |
| `GET` | `/api/gallery?offset=0` | Mengambil satu halaman berisi maksimal 20 grup aset publik (`previewUrls` maksimal 4 aset, `storage` `s3`/`local`, `nextOffset`/`hasMore` untuk Load more). |
| `POST` | `/api/sessions` | Membuat sesi baru. |
| `GET` | `/api/sessions/:sessionId` | Membaca metadata sesi dan hasil terakhir. |
| `POST` | `/api/sessions/:sessionId/generate` | Memulai proses generate dan mengirim progres melalui Server-Sent Events. |
| `GET` | `/api/sessions/:sessionId/files/:path` | Mengambil file hasil dari sesi. |
| `GET` | `/api/sessions/:sessionId/runs/:runId/export` | Mengunduh ZIP hasil proses. |
| `GET` | `/api/admin/auth` | Memeriksa konfigurasi password dan status login admin. |
| `POST` | `/api/admin/login` | Login admin dengan password dari environment. |
| `POST` | `/api/admin/logout` | Mengakhiri sesi login admin. |
| `GET` | `/api/admin/sessions` | Daftar sesi untuk panel admin. |
| `GET` | `/api/admin/sessions/:sessionId` | Detail session, seluruh run, dan daftar asetnya. |
| `GET` | `/api/admin/sessions/:sessionId/runs/:runId/logs/:type` | Membaca log `conversation` atau `events` dari satu run. |
| `DELETE` | `/api/admin/sessions/:sessionId` | Menghapus sesi, seluruh file lokal, dan objek S3 miliknya; ditolak saat sesi sedang dipakai. |
| `POST` | `/api/admin/sessions/:sessionId/restore` | Memulihkan run S3 sesi ke disk lokal; body opsional `{ "purgeRemote": true }` untuk hapus salinan cloud. |
| `GET` | `/api/admin/python-check` | Memeriksa Python, Pillow, dan NumPy yang tersedia untuk server. |
| `GET` | `/api/admin/server-errors` | Membaca catatan error server terbaru. |

Semua endpoint `/api/admin/*` selain status login, login, dan logout membutuhkan cookie admin yang valid. Password admin tidak disimpan di SQLite.

## Rencana pengembangan

- Ganti password admin bersama dengan akun pengguna, login, dan peran untuk panel pengelola.
- Pindahkan data akun ke SQLite dan hubungkan setiap sesi dengan pemiliknya melalui `user_id`.
- Terapkan pemeriksaan kepemilikan di endpoint sesi dan hasil agar pengguna hanya dapat membuka sesi miliknya; admin dapat mengelola seluruh sesi.
- Migrasikan metadata sesi yang sekarang berada di `session.json` ke SQLite, sambil mempertahankan file PNG, ZIP, dan log sebagai berkas di disk dengan referensi dari database.

Rencana akun pengguna dan SQLite ini belum diterapkan. Saat ini sesi masih disimpan sebagai folder di `data/sessions/<session-id>/`; panel admin dilindungi satu password environment.

## Struktur project

```text
.
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── agent/          # AI agent dan tool loop
│   │       ├── providers/      # Validasi provider OpenAI-compatible
│   │       └── tools/          # Image generation, analysis, crop, shell
│   └── web/
│       └── src/
│           ├── config/         # Pembacaan .env
│           ├── server/         # HTTP API, sesi, file hasil, panel admin
│           └── frontend/public/
│               ├── assets/
│               ├── css/        # landing, studio, dan admin
│               ├── js/         # landing, studio, dan admin
│               ├── admin.html
│               ├── asset-generator.html
│               └── index.html
├── data/                       # Sesi dan file hasil lokal
├── .env.example
├── package.json
└── README.md
```

## Catatan deployment

Tool `exec` menjalankan shell tanpa OS sandbox dengan hak akses proses Node.js, dan memiliki batas waktu 120 detik. Jalankan SiberSlice hanya di mesin dan lingkungan tepercaya. Panel `/admin` dilindungi password environment, tetapi server belum memiliki akun pengguna atau pembatasan kepemilikan sesi. Galeri menampilkan prompt dan hasil semua sesi secara publik, sementara endpoint generate juga belum dibatasi dengan login pengguna.

Simpan `.env` dan folder data dengan benar. `.env` berisi kredensial provider, sedangkan `data/` berisi session dan hasil generate. Keduanya sudah dikecualikan dari Git.

## Kontak &amp; ekosistem

<div align="center">

Dibuat oleh **[dataSiber Lab](https://datasiber.com)** sebagai bagian dari Ekosistem Siber.

📧 [candrapwr@datasiber.com](mailto:candrapwr@datasiber.com) · 🌐 [datasiber.com](https://datasiber.com)

</div>
