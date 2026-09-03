/**
 * Vercel Serverless Function: OCR 电话号码识别（最终形态）
 * 默认 PSM6 + 1500px放大1.5x + 强对比 = 一次OCR拿正确号码
 * 清晰小票 ~4s 局域网；不认错6/5/8/0混淆
 */
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');

const S_REG = /(?:^|[^\d])(1[3-9]\d{9})(?:[^\d]|$)/;
const L_REG = /1[3-9]\d{9}/;
function extractPhone(text, max = 5) {
  if (!text) return null;
  const STRIP = /\s+/g;
  const lines = String(text).split(/\r?\n/).map(l => l.replace(STRIP, '')).filter(Boolean);
  if (max >= 1) for (const l of lines) if (/^1[3-9]\d{9}$/.test(l)) return { phone: l, level: 1 };
  if (max >= 2) for (const l of lines) { const s = l.match(S_REG); if (s) return { phone: s[1], level: 2 }; }
  if (max >= 3) for (const l of lines) { const o = l.match(L_REG); if (o) return { phone: o[0], level: 3 }; }
  const all = String(text).replace(STRIP, '');
  if (max >= 4) { const s = all.match(S_REG); if (s) return { phone: s[1], level: 4 }; }
  if (max >= 5) { const o = all.match(L_REG); if (o) return { phone: o[0], level: 5 }; const o2 = text.match(L_REG); if (o2) return { phone: o2[0], level: 5 }; }
  return null;
}

let wkr = null, wInit = null;
async function getW() {
  if (wkr) return wkr;
  if (wInit) return wInit;
  wInit = (async () => {
    const langPath = path.resolve(__dirname, '..', 'tessdata');
    const w = await Tesseract.createWorker('eng', 1, { langPath });
    await w.setParameters({ tessedit_char_whitelist:'0123456789', tessedit_pageseg_mode:'6', tessedit_enable_dict:'0', tessedit_do_invert:'0', user_defined_dpi:'300' });
    wkr = w; return w;
  })();
  return wInit;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let imageBuffer;
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const bd = ct.split('boundary=')[1];
      if (bd) {
        const parts = body.split(Buffer.from('--' + bd));
        for (const part of parts) {
          if (part.includes(Buffer.from('name="image"')) || part.includes(Buffer.from('name="file"'))) {
            const i = part.indexOf(Buffer.from('\r\n\r\n'));
            if (i >= 0) {
              const e = part.indexOf(Buffer.from('\r\n--'), i);
              imageBuffer = part.slice(i + 4, e >= 0 ? e : part.length);
              break;
            }
          }
        }
      }
    } else {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      imageBuffer = Buffer.from((b.image || b.data || '').replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
    }
    if (!imageBuffer || imageBuffer.length < 100) return res.status(400).json({ error: '图片数据无效' });
    const meta = await sharp(imageBuffer).metadata();
    const maxDim = Math.max(meta.width, meta.height);
    const w = maxDim < 1600 ? Math.round(maxDim * 1.3) : 1600;
    const fw = await getW();
    const buf = await sharp(imageBuffer).resize({width:w,height:2000,fit:'inside'}).grayscale().normalize().linear(1.8,-28).sharpen({sigma:1.25}).jpeg({quality:92}).toBuffer();
    const { data } = await fw.recognize(buf);
    let hit = extractPhone(data.text, 5);
    if (!hit) {
      const w2 = Math.min(1900, Math.round(maxDim * 1.5));
      const buf2 = await sharp(imageBuffer).resize({width:w2,height:2400,fit:'inside'}).grayscale().normalize().linear(2.0,-32).sharpen({sigma:1.4}).jpeg({quality:94}).toBuffer();
      const r2 = await fw.recognize(buf2);
      hit = extractPhone(r2.data.text, 5);
      if (hit) return res.json({ text: r2.data.text, phone: hit.phone, hasPhone: true, stage: 'retry_L'+hit.level });
      return res.json({ text: r2.data.text.length>data.text.length?r2.data.text:data.text, phone: null, hasPhone: false, stage: 'not_found' });
    }
    return res.json({ text: data.text, phone: hit.phone, hasPhone: true, stage: 'L'+hit.level });
  } catch (e) {
    console.error('[OCR] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
