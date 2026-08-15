<div align="center">

![logo](https://github.com/user-attachments/assets/83d95886-2fbb-45c7-986a-e6c4d053bc55)

## StreamFlow: Web-Based Multi-Platform Streaming

[![Version](https://img.shields.io/badge/version-2.2.2-blue.svg)](https://github.com/bangtutorial/streamflow/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/bangtutorial/streamflow/blob/main/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/bangtutorial/streamflow/blob/main/CONTRIBUTING.md)
[![GitHub Stars](https://img.shields.io/github/stars/bangtutorial/streamflow?style=social)](https://github.com/bangtutorial/streamflow/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/bangtutorial/streamflow?style=social)](https://github.com/bangtutorial/streamflow/network/members)

**StreamFlow Custom** adalah aplikasi live streaming berbasis web yang dibangun dari StreamFlow dan disesuaikan untuk kebutuhan operasional channel YouTube. Fitur asli StreamFlow tetap digunakan, lalu ditambahkan New Rotations, Gallery workflow, dan otomatisasi media untuk kebutuhan live harian.

> # DISCLAIMER / ATRIBUSI
>
> ## Aplikasi ini sama dengan StreamFlow, hanya diubah dan disesuaikan dengan kebutuhan.
>
> ## Seluruh sumber, fondasi, dan kredit original adalah milik StreamFlow.
>
> Versi ini hanya menambahkan atau menyesuaikan fitur untuk kebutuhan penggunaan sendiri. Kredit source project tetap untuk [Bang Tutorial / StreamFlow](https://github.com/bangtutorial/streamflow), dan ketentuan lisensi proyek sumber tetap berlaku.

[🚀 Installation](#-quick-installation) • [📖 Documentation](#-manual-installation) • [🐳 Docker](#-docker-deployment) • [🪛 Troubleshooting](#-troubleshooting) • [💬 Community](https://github.com/bangtutorial/streamflow/discussions)

![screenshot](https://github.com/user-attachments/assets/fef1c0a5-04f6-41ae-8ea1-5eb1fff13a22)



</div>

---

## ✨ Fitur Utama

- **Multi-Platform Streaming** - Streaming ke berbagai platform populer secara bersamaan
- **Video Gallery** - Kelola koleksi video dengan antarmuka yang intuitif
- **Upload Video** - Upload dari local storage atau import langsung dari Google Drive
- **Scheduled Streaming** - Jadwalkan streaming dengan pengaturan waktu yang fleksibel
- **Advanced Settings** - Kontrol penuh untuk bitrate, resolusi, FPS, dan orientasi video
- **Real-time Monitoring** - Monitor status streaming dengan dashboard real-time
- **Video Analytics** - Pantau statistik dan performa video langsung dari aplikasi
- **Responsive UI** - Antarmuka modern yang responsif di semua perangkat

## New Rotations — Live Harian dengan Metadata Berganti

New Rotations adalah fitur tambahan untuk menjalankan satu sumber video atau playlist secara berulang, sambil mengganti **judul** dan **thumbnail** pada setiap jadwal live. Description, tags, privacy, category, channel, dan pengaturan lainnya tetap mengikuti konfigurasi Rotation.

### Cara membuat New Rotation

1. Buat kategori dan beberapa judul melalui **Title Warehouse**.
2. Siapkan folder Gallery yang hanya berisi gambar untuk thumbnail.
3. Klik **New Rotation**, pilih YouTube Channel, sumber Video/Playlist, Title Warehouse, dan folder thumbnail.
4. Atur Start Time, End Time, serta Repeat: Every Day, Every Week, atau Every Month.
5. Untuk Every Week, tambahkan beberapa kombinasi hari dan jam bila diperlukan.
6. Klik Save. Media otomatis masuk status **Preparing Media**.
7. Setelah status menjadi **Ready to Start**, klik Start.

### Rotation Ready Media

Saat New Rotation dibuat, aplikasi otomatis membuat versi media **Rotation Ready** agar live lebih stabil:

- Resolusi: 1280×720 (720p)
- Frame rate: 30 FPS
- Video bitrate: 4000 Kbps CBR
- Audio: AAC 128 Kbps

Proses encoding hanya berlangsung saat Rotation dibuat, di-sync, atau saat memilih **Rebuild 4000**. FFmpeg tidak melakukan encode ulang saat live sedang berjalan. File asli Gallery tetap disimpan; file Rotation Ready dipakai otomatis untuk New Rotation.

### Judul dan Thumbnail

- Tanpa mencentang **Do not reuse**, sistem selalu memilih judul dan thumbnail yang belum pernah dipakai live terlebih dahulu. Setelah semua pernah dipakai, sistem mulai berputar ulang.
- Dengan mencentang **Do not reuse**, judul atau thumbnail yang sudah live tidak dipakai lagi. Rotation akan selesai jika stok salah satu metadata habis.

### Playlist, Sync, dan Hasil Live

- **Source Video / Playlist** adalah sumber media lokal dari Gallery/Playlist aplikasi.
- Pilihan **Add completed live to YouTube Playlist** menambahkan hasil live ke playlist YouTube yang dipilih setelah live selesai.
- Jika isi playlist sumber berubah, gunakan **Sync / Refresh Media** dari menu Actions. Sistem hanya meng-encode video baru dan membersihkan hasil encode video yang sudah dihapus dari playlist.

### Menu Actions

Tombol utama adalah Start (atau Stop ketika aktif). Klik menu titik-tiga untuk membuka View, Edit, Rebuild 4000, Sync/Refresh Media bila tersedia, dan Delete. Edit hanya tersedia setelah Rotation dihentikan.

### Restart PM2 saat Live

Live baru menggunakan managed FFmpeg. Saat menjalankan `pm2 restart streamflow`, aplikasi akan mencoba memulihkan proses FFmpeg yang masih valid menggunakan PID dan token proses, sehingga live tidak perlu terputus karena restart aplikasi. Ini **tidak** melindungi live dari reboot seluruh VPS, karena FFmpeg ikut mati saat sistem operasi reboot.

> Saat deployment pertama fitur managed FFmpeg, tunggu live lama selesai dahulu. Live yang dibuat sebelum fitur ini belum memiliki token pemulihan.

## Atribusi StreamFlow

Aplikasi ini menggunakan **StreamFlow** sebagai sumber dan fondasi utama. Seluruh kredit atas source/original project tetap milik pembuat StreamFlow: [Bang Tutorial / StreamFlow](https://github.com/bangtutorial/streamflow).

Versi ini hanya merupakan penyesuaian untuk kebutuhan sendiri, termasuk New Rotations, pengelolaan Title Warehouse, thumbnail Gallery, Rotation Ready Media, Google Drive folder import, dan workflow live YouTube. Ketentuan lisensi proyek sumber tetap berlaku.

## 💻 System Requirements

- **Node.js** v18 atau versi terbaru
- **FFmpeg** untuk video processing
- **SQLite3** (sudah termasuk dalam package)
- **VPS/Server** dengan minimal 1 Core CPU & 1GB RAM
- **Port** 7575 (dapat disesuaikan di file [.env](.env))

## ⚡ Quick Installation

Untuk instalasi otomatis, jalankan perintah berikut:

```bash
curl -o install.sh https://raw.githubusercontent.com/bangtutorial/streamflow/main/install.sh && chmod +x install.sh && ./install.sh
```

## 🔧 Manual Installation

### 1. Persiapan Server

Update sistem operasi:
```bash
sudo apt update && sudo apt upgrade -y
```

Install Node.js:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Verifikasi instalasi Node.js:
```bash
node --version
npm --version
```

Install FFmpeg:
```bash
sudo apt install ffmpeg -y
```

Verifikasi instalasi FFmpeg:
```bash
ffmpeg -version
```

Install Git:
```bash
sudo apt install git -y
```

### 2. Setup Project StreamFlow

Clone repository:
```bash
git clone https://github.com/bangtutorial/streamflow
```

Masuk ke direktori project:
```bash
cd streamflow
```

Install Paket Node.JS:
```bash
npm install
```

Generate Secret Key:
```bash
node generate-secret.js
```

Konfigurasi port (opsional):
```bash
nano .env
```

Jalankan aplikasi:
```bash
npm run dev
```

### 3. Konfigurasi Firewall

**PENTING: Buka port SSH terlebih dahulu untuk menghindari terputusnya koneksi!**

Buka port SSH (biasanya port 22):
```bash
sudo ufw allow ssh
# atau jika menggunakan port custom SSH
# sudo ufw allow [PORT_SSH_ANDA]
```

Buka port aplikasi (default: 7575):
```bash
sudo ufw allow 7575
```

Verifikasi aturan firewall sebelum mengaktifkan:
```bash
sudo ufw status verbose
```

Aktifkan firewall:
```bash
sudo ufw enable
```

Verifikasi status firewall setelah aktif:
```bash
sudo ufw status
```

### 4. Install Process Manager

Install PM2 untuk mengelola aplikasi:
```bash
sudo npm install -g pm2
```

### 5. Menjalankan Aplikasi

Jalankan aplikasi dengan PM2:
```bash
pm2 start app.js --name streamflow
```

**Setup Auto-Restart saat Server Reboot:**
```bash
# Simpan konfigurasi PM2 saat ini
pm2 save

# Setup PM2 untuk auto-start saat server restart
pm2 startup

# Ikuti instruksi yang muncul, biasanya berupa command yang harus dijalankan dengan sudo
# Contoh output: sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u username --hp /home/username

# Setelah menjalankan command startup, save kembali
pm2 save
```

**Perintah PM2 Berguna:**
```bash
# Lihat status aplikasi
pm2 status

# Restart aplikasi
pm2 restart streamflow

# Stop aplikasi
pm2 stop streamflow

# Lihat logs aplikasi
pm2 logs streamflow

# Monitor resource usage
pm2 monit
```

Akses aplikasi melalui browser:
```
http://IP_SERVER:PORT
```

Contoh: `http://88.12.34.56:7575`


## 🔐 Reset Password

Jika lupa password atau perlu reset akun:

```bash
cd streamflow && node reset-password.js
```

## ⏰ Pengaturan Timezone Server

Untuk memastikan scheduled streaming berjalan dengan waktu yang akurat:

### Cek timezone saat ini:
```bash
timedatectl status
```

### Lihat daftar timezone tersedia:
```bash
timedatectl list-timezones | grep Asia
```

### Set timezone ke WIB (Jakarta):
```bash
sudo timedatectl set-timezone Asia/Jakarta
```

### Restart aplikasi setelah mengubah timezone:
```bash
pm2 restart streamflow
```

## 🐳 Docker Deployment

### 1. Persiapan Environment

Buat file `.env` di root project:
```env
PORT=7575
SESSION_SECRET=your_random_secret_here
NODE_ENV=development
```

### 2. Build dan Jalankan

```bash
docker-compose up --build
```

Akses aplikasi: [http://localhost:7575](http://localhost:7575)

### 3. Data Persistence

Data akan tersimpan secara otomatis di:
- Database: `db/`
- Logs: `logs/`
- Upload files: `public/uploads/`

### 4. Reset Password (Docker)

```bash
docker-compose exec app node reset-password.js
```

## 🪛 Troubleshooting

### Permission Error
```bash
chmod -R 755 public/uploads/
```

### Port Already in Use
```bash
# Cek proses yang menggunakan port
sudo lsof -i :7575

# Kill proses jika diperlukan
sudo kill -9 <PID>
```

### Database Error
```bash
# Reset database (PERINGATAN: akan menghapus semua data)
rm db/*.db

# Restart aplikasi untuk membuat database baru
pm2 restart streamflow
```

### Docker Troubleshooting

**Tidak bisa login:**
- Pastikan `NODE_ENV=development` untuk akses HTTP
- Periksa permission folder:
  ```bash
  sudo chmod -R 777 db/ logs/ public/uploads/
  ```
- Pastikan `SESSION_SECRET` tidak berubah

**Production (HTTPS):**
- Set `NODE_ENV=production`
- Akses melalui HTTPS untuk cookie session

## 💫 Contributors

[![Contributors](https://contrib.rocks/image?repo=bangtutorial/streamflow)](https://github.com/bangtutorial/streamflow/graphs/contributors)

## 📄 License

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/bangtutorial/streamflow/blob/main/LICENSE)

---
© 2026 - [Bang Tutorial](https://youtube.com/bangtutorial)


