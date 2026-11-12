/**
 * Node harness mirroring index.html OCR pipeline for regression checks.
 * Run: node test/ocr-harness.mjs
 */
import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Tesseract from 'tesseract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

const OCR_SKIP =
  /^(total|sub\s*total|amount\s*due|balance|change|vat|card|visa|mastercard|amex|contactless|cash|auth|approved|thank|receipt|date|time|tel|www\.|http|store|sainsbury|tesco|asda|lidl|co-?op|items?\s*pc|debit|credit|pin|sale|shop|basket|member|till|operator|transaction|exchange|refund|served|seq|trns|aid|arc|mid|pan|panseq)/i;

const UK_SUPERMARKET =
  /\b(aldi|tesco|sainsbury'?s?|asda|lidl|morrisons|waitrose|co-?op|iceland|m&s|marks\s*&\s*spencer|boots|greggs|heron|farmfoods|sir\s+robert)\b/i;

function cleanReceiptLabel(raw) {
  return raw
    .replace(/\s+@\s*.*$/i, '')
    .replace(/\s+\d+\s*x\s+.*$/i, '')
    .replace(/\s+[ABN]\s*$/i, '')
    .replace(/[^a-zA-Z0-9%&'’+\-.,\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingProductCode(s) {
  return (s || '').replace(/^\d{4,6}\s+/, '').trim();
}

function normalizePriceLine(line) {
  return (line || '')
    .replace(/ú/gi, '£')
    .replace(/\b[lI][.,](\d{2})\b/g, '1.$1')
    .replace(/[lI](?=\s*\d{1,4}[.,\s]\d{2}\b)/g, '£')
    .trim();
}

function isQuantitySubline(line) {
  return (
    /^\d+\s*x\s*(?:£|ú)?\s*\d/i.test(line) ||
    /^\d+\s*x\s*$/i.test(line) ||
    /^@\s*\d/i.test(line)
  );
}

function isReceiptNoiseLine(line) {
  if (OCR_SKIP.test(line)) return true;
  if (isQuantitySubline(line)) return true;
  if (/^(?:debit|credit)\s+card\b/i.test(line)) return true;
  if (/^contactless\b|^chip\s+pin\b|^pin\s+verified/i.test(line)) return true;
  if (/^vat\b/i.test(line)) return true;
  if (/^gb\s*\d/i.test(line)) return true;
  if (/^\d+\s*items?\b/i.test(line)) return true;
  if (/^store\s*#|^trn\s*#/i.test(line)) return true;
  if (UK_SUPERMARKET.test(line) && !/(?:£|ú)?\s*\d{1,4}[.,\s]\d{2}/.test(line)) return true;
  return false;
}

function finalizeItemLabel(label) {
  if (!label) return '';
  let s = cleanReceiptLabel(stripLeadingProductCode(label));
  const letters = (s.match(/[a-zA-Z]/g) || []).length;
  if (letters < 3) return '';
  if (/^(total|sub|balance|change|card|visa|debit|credit|contactless)/i.test(s)) return '';
  if (/^\d+\s*x\b/i.test(s)) return '';
  if (/^[xX]\s*\d/.test(s)) return '';
  return s.slice(0, 72);
}

function extractUkRetailLine(line) {
  const normalized = normalizePriceLine(line);
  const priceAtEnd = normalized.match(
    /(?:£\s*)?(\d{1,4})[.,\s](\d{2})\s*(?:[ABab]|£)?\s*$/i
  );
  if (!priceAtEnd) return null;
  const price = Number(`${priceAtEnd[1]}.${priceAtEnd[2]}`);
  if (!Number.isFinite(price) || price <= 0 || price > 250) return null;
  let before = normalized.slice(0, priceAtEnd.index).trim();
  before = before.replace(/\s+\d{4,6}\s*$/, '').trim();
  const label = stripLeadingProductCode(before);
  if (!label || /^\d+\s*x\s/i.test(label)) return null;
  return { label, price };
}

function extractStandalonePrice(line) {
  const normalized = normalizePriceLine(line);
  const m = normalized.match(/^(?:£\s*)?(\d{1,4})[.,\s](\d{2})\s*(?:[ABab])?\s*$/i);
  if (!m) return null;
  const price = Number(`${m[1]}.${m[2]}`);
  return Number.isFinite(price) && price > 0 && price <= 250 ? price : null;
}

function extractDescriptionOnly(line) {
  if (/(?:£|ú|l|I)\s*\d{1,4}[.,\s]\d{2}\s*$/.test(line)) return null;
  if (/^\d{4,6}\s+\D/.test(line)) return stripLeadingProductCode(line);
  const letters = (line.match(/[a-zA-Z]/g) || []).length;
  if (letters < 4) return null;
  if (isReceiptNoiseLine(line)) return null;
  return cleanReceiptLabel(line);
}

function parseReceiptLineItems(text) {
  if (!text) return [];
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 1);
  const items = [];
  const seen = new Set();
  let pendingLabel = null;

  for (const line of lines) {
    if (/^\d{1,2}[\/\-]\d{1,2}/.test(line) || /^(?:\d{2}:\d{2}|\*{3,})/.test(line)) continue;
    if (isReceiptNoiseLine(line)) {
      pendingLabel = null;
      continue;
    }

    const parsed = extractUkRetailLine(line);
    if (parsed) {
      let label = parsed.label;
      if (pendingLabel && finalizeItemLabel(label).length < 4) {
        label = pendingLabel;
      }
      pendingLabel = null;
      const finalLabel = finalizeItemLabel(label);
      if (!finalLabel) continue;
      const key = finalLabel.toLowerCase() + ':' + parsed.price;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ label: finalLabel, price: parsed.price });
      if (items.length >= 40) break;
      continue;
    }

    const soloPrice = extractStandalonePrice(line);
    if (soloPrice != null && pendingLabel) {
      const finalLabel = finalizeItemLabel(pendingLabel);
      if (finalLabel) {
        const key = finalLabel.toLowerCase() + ':' + soloPrice;
        if (!seen.has(key)) {
          seen.add(key);
          items.push({ label: finalLabel, price: soloPrice });
        }
      }
      pendingLabel = null;
      continue;
    }

    const descOnly = extractDescriptionOnly(line);
    pendingLabel = descOnly || null;
  }
  return items;
}

function normalizeOcrText(text) {
  return (text || '')
    .replace(/\r/g, '\n')
    .replace(/[|¦]/g, ' ')
    .replace(/[úùûü]/g, '£')
    .replace(/[Oo](?=\d)/g, '0')
    .replace(/(\d)[oO](?=\d)/g, '$10')
    .replace(/(\d)[lI](?=\d)/g, '$11')
    .replace(/\b[lI][.,](\d{2})\b/g, '1.$1')
    .replace(/[lI](?=\d{1,2}[.,\s]\d{2}\b)/g, '£')
    .replace(/£\s+/g, '£')
    .replace(/\u00a0/g, ' ');
}

function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let maxVar = 0;
  let threshold = 180;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (!wB) continue;
    wF = total - wB;
    if (!wF) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) ** 2;
    if (variance > maxVar) {
      maxVar = variance;
      threshold = t;
    }
  }
  return threshold;
}

function findReceiptInkBounds(imageData) {
  const { width, height, data } = imageData;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (gray < 238) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX <= minX || maxY <= minY) return null;
  const pad = Math.round(Math.min(width, height) * 0.02);
  return {
    x: Math.max(0, minX - pad),
    y: Math.max(0, minY - pad),
    w: Math.min(width, maxX - minX + pad * 2),
    h: Math.min(height, maxY - minY + pad * 2),
  };
}

async function preprocessReceiptForOcr(buffer) {
  const img = await loadImage(buffer);
  let work = createCanvas(img.width, img.height);
  const wctx = work.getContext('2d');
  wctx.fillStyle = '#fff';
  wctx.fillRect(0, 0, img.width, img.height);
  wctx.drawImage(img, 0, 0);
  let srcW = img.width;
  let srcH = img.height;
  let imageData = wctx.getImageData(0, 0, srcW, srcH);
  const bounds = findReceiptInkBounds(imageData);
  if (bounds && bounds.w > srcW * 0.15 && bounds.h > srcH * 0.15) {
    const crop = createCanvas(bounds.w, bounds.h);
    crop.getContext('2d').putImageData(wctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h), 0, 0);
    work = crop;
    srcW = bounds.w;
    srcH = bounds.h;
  }
  let w = srcW;
  let h = srcH;
  const minW = 1800;
  if (w < minW) {
    const scale = minW / w;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(work, 0, 0, w, h);
  const scaled = ctx.getImageData(0, 0, w, h);
  const d = scaled.data;
  const histogram = new Uint32Array(256);
  const grays = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const gray = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    grays[p] = gray;
    histogram[gray]++;
  }
  const threshold = otsuThreshold(histogram, w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = grays[p] < threshold ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(scaled, 0, 0);
  return canvas.toBuffer('image/png');
}

function renderSyntheticAldiReceipt() {
  const w = 420;
  const h = 1400;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#eceae4';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 22px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('ALDI', w / 2, 40);
  ctx.font = '16px monospace';
  ctx.fillText('Ellesmere Port', w / 2, 68);
  ctx.textAlign = 'left';
  let y = 110;
  const lines = [
    '20123 NATURE VALLEY       1.99 A',
    '2 x 0.99',
    '80456 COPELLA APPLE JCE   2.49 B',
    '55001 ALDI COLA 2L        0.55 A',
    '10012 BRITISH MILK 4PINT  1.15 B',
    '        2 x 0.57',
    '70234 SMOKED BACON 300G   2.29 A',
    '70235 ORGANIC BANANAS',
    '        1.59 A',
    '',
    'TOTAL                  8.47',
    'DEBIT CARD             8.47',
    'CONTACTLESS',
    'VAT NUMBER GB123',
  ];
  for (const line of lines) {
    ctx.fillText(line, 16, y);
    y += 28;
  }
  const out = path.join(fixturesDir, 'synthetic-aldi.png');
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  return out;
}

function renderPhoneStyleReceipt() {
  const w = 900;
  const h = 2200;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, w, h);
  const rx = 280;
  const rw = 340;
  ctx.fillStyle = '#e8e6df';
  ctx.fillRect(rx, 80, rw, h - 160);
  ctx.fillStyle = '#151515';
  ctx.font = '20px monospace';
  let y = 130;
  const lines = [
    'ALDI',
    'Ellesmere Port',
    '20123 NATURE VALLEY     1.99 A',
    '2 x 0.99',
    '80456 COPELLA APPLE JCE 2.49 B',
    '55001 ALDI COLA 2L      0.55 A',
    'TOTAL                  5.03',
  ];
  ctx.textAlign = 'left';
  for (const line of lines) {
    ctx.fillText(line, rx + 14, y);
    y += 34;
  }
  const out = path.join(fixturesDir, 'synthetic-phone-aldi.png');
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  return out;
}

async function runOnImage(imagePath) {
  const buf = fs.readFileSync(imagePath);
  const ocrBuf = await preprocessReceiptForOcr(buf);
  let bestItems = [];
  let bestText = '';
  for (const mode of ['4', '6']) {
    const { data } = await Tesseract.recognize(ocrBuf, 'eng', {
      tessedit_pageseg_mode: mode,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    const text = normalizeOcrText((data.text || '').trim());
    const items = parseReceiptLineItems(text);
    if (items.length > bestItems.length) {
      bestText = text;
      bestItems = items;
    }
  }
  return { text: bestText, items: bestItems };
}

const samples = [renderSyntheticAldiReceipt(), renderPhoneStyleReceipt()];
for (const sample of samples) {
  console.log('\n===', path.basename(sample), '===');
  const { text, items } = await runOnImage(sample);
  console.log(text.slice(0, 500));
  console.log(
    'items:',
    items.map((i) => `${i.label} @ ${i.price}`)
  );
}

const messyText = `
ALDI
20123 NATuRE vALLEY  l.99 A
2 x 0.99
80456 cOPELLA APPLE JCE 2.49 B
55OOl ALDI COLA 2L 0.55 A
TOTAL ú5.03
DEBIT CARD 5.03
`;
const messyItems = parseReceiptLineItems(normalizeOcrText(messyText));
console.log('\nMessy parse:', messyItems.map((i) => `${i.label} @ ${i.price}`));

const expected = ['NATURE VALLEY', 'COPELLA', 'ALDI COLA', 'BRITISH MILK', 'SMOKED BACON'];
const { items: cleanItems } = await runOnImage(samples[0]);
const labels = cleanItems.map((i) => i.label.toUpperCase());
const ok = expected.every((e) => labels.some((l) => l.includes(e)));
const messyOk =
  messyItems.some((i) => /nature valley/i.test(i.label)) &&
  messyItems.some((i) => /copella/i.test(i.label)) &&
  messyItems.some((i) => /aldi cola/i.test(i.label));
console.log('\nRegression:', ok && messyOk ? 'PASS' : 'FAIL', labels);
process.exit(ok && messyOk ? 0 : 1);
