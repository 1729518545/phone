/**
 * Vercel Serverless Function: OCR 电话号码识别
 * 端点：POST /api/ocr
 * 入参：FormData (image/file) 或 JSON { image: base64 }
 * 出参：{ phone, text, hasPhone, stage }
 */
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');

const PHONE_REGEX_STRICT = /(?:^|[^\d])(1[3-9]\d{9})(?:[^\d]|$)/;
const PHONE_REGEX_LOOSE = /1[3-9]\d{9}/;

function extractPhone(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\s+/g, '');
  const strict = cleaned.match(PHONE_REGEX_STRICT);
  if (strict) return strict[1];
  const loose = cleaned.match(PHONE_REGEX_LOOSE);
  if (loose) return loose[0];
  const loose2 = text.match(PHONE_REGEX_LOOSE);
  return loose2 ? loose2[0] : null;
}

// eng 快速通道
let engWorker = null, engInit = null;
async function getEngWorker() {
  if (engWorker) return engWorker;
  if (engInit) return engInit;
  engInit = (async () => {
    const langPath = path.resolve(__dirname, '..', 'tessdata');
    const w = await Tesseract.createWorker('eng', 1, { langPath,
      logger: m => { if (m.status === 'recognizing text') console.log('[OCR-eng]', Math.round(m.progress*100)+'%'); } });
    await w.setParameters({ tessedit_char_whitelist:'0123456789', tessedit_pageseg_mode:'3', tessedit_enable_dict:'0', tessedit_do_invert:'0', user_defined_dpi:'300' });
    engWorker = w; return w;
  })();
  return engInit;
}

// chi_sim+eng 兜底
let fullWorker = null, fullInit = null;
async function getFullWorker() {
  if (fullWorker) return fullWorker;
  if (fullInit) return fullInit;
  fullInit = (async () => {
    const langPath = path.resolve(__dirname, '..', 'tessdata');
    const w = await Tesseract.createWorker('chi_sim+eng', 3, { langPath,
      logger: m => { if (m.status === 'recognizing text') console.log('[OCR-full]', Math.round(m.progress*100)+'%'); } });
    fullWorker = w; return w;
  })();
  return fullInit;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let imageBuffer;
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const boundary = contentType.split('boundary=')[1];
      if (boundary) {
        const parts = body.split(Buffer.from('--' + boundary));
        for (const part of parts) {
          if (part.includes(Buffer.from('name="image"')) || part.includes(Buffer.from('name="file"'))) {
            const idx = part.indexOf(Buffer.from('\r\n\r\n'));
            if (idx >= 0) {
              const endIdx = part.indexOf(Buffer.from('\r\n--'), idx);
              imageBuffer = part.slice(idx + 4, endIdx >= 0 ? endIdx : part.length);
              break;
            }
          }
        }
      }
    } else {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const b64 = (body.image || body.data || '').replace(/^data:image\/[^;]+;base64,/, '');
      imageBuffer = Buffer.from(b64, 'base64');
    }
    if (!imageBuffer || imageBuffer.length < 100) return res.status(400).json({ error: '图片数据无效' });

    const meta = await sharp(imageBuffer).metadata();
    const maxDim = Math.max(meta.width, meta.height);
    let bestText = '';

    // ========== 快速通道 eng + 数字白名单 ==========
    try {
      const fw = await getEngWorker();
      const w1 = maxDim < 1400 ? Math.round(maxDim * 1.7) : Math.min(1800, meta.width);
      const b1 = await sharp(imageBuffer).resize({width:w1,height:2000,fit:'inside'}).grayscale().normalize().linear(1.4,-15).sharpen({sigma:1.2}).jpeg({quality:90}).toBuffer();
      const r1 = await fw.recognize(b1); const p1 = extractPhone(r1.data.text);
      console.log(`[OCR] w${w1}: phone=${p1||'(无)'}`);
      if (p1) return res.json({ text:r1.data.text, phone:p1, hasPhone:true, stage:'fast' });
      bestText = r1.data.text;

      const w2 = maxDim < 1400 ? Math.round(maxDim * 2.1) : Math.min(2000, meta.width);
      const b2 = await sharp(imageBuffer).resize({width:w2,height:2200,fit:'inside'}).grayscale().normalize().linear(1.9,-25).sharpen({sigma:1.5}).jpeg({quality:92}).toBuffer();
      const r2 = await fw.recognize(b2); const p2 = extractPhone(r2.data.text);
      console.log(`[OCR] w${w2}_s1.9: phone=${p2||'(无)'}`);
      if (p2) return res.json({ text:r2.data.text, phone:p2, hasPhone:true, stage:'fast-v2' });
      if (r2.data.text.length > bestText.length) bestText = r2.data.text;
    } catch(e) { console.log('[OCR-fast] error', e.message); }

    // ========== 兜底 chi_sim+eng 必跑 ==========
    try {
      const w = await getFullWorker();
      const w1 = maxDim < 1400 ? Math.round(maxDim * 1.8) : Math.min(1800, meta.width);
      const b1 = await sharp(imageBuffer).resize({width:w1,height:2000,fit:'inside'}).grayscale().normalize().linear(1.6,-20).sharpen({sigma:1.2}).jpeg({quality:90}).toBuffer();
      const r1 = await w.recognize(b1); const p1 = extractPhone(r1.data.text);
      console.log(`[OCR-full] w${w1}: phone=${p1?'FOUND':'-'}`);
      if (p1) return res.json({ text:r1.data.text, phone:p1, hasPhone:true, stage:'full' });
      if (r1.data.text.length > bestText.length) bestText = r1.data.text;

      const w2 = maxDim < 1400 ? Math.round(maxDim * 2.2) : Math.min(2000, meta.width);
      const b2 = await sharp(imageBuffer).resize({width:w2,height:2200,fit:'inside'}).grayscale().normalize().linear(1.9,-25).sharpen({sigma:1.5}).jpeg({quality:92}).toBuffer();
      const r2 = await w.recognize(b2); const p2 = extractPhone(r2.data.text);
      console.log(`[OCR-full] w${w2}_s1.9: phone=${p2?'FOUND':'-'}`);
      if (p2) return res.json({ text:r2.data.text, phone:p2, hasPhone:true, stage:'full-v2' });
      if (r2.data.text.length > bestText.length) bestText = r2.data.text;
    } catch(e) { console.log('[OCR-full] error', e.message); }

    return res.json({ text: bestText, phone: null, hasPhone: false, stage: 'not_found' });
  } catch (e) {
    console.error('[OCR] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
