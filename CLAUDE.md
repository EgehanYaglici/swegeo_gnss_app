# CLAUDE.md — SWEGEO GNSS App (Production)

## Project Overview

SWEGEO GNSS App is an Electron-based desktop application for real-time GNSS/INS monitoring. It communicates with NovAtel/BYNAV receivers via serial, TCP, and UDP, parsing binary (BYNAV), RTCM v3, NMEA 0183, and custom ASCII protocols.

## Tech Stack

- **Runtime**: Electron 33.3.1 + Node.js
- **Language**: JavaScript (ES6+), HTML5, CSS3
- **UI**: Vanilla JS component classes (no framework), Leaflet for maps (CDN)
- **Backend**: serialport 12.0.0 for serial communication
- **Schemas**: JSON5 declarative message/display definitions
- **Module System**: CommonJS (require/module.exports)
- **Build**: electron-builder 26.7.0 (NSIS installer for Windows x64)
- **Auto-Update**: electron-updater 6.7.3 (GitHub Releases as update source)

## Project Structure

```
swegeo_gnss_app/
├── src/
│   ├── main/main.js              # Electron main process, IPC, auto-updater
│   ├── backend/
│   │   ├── serial-manager.js     # Serial/TCP/UDP connection handling
│   │   ├── message-router.js     # Message routing, subscription, normalization
│   │   ├── binary-parser.js      # Schema-driven binary payload parsing
│   │   ├── schema-loader.js      # JSON5 schema loading + caching
│   │   ├── crc.js                # CRC32 (BYNAV) & CRC-24Q (RTCM)
│   │   ├── device-query.js       # COMCONFIG/LOGLISTA device queries
│   │   └── ntrip-client.js       # NTRIP caster connection
│   ├── preload/preload.js        # Secure IPC bridge (contextBridge)
│   ├── renderer/
│   │   ├── index.html            # Main UI template
│   │   ├── styles.css            # All styling
│   │   ├── app.js                # Component initialization orchestrator
│   │   └── components/           # UI component classes
│   └── shared/schemas/           # JSON5 message, NMEA, display schemas
├── assets/
│   ├── swegeo_logo.png           # App logo (source)
│   ├── swegeo_logo.ico           # App icon (NSIS installer requires ICO)
│   └── icons/                    # SVG icons
├── build/
│   └── installer.nsh             # NSIS DPI-awareness fix
├── package.json                  # App config + electron-builder config
└── dist/                         # Build output (not committed)
```

## Commands

```bash
npm install           # Install dependencies
npm start             # Launch app (production mode)
npm run dev           # Launch with DevTools enabled
npm run build         # Build NSIS installer (dist/ folder)
npm run build:publish # Build + auto-publish to GitHub Releases
```

## Architecture

- **Multi-process**: Electron main process <-> renderer process via IPC
- **Context Isolation**: Renderer has no direct Node.js access; all APIs go through preload bridge
- **EventEmitter pattern**: Backend classes emit events
- **Schema-driven parsing**: Binary/ASCII parsers use declarative JSON5 schemas
- **Pub/Sub subscriptions**: MessageRouter manages per-message-type subscriptions with ref counting

## SWEGEO Brand Colors (STRICT)

- **Gray**: `#9099A9` — sidebar text, secondary elements
- **Blue**: `#114D88` — primary brand blue, links, accents
- **Yellow**: `#FFBE00` — highlights, warnings, active states

All UI colors MUST come from these 3 brand colors or their rgba() variants. No off-brand tones.

## Key Guidelines

- Frameless Electron app with custom titlebar
- Vanilla JS component classes (no React/Vue/Angular)
- All IPC channels are explicitly listed in preload.js
- Schema files use JSON5 format (comments allowed)
- CRC implementations are hand-rolled — do not replace with libraries
- CSS Grid and Flexbox for layouts; CSS animations for transitions
- DevTools (Ctrl+Shift+I, F12) blocked in packaged builds

---

## SKILL: Build, Release & Update

Bu skill, uygulamanin build alinmasi, GitHub'a release verilmesi, auto-update mekanizmasi ve versiyon yonetimini kapsar.

### 1. VERSIYON YONETIMI

**Versiyon Dosyasi**: `package.json` -> `"version"` alani

```
Semantic Versioning: MAJOR.MINOR.PATCH
  0.1.0 -> ilk surum
  0.1.1 -> kucuk bug fix
  0.2.0 -> yeni ozellik eklendi
  1.0.0 -> ilk stabil production surum
```

**Versiyon degistirme**:
```bash
# package.json'daki version alanini guncelle (manuel veya npm version)
npm version patch   # 0.1.0 -> 0.1.1
npm version minor   # 0.1.0 -> 0.2.0
npm version major   # 0.1.0 -> 1.0.0

# npm version komutu otomatik olarak:
# 1. package.json'daki version'i gunceller
# 2. git commit atar
# 3. git tag olusturur (v0.1.1 gibi)
```

### 2. BUILD ALMA

**On kosullar**:
- `npm install` yapilmis olmali
- `assets/swegeo_logo.ico` mevcut olmali (NSIS icin ICO sart)
- `build/installer.nsh` mevcut olmali (DPI fix)

**Build komutu**:
```bash
cd C:\Users\egeha\OneDrive\Desktop\Projects\SWEGEO\swegeo_gnss_app

# Sadece yerel build (GitHub'a yuklemez)
npm run build

# Build + GitHub Release'e otomatik yukle
npm run build:publish
```

**Build ciktilari** (`dist/` klasoru):
```
dist/
├── SWEGEO GNSS Monitor Setup 0.1.0.exe    # Installer (kullaniciya verilecek)
├── SWEGEO GNSS Monitor Setup 0.1.0.exe.blockmap  # Delta update icin
├── latest.yml                                      # Auto-updater icin manifest
└── win-unpacked/                                   # Unpackaged build (test icin)
```

**ONEMLI**: `dist/` klasoru `.gitignore`'da — repo'ya commit edilmez.

**Build sorunlari**:
- `signAndEditExecutable: false` ayarli — code signing yok (admin privilege gerektirmemek icin)
- NSIS sadece `.ico` kabul eder, `.png` ile hata verir
- `${GH_TOKEN}` package.json'da OLMAMALI — electron-builder env'den otomatik okur

### 3. GITHUB RELEASE OLUSTURMA

#### Yontem A: Manuel Release (Tavsiye Edilen)

```bash
# 1. Versiyonu guncelle
#    package.json'daki "version" alanini degistir (ornegin "0.2.0")

# 2. Degisiklikleri commit et
git add package.json
git commit -m "bump: v0.2.0"

# 3. Tag olustur
git tag v0.2.0

# 4. Push (commit + tag birlikte)
git push origin main --tags

# 5. Build al
npm run build

# 6. GitHub Release olustur
gh release create v0.2.0 \
  --title "v0.2.0 — Aciklama Basligi" \
  --notes "- Yeni ozellik X eklendi
- Bug Y duzeltildi
- Performans iyilestirmeleri"

# 7. Build dosyalarini release'e yukle
gh release upload v0.2.0 \
  "dist/SWEGEO GNSS Monitor Setup 0.2.0.exe" \
  "dist/latest.yml" \
  "dist/SWEGEO GNSS Monitor Setup 0.2.0.exe.blockmap"
```

#### Yontem B: Otomatik Publish

```bash
# GH_TOKEN env variable set edilmis olmali
set GH_TOKEN=ghp_xxxxxxxxxxxx

# Build + otomatik release olusturma + dosya yukleme
npm run build:publish

# Bu komut:
# 1. NSIS installer'i build eder
# 2. GitHub'da draft release olusturur
# 3. exe + yml + blockmap dosyalarini yukler
# 4. Release'i publish eder
```

#### Yontem C: Main'e Atmadan Release (Feature Branch)

```bash
# 1. Feature branch'te calis
git checkout -b feature/yeni-ozellik

# 2. Degisiklikleri yap ve commit et
git add .
git commit -m "feat: yeni ozellik"

# 3. Branch'i push et
git push origin feature/yeni-ozellik

# 4. Bu branch'ten build al
npm run build

# 5. Pre-release olarak yayinla (latest olarak isaretlenmez!)
gh release create v0.2.0-beta.1 \
  --title "v0.2.0 Beta 1" \
  --notes "Test surumu" \
  --prerelease \
  --target feature/yeni-ozellik

# 6. Dosyalari yukle
gh release upload v0.2.0-beta.1 \
  "dist/SWEGEO GNSS Monitor Setup 0.2.0.exe" \
  "dist/latest.yml" \
  "dist/SWEGEO GNSS Monitor Setup 0.2.0.exe.blockmap"

# ONEMLI: --prerelease kullanildigi icin auto-updater bunu GORMEZ
# Sadece manuel indirme ile test edilebilir
# Stabil oldugunda main'e merge edip normal release yapilir
```

### 4. AUTO-UPDATE MEKANIZMASI

**Nasil calisir**:

```
Kullanici uygulamayi acar
        |
        v
main.js: setupAutoUpdater() calisiyor
        |
        v
5 saniye bekle (app tamamen yuklensin)
        |
        v
autoUpdater.checkForUpdates()
        |
        v
GitHub API'ye istek atar:
  GET https://api.github.com/repos/EgehanYaglici/swegeo_gnss_app/releases/latest
        |
        v
latest.yml dosyasini indirir ve karsilastirir:
  - Guncel versiyon: package.json "version" (ornegin 0.1.0)
  - Yeni versiyon: latest.yml'deki version (ornegin 0.2.0)
        |
   +---------+----------+
   |                     |
   v                     v
Ayni versiyon         Yeni versiyon var!
(sessizce bitirir)           |
                              v
                    Renderer'a 'updater:status' event gonderir
                    { status: 'available', version: '0.2.0' }
                              |
                              v
                    Sidebar'da buton degisir:
                    "New version available — v0.2.0"
                              |
                              v
                    Kullanici "Download" tiklarsa:
                    autoUpdater.downloadUpdate()
                              |
                              v
                    Progress event'leri:
                    { status: 'downloading', percent: 45 }
                              |
                              v
                    Indirme tamamlaninca:
                    { status: 'ready', version: '0.2.0' }
                              |
                              v
                    "Restart & Update" butonuna tiklar:
                    autoUpdater.quitAndInstall()
                              |
                              v
                    Uygulama kapanir, NSIS sessizce gunceller,
                    yeni surum acilir
```

**Manuel kontrol**: Sidebar'daki "Check for Updates" butonu `api.checkForUpdate()` cagirarak ayni akisi manuel tetikler.

**Onemli ayarlar (main.js)**:
```
autoUpdater.autoDownload = false;         // Otomatik indirme KAPALI (kullanici karar verir)
autoUpdater.autoInstallOnAppQuit = true;  // Kapanista otomatik kur
```

**Pre-release'ler guncelleme olarak GELMEZ** — sadece "Latest" isaretli release'ler kontrol edilir.

### 5. ESKI SURUME DONME

```bash
# Mevcut tag'leri listele
git tag -l

# Eski surumun kodunu gor
git show v0.1.0

# Eski surume gecis (SADECE OKUMA — detached HEAD)
git checkout v0.1.0

# Eski surumden build almak icin:
git checkout v0.1.0
npm install
npm run build
# dist/ klasorunde eski surumun installer'i olusur

# Ana branch'e geri don
git checkout main
```

**Eski bir release'i aktif hale getirmek**:
```bash
# Eski surumun exe'sini indirmek (zaten GitHub'da var)
gh release download v0.1.0 --dir ./old-releases/

# Veya eski tag'den yeniden build almak
git checkout v0.1.0
npm install
npm run build
git checkout main
```

### 6. RELEASE YONETIMI

```bash
# Tum release'leri listele
gh release list --repo EgehanYaglici/swegeo_gnss_app

# Belirli release'in detaylari
gh release view v0.1.0

# Release'e ek dosya yukle
gh release upload v0.1.0 dosya.txt

# Release'den dosya sil
gh release delete-asset v0.1.0 "eski-dosya.exe"

# Release'i sil (tag kalir)
gh release delete v0.1.0

# Tag'i de sil (dikkatli!)
git tag -d v0.1.0
git push origin :refs/tags/v0.1.0

# Draft release olustur (henuz yayinlanmaz)
gh release create v0.3.0 --draft --title "v0.3.0 — WIP"

# Draft'i yayinla
gh release edit v0.3.0 --draft=false
```

### 7. TAM RELEASE AKISI (OZET)

```
1. Kod degisikliklerini yap
2. Test et (npm start)
3. package.json version guncelle
4. git add + commit + tag
5. git push origin main --tags
6. npm run build
7. gh release create + upload
8. Kullanicilar otomatik guncelleme alir
```

### 8. GH_TOKEN AYARLAMA

Private repo icin GitHub Releases'e erisim gerektirir:

```bash
# Token olustur: GitHub -> Settings -> Developer Settings -> Personal Access Tokens
# Gerekli scope'lar: repo (Full control of private repositories)

# Windows'ta kalici env variable:
setx GH_TOKEN "ghp_xxxxxxxxxxxx"

# Veya gecici (sadece bu terminal):
set GH_TOKEN=ghp_xxxxxxxxxxxx

# Token'i dogrula:
gh auth status
```

**ONEMLI**: Token'i ASLA package.json'a yazma. electron-builder env'den otomatik okur.

### 9. SORUN GIDERME

| Sorun | Cozum |
|-------|-------|
| Build'de `${GH_TOKEN}` hatasi | package.json'da `"token"` satirini sil |
| NSIS icon hatasi | `.ico` dosyasi kullan, `.png` olmaz |
| Symlink hatasi | `"signAndEditExecutable": false` ekle |
| Update error (dev mode) | `app.isPackaged` false oldugu icin updater calismaz, normal |
| Update bulamiyor | Release'de `latest.yml` + `.exe` + `.blockmap` olmali |
| Pre-release guncelleme gelmiyor | Normal — sadece "Latest" release kontrol edilir |
| Installer bulanik | `build/installer.nsh` dosyasinda `ManifestDPIAware true` olmali |
