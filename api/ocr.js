/**
 * Vercel/Koyeb Serverless: OCR 电话号码识别（3 秒内完成）
 * 端点：POST /api/ocr
 * 策略：eng + 数字白名单 + PSM4 + 禁用字典 + 客户端已压缩 → 单变体无兜底
 */
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');

let fastWorker = null;
let initPromise = null;

const PHONE_REGEX = /(?:^|[^\d])(1\d{10})(?:[^\d]|$)/;

async function getWorker() {
  if (fastWorker) return fastWorker;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const langPath = path.resolve(__dirname, '..', 'tessdata');
    fastWorker = await Tesseract.createWorker('eng', 1, {
      langPath,
      logger: m => { if (m.status === 'recognizing text') console.log('[OCR]', Math.round(m.progress * 100) + '%'); }
    });
    await fastWorker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '4',    // PSM4: 单列文本（小票最佳）
      tessedit_enable_dict: '0',
      tessedit_do_invert: '0',
      user_defined_dpi: '300',
    });
    console.log('[OCR] fast worker 就绪 (PSM4+无字典)');
    return fastWorker;
  })();
  return initPromise;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { image } = body;
    if (!image) return res.status(400).json({ error: '缺少 image 字段' });

    const imageBuffer = Buffer.from(image, 'base64');
    const worker = await getWorker();
    const meta = await sharp(imageBuffer).metadata();
    const maxDim = Math.max(meta.width, meta.height);

    // 客户端已压缩到 1200px，图片不大时直接处理（省去 resize）
    let procBuf;
    if (maxDim <= 1200) {
      procBuf = await sharp(imageBuffer)
        .grayscale().normalize().linear(1.4, -15).jpeg({ quality: 90 }).toBuffer();
    } else {
      procBuf = await sharp(imageBuffer)
        .resize({ width: 1000, height: 1200, fit: 'inside', withoutEnlargement: true })
        .grayscale().normalize().linear(1.4, -15).jpeg({ quality: 90 }).toBuffer();
    }

    const r = await worker.recognize(procBuf);
    const text = r.data.text;
    const phoneMatch = text.match(PHONE_REGEX);
    console.log(`[OCR] ${maxDim <= 1200 ? 'direct' : 'resize1000'}: phone=${phoneMatch ? phoneMatch[1] : '(无)'}`);

    return res.json({ text, phone: phoneMatch ? phoneMatch[1] : null, hasPhone: !!phoneMatch, stage: 'fast' });
  } catch (e) {
    console.error('[OCR] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
