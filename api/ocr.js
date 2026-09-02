/**
 * Vercel Serverless Function: OCR 电话号码识别
 * 端点：POST /api/ocr
 * 入参：{ image: "base64编码的图片" }
 * 出参：{ phone: "11位手机号", text: "识别文本", hasPhone: true/false }
 *
 * 策略：eng + 数字白名单 + PSM6 + 禁用字典 + JPEG q90 + sharpen
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
      tessedit_pageseg_mode: '3',    // PSM3: 全自动版面分析
      tessedit_enable_dict: '0',
      tessedit_do_invert: '0',
      user_defined_dpi: '300',
    });
    console.log('[OCR] fast worker 就绪 (PSM3+无字典)');
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

    // 最多 2 个变体：JPEG q90 + sharpen + 高度限制
    const variants = [];
    const w1 = Math.min(maxDim > 2500 ? 1000 : 800, meta.width);
    variants.push({ w: w1, s: 1.3, name: `w${w1}` });
    if (maxDim > 2500) {
      variants.push({ w: 1500, s: 1.8, name: 'w1500_s1.8' });
    }

    let bestText = '';
    for (const v of variants) {
      const buf = await sharp(imageBuffer)
        .resize({ width: v.w, height: 1500, fit: 'inside', withoutEnlargement: true })
        .grayscale()
        .normalize()
        .linear(v.s, -20)
        .sharpen()
        .jpeg({ quality: 90 })
        .toBuffer();
      const r = await worker.recognize(buf);
      const text = r.data.text;
      const phoneMatch = text.match(PHONE_REGEX);
      console.log(`[OCR] ${v.name}: phone=${phoneMatch ? phoneMatch[1] : '(无)'}`);
      if (phoneMatch) {
        return res.json({ text, phone: phoneMatch[1], hasPhone: true, stage: 'fast' });
      }
      if (text.length > bestText.length) bestText = text;
    }

    return res.json({ text: bestText, phone: null, hasPhone: false, stage: 'fast' });
  } catch (e) {
    console.error('[OCR] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
