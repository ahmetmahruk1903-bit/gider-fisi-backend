 require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { randomUUID, scryptSync, timingSafeEqual } = require('crypto');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const Tesseract = require('tesseract.js');

const app = express();
const PORT = process.env.PORT || 4000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new sqlite3.Database(path.join(dataDir, 'app.db'));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      vendor_name TEXT,
      vendor_tax_number TEXT,
      receipt_date TEXT,
      receipt_time TEXT,
      receipt_no TEXT,
      workplace_no TEXT,
      terminal_no TEXT,
      card_last4 TEXT,
      category TEXT,
      payment_type TEXT,
      currency TEXT,
      subtotal TEXT,
      vat_total TEXT,
      grand_total TEXT,
      vehicle_plate TEXT,
      note TEXT,
      ocr_raw_text TEXT,
      image_url TEXT,
      created_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY,
      token TEXT,
      month TEXT,
      year TEXT,
      created_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password_hash TEXT,
      role TEXT,
      created_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT,
      created_at TEXT
    )
  `);

  const adminUsername = 'gider@gm.com';
  db.get(`SELECT id FROM users WHERE username = ?`, [adminUsername], (err, user) => {
    if (err || user) return;

    db.run(
      `INSERT INTO users VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), adminUsername, hashPassword('3432'), 'admin', new Date().toISOString()]
    );
  });
});

function hashPassword(password) {
  const salt = randomUUID();
  const hash = scryptSync(String(password), salt, 64).toString('hex');

  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;

  const [salt, hash] = storedHash.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const inputBuffer = scryptSync(String(password), salt, 64);

  return hashBuffer.length === inputBuffer.length && timingSafeEqual(hashBuffer, inputBuffer);
}

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.auth || '');

  if (!token) return res.status(401).json({ error: 'Oturum gerekli' });

  db.get(
    `SELECT sessions.token, users.id, users.username, users.role
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ?`,
    [token],
    (err, session) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!session) return res.status(401).json({ error: 'Oturum geçersiz' });

      req.user = {
        id: session.id,
        username: session.username,
        role: session.role
      };
      next();
    }
  );
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin yetkisi gerekli' });
  next();
}

function fixTurkishText(text) {
  if (!text) return '';
  return String(text)
    .replace(/Ä°/g, 'İ')
    .replace(/Ä±/g, 'ı')
    .replace(/ÅŸ/g, 'ş')
    .replace(/Åž/g, 'Ş')
    .replace(/ÄŸ/g, 'ğ')
    .replace(/Äž/g, 'Ğ')
    .replace(/Ã¼/g, 'ü')
    .replace(/Ãœ/g, 'Ü')
    .replace(/Ã¶/g, 'ö')
    .replace(/Ã–/g, 'Ö')
    .replace(/Ã§/g, 'ç')
    .replace(/Ã‡/g, 'Ç')
    .replace(/�/g, '');
}

function getCleanLines(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

function normalizeOcrText(text) {
  return fixTurkishText(text)
    .replace(/[|]/g, 'I')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\bF\s*[İI]\s*Ş\b/gi, 'FİŞ')
    .replace(/\bT\s*O\s*P\s*L\s*A\s*M\b/gi, 'TOPLAM')
    .replace(/\bK\s*D\s*V\b/gi, 'KDV');
}

function cleanMoney(value) {
  if (!value) return '';
  return String(value)
    .replace(/\*/g, '')
    .replace(/TL|TRY|₺/gi, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
}

function moneyToNumber(value) {
  return Number(cleanMoney(value)) || 0;
}

function extractMoneyValues(text) {
  const matches = String(text).match(/(?:\*|₺|TL|TRY)?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2}|[\d]+[.,]\d{2}|[\d]{2,6})\s*(?:TL|TRY|₺)?/gi) || [];

  return matches
    .map(match => cleanMoney(match))
    .filter(value => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 && number < 1000000;
    });
}

function extractDecimalMoneyValues(text) {
  const matches = String(text).match(/(?:\*|₺|TL|TRY)?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2}|[\d]+[.,]\d{2})\s*(?:TL|TRY|₺)?/gi) || [];

  return matches
    .map(match => cleanMoney(match))
    .filter(value => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 && number < 1000000;
    });
}

function findVendorName(text) {
  const lines = getCleanLines(text);

  for (const line of lines.slice(0, 18)) {
    const cleaned = line.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü0-9\s&.-]/g, '').trim();

    if (!cleaned) continue;
    if (/^\d+$/.test(cleaned)) continue;
    if (/mh|mah|cd|cad|bulv|blv|apt|no|sok|sk\.|tel|fax|www|http|adres|seyhan|adana/i.test(cleaned)) continue;
    if (/tarih|saat|fis|fiş|toplam|kdv|vergi|vd|mersis|sicil|kasiyer|sube|şube/i.test(cleaned)) continue;
    if (cleaned.length < 3) continue;

    if (cleaned.toUpperCase().includes('HAS OTO')) return 'HAS OTO';

    return cleaned.replace(/\bp\b$/i, '').trim();
  }

  return '';
}

function findTaxNumber(text) {
  const match =
    text.match(/vd\s*[:.]?\s*([0-9]{8,11})/i) ||
    text.match(/v\.?d\.?\s*[:.]?\s*([0-9]{8,11})/i) ||
    text.match(/vergi\s*no\s*[:.]?\s*([0-9]{8,11})/i) ||
    text.match(/vkn\s*[:.]?\s*([0-9]{8,11})/i) ||
    text.match(/tckn\s*[:.]?\s*([0-9]{11})/i);
  return match ? match[1] : '';
}

function findDate(text) {
  const isoMatch = text.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000) {
      return `${isoMatch[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const matches = [...text.matchAll(/(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2,4})/g)];
  for (const match of matches) {
    const day = Number(match[1]);
    let month = Number(match[2]);
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    if (month > 12 && match[2].length === 2) {
      const likelyMonth = Number(match[2].slice(1));
      if (likelyMonth >= 1 && likelyMonth <= 12) month = likelyMonth;
    }
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return '';
}

function findTime(text) {
  const match = text.match(/(\d{2})[:.](\d{2})/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return `${match[1]}:${match[2]}`;
}

function findReceiptNo(text) {
  const match =
    text.match(/F[İI]Ş\s*NO\s*[:.]?\s*([0-9A-Z-]+)/i) ||
    text.match(/FIS\s*NO\s*[:.]?\s*([0-9A-Z-]+)/i) ||
    text.match(/BELGE\s*NO\s*[:.]?\s*([0-9A-Z-]+)/i) ||
    text.match(/FATURA\s*NO\s*[:.]?\s*([0-9A-Z-]+)/i) ||
    text.match(/F[İI]SNO\s*[:.]?\s*([0-9A-Z-]+)/i);
  return match ? match[1] : '';
}

function findWorkplaceNo(text) {
  const match =
    text.match(/[İI]ŞYER[İI]\s*NO\s*[:.]?\s*([0-9]+)/i) ||
    text.match(/ISYERI\s*NO\s*[:.]?\s*([0-9]+)/i);
  return match ? match[1] : '';
}

function findTerminalNo(text) {
  const match = text.match(/TERMINAL\s*[:.]?\s*([0-9]+)/i);
  return match ? match[1] : '';
}

function findCardLast4(text) {
  const match = text.match(/\*{2,}\s*\*{2,}\s*\*{2,}\s*([0-9]{4})/);
  return match ? match[1] : '';
}

function findTotal(text) {
  const lines = getCleanLines(text);
  const totalLines = lines.filter(l => /GENEL\s*TOPLAM|TOPLAM|ÖDENECEK|ODENECEK|TUTAR|SATIŞ\s*TOPLAMI|SATIS\s*TOPLAMI|KRED[Iİ]\s*KART|NAK[Iİ]T/i.test(l));

  for (let line of totalLines.reverse()) {
    const values = extractMoneyValues(line);
    if (values.length) return values[values.length - 1];
  }

  const allAmounts = extractMoneyValues(text)
    .map(value => ({ value, number: Number(value) }))
    .filter(item => item.number >= 1);

  if (!allAmounts.length) return '';

  return allAmounts.sort((a, b) => b.number - a.number)[0].value;
}

function findVat(text) {
  const lines = getCleanLines(text);
  const total = moneyToNumber(findTotal(text));
  const vatLines = lines.filter(l => /KDV|TOPKDV|TOPLAMKDV|K\.D\.V/i.test(l));

  for (let line of vatLines.reverse()) {
    const values = extractDecimalMoneyValues(line)
      .filter(value => !total || Number(value) <= total);
    if (values.length) return values[values.length - 1];
  }

  if (total) {
    const estimated = total - (total / 1.20);
    return estimated > 0 ? estimated.toFixed(2) : '';
  }

  return '';
}

function findCategory(text) {
  const t = text.toLowerCase();
  if (t.includes('oto') || t.includes('yedek') || t.includes('parça') || t.includes('parca')) return 'Araç Yedek Parça';
  if (t.includes('elektrik') || t.includes('elektro')) return 'Elektrik Malzemesi';
  if (t.includes('inş') || t.includes('ins') || t.includes('boya')) return 'İnşaat Malzemesi';
  if (t.includes('yakıt') || t.includes('yakit') || t.includes('benzin') || t.includes('motorin')) return 'Yakıt';
  if (t.includes('yemek') || t.includes('restoran')) return 'Yemek';
  return 'Diğer';
}

function findPaymentType(text) {
  const t = text.toLowerCase();
  if (t.includes('kredi') || t.includes('kart') || t.includes('visa') || t.includes('master') || t.includes('pos')) return 'Kredi Kartı';
  if (t.includes('nakit')) return 'Nakit';
  return '';
}

async function analyzeReceipt(filePath) {
  const result = await Tesseract.recognize(filePath, 'tur+eng', {
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1'
  });
  const text = normalizeOcrText(result.data.text || '');
  const grandTotal = findTotal(text);
  const vatTotal = findVat(text);
  const subtotal = grandTotal && vatTotal ? (Number(grandTotal) - Number(vatTotal)).toFixed(2) : '';

  return {
    vendor_name: findVendorName(text),
    vendor_tax_number: findTaxNumber(text),
    receipt_date: findDate(text),
    receipt_time: findTime(text),
    receipt_no: findReceiptNo(text),
    workplace_no: findWorkplaceNo(text),
    terminal_no: findTerminalNo(text),
    card_last4: findCardLast4(text),
    category: findCategory(text),
    payment_type: findPaymentType(text),
    currency: 'TRY',
    subtotal,
    vat_total: vatTotal,
    grand_total: grandTotal,
    ocr_raw_text: text
  };
}

function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;

  const host = req.get('host') || '';
  if (!host) return '';
  return `${req.protocol}://${host}`;
}

function normalizeFileUrl(value, req) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const baseUrl = getBaseUrl(req);
  if (!baseUrl) return raw;

  const localHostPattern = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

  if (raw.startsWith('/api/') || raw.startsWith('/uploads/')) {
    return `${baseUrl}${raw}`;
  }

  try {
    const url = new URL(raw);
    const isBackendFile = url.pathname.startsWith('/api/receipt-image/') || url.pathname.startsWith('/uploads/');

    if (isBackendFile || localHostPattern.test(url.hostname)) {
      return `${baseUrl}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    return raw;
  }

  return raw;
}

function normalizeReceipt(row, req) {
  return {
    ...row,
    image_url: normalizeFileUrl(row.image_url, req)
  };
}

function buildReceiptMonthFilter(month, year) {
  if (!month || !year) {
    return { where: 'WHERE 1 = 0', params: [] };
  }

  const paddedMonth = String(month).padStart(2, '0');
  const plainMonth = String(Number(month));
  const yearText = String(year);

  return {
    where: `
      WHERE (
        strftime('%m', receipt_date) = ? AND strftime('%Y', receipt_date) = ?
      ) OR (
        substr(receipt_date, 4, 2) = ? AND substr(receipt_date, 7, 4) = ?
      ) OR (
        substr(receipt_date, 4, 1) = ? AND substr(receipt_date, 6, 4) = ?
      )
    `,
    params: [paddedMonth, yearText, paddedMonth, yearText, plainMonth, yearText]
  };
}

function formatReportPeriod(month, year) {
  if (!month || !year) return 'Tüm Kayıtlar';

  const monthNames = [
    'Ocak',
    'Şubat',
    'Mart',
    'Nisan',
    'Mayıs',
    'Haziran',
    'Temmuz',
    'Ağustos',
    'Eylül',
    'Ekim',
    'Kasım',
    'Aralık'
  ];
  const monthIndex = Number(month) - 1;
  const monthName = monthNames[monthIndex] || String(month).padStart(2, '0');

  return `${monthName} ${year}`;
}

function getReceiptPeriod(receiptDate) {
  const value = String(receiptDate || '').trim();

  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return { month: String(Number(match[2])), year: match[1] };
  }

  match = value.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (match) {
    return { month: String(Number(match[2])), year: match[3] };
  }

  return { month: '', year: '' };
}

function filterReceiptsByPeriod(rows, month, year) {
  const targetMonth = String(Number(month));
  const targetYear = String(year);

  return rows.filter(row => {
    const period = getReceiptPeriod(row.receipt_date);

    return period.month === targetMonth && period.year === targetYear;
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'Gider Fişi Takip Sistemi' });
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
    }

    const token = randomUUID().replaceAll('-', '');
    db.run(
      `INSERT INTO sessions VALUES (?, ?, ?)`,
      [token, user.id, new Date().toISOString()],
      insertErr => {
        if (insertErr) return res.status(500).json({ error: insertErr.message });

        res.json({
          token,
          user: {
            username: user.username,
            role: user.role
          }
        });
      }
    );
  });
});

app.get('/api/receipt-image/:filename', (req, res) => {
  const filename = req.params.filename;

  res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
      <meta charset="UTF-8" />
      <title>Fiş Ön İzleme</title>
      <style>
        body { margin:0; background:#071324; color:white; font-family:Arial; padding:24px; text-align:center; }
        .top { max-width:900px; margin:0 auto 18px; display:flex; justify-content:space-between; align-items:center; }
        a { background:#f5b33f; color:#071324; padding:10px 16px; border-radius:8px; text-decoration:none; font-weight:bold; }
        img { max-width:100%; max-height:85vh; background:white; border-radius:12px; }
      </style>
    </head>
    <body>
      <div class="top">
        <h2>Fiş Ön İzleme</h2>
        <a href="/uploads/${filename}" download>İndir</a>
      </div>
      <img src="/uploads/${filename}" />
    </body>
    </html>
  `);
});

app.use('/api', (req, res, next) => {
  if (
    req.path === '/health' ||
    req.path === '/auth/login' ||
    req.path.startsWith('/public/report/') ||
    req.path.startsWith('/receipt-image/')
  ) {
    return next();
  }

  return requireAuth(req, res, next);
});

app.get('/api/users', requireAdmin, (req, res) => {
  db.all(`SELECT id, username, role, created_at FROM users ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
  }

  const user = {
    id: randomUUID(),
    username,
    password_hash: hashPassword(password),
    role: 'user',
    created_at: new Date().toISOString()
  };

  db.run(
    `INSERT INTO users VALUES (?, ?, ?, ?, ?)`,
    [user.id, user.username, user.password_hash, user.role, user.created_at],
    err => {
      if (err) {
        if (String(err.message).includes('UNIQUE')) {
          return res.status(409).json({ error: 'Bu kullanıcı zaten var' });
        }

        return res.status(500).json({ error: err.message });
      }

      res.status(201).json({
        id: user.id,
        username: user.username,
        role: user.role,
        created_at: user.created_at
      });
    }
  );
});

app.put('/api/users/me/password', (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Mevcut şifre ve yeni şifre gerekli' });
  }

  db.get(`SELECT * FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Mevcut şifre hatalı' });
    }

    db.run(
      `UPDATE users SET password_hash = ? WHERE id = ?`,
      [hashPassword(newPassword), req.user.id],
      updateErr => {
        if (updateErr) return res.status(500).json({ error: updateErr.message });
        res.json({ ok: true });
      }
    );
  });
});

app.post('/api/receipts/upload', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Dosya yüklenmedi' });

    const analyzed = await analyzeReceipt(req.file.path);
    const imageUrl = `${getBaseUrl(req)}/api/receipt-image/${req.file.filename}`;

    res.json({
      image_url: imageUrl,
      analyzed: {
        ...analyzed,
        image_url: imageUrl
      }
    });
  } catch (error) {
    console.error('OCR HATASI:', error);
    res.status(500).json({ error: 'Fiş okunamadı', detail: error.message });
  }
});

app.post('/api/receipts', (req, res) => {
  const r = {
    id: randomUUID(),
    vendor_name: req.body.vendor_name || '',
    vendor_tax_number: req.body.vendor_tax_number || '',
    receipt_date: req.body.receipt_date || '',
    receipt_time: req.body.receipt_time || '',
    receipt_no: req.body.receipt_no || '',
    workplace_no: req.body.workplace_no || '',
    terminal_no: req.body.terminal_no || '',
    card_last4: req.body.card_last4 || '',
    category: req.body.category || '',
    payment_type: req.body.payment_type || '',
    currency: req.body.currency || 'TRY',
    subtotal: req.body.subtotal || '',
    vat_total: req.body.vat_total || '',
    grand_total: req.body.grand_total || '',
    vehicle_plate: req.body.vehicle_plate || '',
    note: req.body.note || '',
    ocr_raw_text: req.body.ocr_raw_text || '',
    image_url: normalizeFileUrl(req.body.image_url, req),
    created_at: new Date().toISOString()
  };

  db.run(
    `INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Object.values(r),
    err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(normalizeReceipt(r, req));
    }
  );
});

app.get('/api/receipts', (req, res) => {
  db.all(`SELECT * FROM receipts ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(row => normalizeReceipt(row, req)));
  });
});
app.put('/api/receipts/:id', (req, res) => {
  const r = req.body;

  db.run(
    `UPDATE receipts SET
      vendor_name = ?,
      vendor_tax_number = ?,
      receipt_date = ?,
      receipt_time = ?,
      receipt_no = ?,
      workplace_no = ?,
      terminal_no = ?,
      card_last4 = ?,
      category = ?,
      payment_type = ?,
      currency = ?,
      subtotal = ?,
      vat_total = ?,
      grand_total = ?,
      vehicle_plate = ?,
      note = ?,
      ocr_raw_text = ?,
      image_url = ?
    WHERE id = ?`,
    [
      r.vendor_name || '',
      r.vendor_tax_number || '',
      r.receipt_date || '',
      r.receipt_time || '',
      r.receipt_no || '',
      r.workplace_no || '',
      r.terminal_no || '',
      r.card_last4 || '',
      r.category || '',
      r.payment_type || '',
      r.currency || 'TRY',
      r.subtotal || '',
      r.vat_total || '',
      r.grand_total || '',
      r.vehicle_plate || '',
      r.note || '',
      r.ocr_raw_text || '',
      normalizeFileUrl(r.image_url, req),
      req.params.id
    ],
    err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

app.delete('/api/receipts/:id', (req, res) => {
  db.run(`DELETE FROM receipts WHERE id = ?`, [req.params.id], err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post('/api/share-links', (req, res) => {
  const link = {
    id: randomUUID(),
    token: randomUUID().replaceAll('-', ''),
    month: String(req.body.month || ''),
    year: String(req.body.year || ''),
    created_at: new Date().toISOString()
  };

  db.run(
    `INSERT INTO share_links VALUES (?, ?, ?, ?, ?)`,
    [link.id, link.token, link.month, link.year, link.created_at],
    err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(link);
    }
  );
});

app.get('/api/public/report/:token', (req, res) => {
  db.get(`SELECT * FROM share_links WHERE token = ?`, [req.params.token], (err, link) => {
    if (err || !link) return res.status(404).send('Link bulunamadı');

    db.all(`SELECT * FROM receipts ORDER BY receipt_date DESC`, [], (err2, allRows) => {
      if (err2) return res.status(500).send(err2.message);

      const rows = filterReceiptsByPeriod(allRows, link.month, link.year)
        .map(row => normalizeReceipt(row, req));
      const reportPeriod = formatReportPeriod(link.month, link.year);
      const money = v => Number(String(v || '0').replace(',', '.')) || 0;
      const total = rows.reduce((s, r) => s + money(r.grand_total), 0);
      const vat = rows.reduce((s, r) => s + money(r.vat_total), 0);

      const tableRows = rows.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${r.receipt_date || '-'}</td>
          <td>${r.vendor_name || '-'}</td>
          <td>${r.vendor_tax_number || '-'}</td>
          <td>${r.receipt_no || '-'}</td>
          <td>${r.category || '-'}</td>
          <td>${money(r.vat_total).toFixed(2)} TL</td>
          <td>${money(r.grand_total).toFixed(2)} TL</td>
          <td>${r.image_url ? `<a href="${r.image_url}" target="_blank">Fişi Gör</a>` : '-'}</td>
        </tr>
      `).join('');

      res.send(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
          <meta charset="UTF-8" />
          <title>Gider Fişleri Raporu</title>
          <style>
            body {
              margin: 0;
              font-family: Arial, sans-serif;
              background: #f3f6f9;
              color: #142033;
            }

            .header {
              background: #071324;
              color: white;
              padding: 28px 42px;
              display: flex;
              align-items: center;
              gap: 20px;
            }

            .header img {
              width: 70px;
              height: 70px;
              object-fit: contain;
              border-radius: 10px;
            }

            .header h1 {
              margin: 0;
              color: #f5b33f;
              font-size: 28px;
            }

            .header p {
              margin: 6px 0 0;
              color: #e5e7eb;
            }

            .container {
              padding: 32px 42px;
            }

            .cards {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 16px;
              margin-bottom: 24px;
            }

            .card {
              background: white;
              border-radius: 14px;
              padding: 20px;
              box-shadow: 0 8px 25px #0000000d;
              border: 1px solid #e5e7eb;
            }

            .card span {
              display: block;
              color: #64748b;
              margin-bottom: 8px;
              font-size: 14px;
            }

            .card b {
              font-size: 24px;
            }

            .actions {
              margin-bottom: 20px;
              display: flex;
              gap: 12px;
            }

            .actions a {
              background: #071324;
              color: white;
              text-decoration: none;
              padding: 12px 16px;
              border-radius: 10px;
              font-weight: 700;
            }

            .actions a.gold {
              background: #f5b33f;
              color: #071324;
            }

            table {
              width: 100%;
              border-collapse: collapse;
              background: white;
              border-radius: 14px;
              overflow: hidden;
              box-shadow: 0 8px 25px #0000000d;
            }

            th {
              background: #071324;
              color: white;
              padding: 12px;
              text-align: left;
              font-size: 13px;
            }

            td {
              padding: 11px 12px;
              border-bottom: 1px solid #e5e7eb;
              font-size: 13px;
            }

            tr:nth-child(even) td {
              background: #f8fafc;
            }

            td a {
              background: #f5b33f;
              color: #071324;
              padding: 7px 10px;
              border-radius: 8px;
              text-decoration: none;
              font-weight: 700;
              font-size: 12px;
            }

            .footer-total td {
              background: #071324 !important;
              color: white;
              font-weight: 700;
            }

            @media(max-width: 900px) {
              .cards {
                grid-template-columns: 1fr;
              }

              .container {
                padding: 20px;
              }

              table {
                font-size: 12px;
              }

              th, td {
                padding: 8px;
              }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <img src="/uploads/logo.png" />
            <div>
              <h1>Gider Fişleri Raporu</h1>
              <p>${reportPeriod} · Sürekli · Dijital · Güvenilir</p>
            </div>
          </div>

          <div class="container">
            <div class="cards">
              <div class="card">
                <span>Toplam Fiş</span>
                <b>${rows.length}</b>
              </div>
              <div class="card">
                <span>Toplam KDV</span>
                <b>${vat.toFixed(2)} TL</b>
              </div>
              <div class="card">
                <span>Toplam Gider</span>
                <b>${total.toFixed(2)} TL</b>
              </div>
            </div>

            <div class="actions">
              <a class="gold" href="/api/export/excel?month=${encodeURIComponent(link.month || '')}&year=${encodeURIComponent(link.year || '')}">Excel İndir</a>
              <a href="/api/export/pdf?month=${encodeURIComponent(link.month || '')}&year=${encodeURIComponent(link.year || '')}">PDF İndir</a>
            </div>

            <table>
              <thead>
                <tr>
                  <th>No</th>
                  <th>Tarih</th>
                  <th>Firma</th>
                  <th>Vergi No</th>
                  <th>Fiş No</th>
                  <th>Kategori</th>
                  <th>KDV</th>
                  <th>Toplam</th>
                  <th>Görsel</th>
                </tr>
              </thead>
              <tbody>
                ${tableRows}
                <tr class="footer-total">
                  <td colspan="6">Toplam Fiş: ${rows.length}</td>
                  <td>${vat.toFixed(2)} TL</td>
                  <td>${total.toFixed(2)} TL</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        </body>
        </html>
      `);
    });
  });
});
app.get('/api/export/excel', async (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) {
    return res.status(400).json({ error: 'Rapor için ay ve yıl seçilmelidir.' });
  }

  const reportPeriod = formatReportPeriod(month, year);

db.all(`SELECT * FROM receipts ORDER BY receipt_date DESC`, [], async (err, allRows) => {
    if (err) return res.status(500).json({ error: err.message });

    const ExcelJS = require('exceljs');
    const rows = filterReceiptsByPeriod(allRows, month, year)
      .map(row => normalizeReceipt(row, req));
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Gider Fişleri');

    sheet.columns = [
      { header: 'Tarih', key: 'receipt_date', width: 15 },
      { header: 'Firma', key: 'vendor_name', width: 30 },
      { header: 'Vergi No', key: 'vendor_tax_number', width: 18 },
      { header: 'Fiş No', key: 'receipt_no', width: 15 },
      { header: 'Kategori', key: 'category', width: 22 },
      { header: 'Ödeme Tipi', key: 'payment_type', width: 18 },
      { header: 'KDV', key: 'vat_total', width: 15 },
      { header: 'Toplam', key: 'grand_total', width: 15 },
      { header: 'Fiş Görseli', key: 'image_url', width: 45 }
    ];

    rows.forEach(row => {
      sheet.addRow(row);
    });

    sheet.spliceRows(1, 0, [`Rapor Dönemi: ${reportPeriod}`], []);
    sheet.mergeCells('A1:I1');
    sheet.getRow(1).font = { bold: true, size: 14 };
    sheet.getRow(3).font = { bold: true };

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Cache-Control', 'no-store');

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="gider-fisleri.xlsx"'
    );

    await workbook.xlsx.write(res);
    res.end();
  });
});

app.get('/api/export/pdf', (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) {
    return res.status(400).json({ error: 'Rapor için ay ve yıl seçilmelidir.' });
  }

  const reportPeriod = formatReportPeriod(month, year);

db.all(`SELECT * FROM receipts ORDER BY receipt_date DESC`, [], (err, allRows) => {
    if (err) return res.status(500).json({ error: err.message });

    const PDFDocument = require('pdfkit');
    const rows = filterReceiptsByPeriod(allRows, month, year);
    const doc = new PDFDocument({ margin: 35, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="gider-fisleri-raporu.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    doc.pipe(res);

    const dark = '#071324';
    const gold = '#f5b33f';
    const logoPath = path.join(__dirname, '..', 'uploads', 'logo.png');

    const money = v => Number(String(v || '0').replace(',', '.')) || 0;

    const total = rows.reduce((s, r) => s + money(r.grand_total), 0);
    const vat = rows.reduce((s, r) => s + money(r.vat_total), 0);

    doc.rect(0, 0, doc.page.width, 95).fill(dark);

    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 25, 12, { fit: [70, 70] });
    }

    doc.fillColor(gold)
      .fontSize(20)
      .text('Gider Fisleri Raporu', 110, 28);

    doc.fillColor('#ffffff')
      .fontSize(10)
      .text(`${safeText(reportPeriod)} · Surekli · Dijital · Guvenilir`, 110, 58);
    doc.y = 125;

    const startX = 35;
    const rowH = 30;

    const cols = [
      { title: 'No', x: 35, w: 35 },
      { title: 'Tarih', x: 70, w: 75 },
      { title: 'Firma', x: 145, w: 130 },
      { title: 'Fis No', x: 275, w: 60 },
      { title: 'Kategori', x: 335, w: 100 },
      { title: 'KDV', x: 435, w: 60 },
      { title: 'Toplam', x: 495, w: 65 }
    ];

    function safeText(v) {
      return String(v || '-')
        .replace(/ı/g, 'i')
        .replace(/İ/g, 'I')
        .replace(/ş/g, 's')
        .replace(/Ş/g, 'S')
        .replace(/ğ/g, 'g')
        .replace(/Ğ/g, 'G')
        .replace(/ü/g, 'u')
        .replace(/Ü/g, 'U')
        .replace(/ö/g, 'o')
        .replace(/Ö/g, 'O')
        .replace(/ç/g, 'c')
        .replace(/Ç/g, 'C');
    }

    function drawHeader() {
      const y = doc.y;
      doc.rect(startX, y, 525, rowH).fill(dark);
      doc.fillColor('white').fontSize(8);

      cols.forEach(c => {
        doc.text(c.title, c.x + 3, y + 10, { width: c.w - 6 });
      });

      doc.y = y + rowH;
    }

    function drawRow(r, index) {
      if (doc.y > 740) {
        doc.addPage();
        doc.y = 40;
        drawHeader();
      }

      const y = doc.y;
      const bg = index % 2 === 0 ? '#f8fafc' : '#ffffff';

      doc.rect(startX, y, 525, rowH).fill(bg).stroke('#d1d5db');
      doc.fillColor('#111827').fontSize(7);

      const values = [
        String(index + 1),
        r.receipt_date || '-',
        safeText(r.vendor_name),
        r.receipt_no || '-',
        safeText(r.category),
        money(r.vat_total).toFixed(2),
        money(r.grand_total).toFixed(2)
      ];

      cols.forEach((c, i) => {
        doc.text(values[i], c.x + 3, y + 9, {
          width: c.w - 6,
          height: rowH - 6
        });
      });

      doc.y = y + rowH;
    }

    drawHeader();
    rows.forEach((r, i) => drawRow(r, i));

    if (doc.y > 720) doc.addPage();

    doc.moveDown(0.5);

    const footerY = doc.y;

    doc.rect(startX, footerY, 525, 34)
       .fill(dark)
       .stroke('#d1d5db');
    
    doc.fillColor('white')
       .fontSize(8);
    
    // Sol taraf
    doc.text(
      `Toplam Fis: ${rows.length}`,
      38,
      footerY + 11,
      { width: 390 }
    );
    
    // KDV sütunu altı
    doc.text(
      `${vat.toFixed(2)} TL`,
      438,
      footerY + 11,
      { width: 54 }
    );
    
    // Toplam sütunu altı
    doc.text(
      `${total.toFixed(2)} TL`,
      498,
      footerY + 11,
      { width: 60 }
    );

    doc.end();
  });
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API çalışıyor: 0.0.0.0:${PORT}`);
});
