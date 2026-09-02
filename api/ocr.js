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

// 严格匹配：11位手机号前后为非数字
const PHONE_REGEX_STRICT = /(?:^|[^\d])(1[3-9]\d{9})(?:[^\d]|$)/;
// 宽松匹配：从长数字串中提取有效手机号段
const PHONE_REGEX_LOOSE = /1[3-9]\d{9}/;

function extractPhone(text) {
  if (!text) return null;
  const strict = text.match(PHONE_REGEX_STRICT);
  if (strict) return strict[1];
  const loose = text.match(PHONE_REGEX_LOOSE);
  if (loose) return loose[0];
  return null;
}

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
    let imageBuffer;
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      // FormData: 提取 image/file 字段二进制
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
      // JSON base64 格式（兼容旧版）
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const b64 = (body.image || body.data || '').replace(/^data:image\/[^;]+;base64,/, '');
      imageBuffer = Buffer.from(b64, 'base64');
    }

    if (!imageBuffer || imageBuffer.length < 100) return res.status(400).json({ error: '图片数据无效' });

    const worker = await getWorker();
    const meta = await sharp(imageBuffer).metadata();

    // 单变体极速模式（客户端已压缩到1000px内）
    const buf = await sharp(imageBuffer)
      .resize({ width: Math.min(1000, meta.width), height: 1200, fit: 'inside', withoutEnlargement: true })
      .grayscale().normalize().linear(1.4, -15).sharpen().jpeg({ quality: 88 }).toBuffer();
    const r = await worker.recognize(buf);
    const text = r.data.text;
    const phone = extractPhone(text);
    console.log(`[OCR] w1000: phone=${phone || '(无)'}`);
    if (phone) return res.json({ text, phone, hasPhone: true, stage: 'fast' });

    // 未命中 → 试强对比度变体（仅当识别字符少时追加一次）
    if (text.replace(/\s/g, '').length < 30) {
      const buf2 = await sharp(imageBuffer)
        .resize({ width: Math.min(1300, meta.width), height: 1500, fit: 'inside', withoutEnlargement: true })
        .grayscale().normalize().linear(1.8, -20).sharpen().jpeg({ quality: 88 }).toBuffer();
      const r2 = await worker.recognize(buf2);
      const phone2 = extractPhone(r2.data.text);
      console.log(`[OCR] w1300_s1.8: phone=${phone2 || '(无)'}`);
      if (phone2) return res.json({ text: r2.data.text, phone: phone2, hasPhone: true, stage: 'fast-v2' });
    }

    return res.json({ text, phone: null, hasPhone: false, stage: 'fast' });
  } catch (e) {
    console.error('[OCR] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
