/* 简单的 Node.js 静态文件服务器 + OCR API
 * 启动命令：node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

// OCR 双通道懒加载
// 1. fastWorker: eng + 数字白名单 → 仅识别数字，速度快 5-10 倍
// 2. fullWorker: chi_sim+eng → 完整文字识别，用于兜底
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
let fastWorker = null;
let fullWorker = null;
let fastInitPromise = null;
let fullInitPromise = null;

// 严格匹配：11位手机号前后为非数字（避免从订单号中截取）
const PHONE_REGEX_STRICT = /(?:^|[^\d])(1[3-9]\d{9})(?:[^\d]|$)/;
// 宽松匹配：从长数字串中提取有效手机号段（OCR 误读前缀字符为数字时兜底）
const PHONE_REGEX_LOOSE = /1[3-9]\d{9}/;

// 从 OCR 文本中提取手机号（先严格后宽松）
function extractPhone(text) {
  if (!text) return null;
  const strict = text.match(PHONE_REGEX_STRICT);
  if (strict) return strict[1];
  const loose = text.match(PHONE_REGEX_LOOSE);
  if (loose) return loose[0];
  return null;
}

// 快速通道：eng + 数字白名单 + PSM6 + 禁用字典（速度提升 3-5 倍）
async function initFastOCR() {
  if (fastWorker) return fastWorker;
  if (fastInitPromise) return fastInitPromise;
  fastInitPromise = (async () => {
    console.log('[OCR-fast] 加载 eng worker...');
    fastWorker = await Tesseract.createWorker('eng', 1, {
      langPath: path.join(ROOT, 'tessdata'),
      logger: m => { if (m.status === 'recognizing text') console.log('[OCR-fast]', Math.round(m.progress*100)+'%'); }
    });
    await fastWorker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '3',    // PSM3: 全自动版面分析（适合复杂小票）
      tessedit_enable_dict: '0',      // 禁用字典查找（仅需数字）
      tessedit_do_invert: '0',       // 跳过反转检查
      user_defined_dpi: '300',       // 设置 DPI 提升识别精度
    });
    console.log('[OCR-fast] fast worker 就绪 (PSM3+无字典)');
    return fastWorker;
  })();
  return fastInitPromise;
}

// 完整通道：chi_sim+eng（兜底）
async function initFullOCR() {
  if (fullWorker) return fullWorker;
  if (fullInitPromise) return fullInitPromise;
  fullInitPromise = (async () => {
    console.log('[OCR-full] 加载 chi_sim+eng worker...');
    fullWorker = await Tesseract.createWorker('chi_sim+eng', 3, {
      langPath: path.join(ROOT, 'tessdata'),
      logger: m => { if (m.status === 'recognizing text') console.log('[OCR-full]', Math.round(m.progress*100)+'%'); }
    });
    console.log('[OCR-full] full worker 就绪');
    return fullWorker;
  })();
  return fullInitPromise;
}

async function doOCR(imageBuffer) {
  const meta = await sharp(imageBuffer).metadata();
  const maxDim = Math.max(meta.width, meta.height);
  console.log(`[OCR] 图片 ${meta.width}×${meta.height} ${(imageBuffer.length/1024).toFixed(0)}KB`);

  // ========== 快速通道：单变体极速模式 ==========
  // eng + 数字白名单 + PSM3 + 禁用字典 + 单变体（客户端已压缩到1000px内，不再需要第2变体）
  try {
    const fw = await initFastOCR();
    const w = Math.min(1000, meta.width);
    const buf = await sharp(imageBuffer)
      .resize({ width: w, height: 1200, fit: 'inside', withoutEnlargement: true })
      .grayscale().normalize().linear(1.4, -15).sharpen().jpeg({ quality: 88 }).toBuffer();
    const r = await fw.recognize(buf);
    const text = r.data.text;
    const phone = extractPhone(text);
    console.log(`[OCR-fast] w${w}: phone=${phone || '(无)'}`);
    if (phone) return { text, phone, hasPhone: true, stage: 'fast' };
    // 未命中 → 试更强对比度变体（仅当识别字符少时追加一次）
    if (text.replace(/\s/g, '').length < 30) {
      const buf2 = await sharp(imageBuffer)
        .resize({ width: Math.min(1300, meta.width), height: 1500, fit: 'inside', withoutEnlargement: true })
        .grayscale().normalize().linear(1.8, -20).sharpen().jpeg({ quality: 88 }).toBuffer();
      const r2 = await fw.recognize(buf2);
      const phone2 = extractPhone(r2.data.text);
      console.log(`[OCR-fast] w1300_s1.8: phone=${phone2 || '(无)'}`);
      if (phone2) return { text: r2.data.text, phone: phone2, hasPhone: true, stage: 'fast-v2' };
      if (r2.data.text.length > text.length) return { text: r2.data.text, phone: null, hasPhone: false, stage: 'fast' };
    }
    return { text, phone: null, hasPhone: false, stage: 'fast' };
  } catch (e) {
    console.log('[OCR-fast] error:', e.message);
  }

  // ========== 兜底通道：chi_sim+eng（极少进入） ==========
  try {
    const worker = await initFullOCR();
    const buf = await sharp(imageBuffer)
      .resize({ width: Math.min(1200, meta.width), height: 1500, fit: 'inside', withoutEnlargement: true })
      .grayscale().normalize().linear(1.5, -20).sharpen().jpeg({ quality: 88 }).toBuffer();
    const r = await worker.recognize(buf);
    const text = r.data.text;
    const phone = extractPhone(text);
    console.log(`[OCR-full] w1200: phone=${phone ? 'FOUND' : '-'}`);
    return { text, phone, hasPhone: !!phone, stage: 'full' };
  } catch (e) {
    console.log('[OCR-full] error:', e.message);
  }

  return { text: bestText, phone: bestPhone, hasPhone: !!bestPhone, stage: 'full' };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain; charset=utf-8',
  '.gz':   'application/gzip',
  '.wasm': 'application/wasm',
  '.map':  'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    const parsedUrl = url.parse(req.url);
    let pathname = decodeURIComponent(parsedUrl.pathname);
    
    // ===== OCR API =====
    if (pathname === '/api/ocr' && req.method === 'POST') {
      handleOCR(req, res);
      return;
    }
    
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.join(ROOT, pathname);

    // 防止路径穿越
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found: ' + pathname);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      // tessdata 语言包 + vendor tesseract-core 运行时：同源静态资源，强制缓存 7 天
      // （模拟生产环境，验证"不重复下载"效果）
      // 其他资源（开发代码）：no-cache 方便立即看到代码修改
      const cacheCtrl = (pathname.startsWith('/tessdata/') || pathname.startsWith('/vendor/'))
        ? 'public, max-age=604800, immutable'
        : 'no-cache';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cacheCtrl,
      });
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (e) {
    res.writeHead(500);
    res.end('Server Error: ' + e.message);
  }
});

// ===== OCR API Handler =====
function handleOCR(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  
  // 读取请求体（支持 base64 JSON 或 multipart）
  const chunks = [];
  let totalLen = 0;
  req.on('data', chunk => {
    chunks.push(chunk);
    totalLen += chunk.length;
    if (totalLen > 10 * 1024 * 1024) { // 限制 10MB
      res.writeHead(413); res.end(JSON.stringify({error: '图片太大，请压缩后再试'}));
      req.destroy();
    }
  });
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks);
      let imageBuffer = null;
      
      const contentType = req.headers['content-type'] || '';
      
      if (contentType.includes('application/json')) {
        // JSON 格式：{ "image": "data:image/png;base64,xxxxx" } 或 { "image": "<base64>" }
        const json = JSON.parse(body.toString());
        let b64 = json.image || json.data || '';
        // 去掉 data:image/xxx;base64, 前缀
        const commaIdx = b64.indexOf(',');
        if (commaIdx >= 0) b64 = b64.slice(commaIdx + 1);
        imageBuffer = Buffer.from(b64, 'base64');
      } else if (contentType.includes('multipart/form-data')) {
        // 解析 multipart/form-data（FormData 二进制上传，体积比 base64 小 33%）
        let boundary = contentType.split('boundary=')[1] || '';
        boundary = boundary.trim().replace(/^"/, '').replace(/"$/, '');
        if (boundary) {
          // 手动 indexOf 切分 parts（兼容所有 Node 版本）
          const sep = Buffer.from('--' + boundary);
          const parts = [];
          let pos = 0;
          while (true) {
            const idx = body.indexOf(sep, pos);
            if (idx < 0) break;
            const nextIdx = body.indexOf(sep, idx + sep.length);
            if (nextIdx >= 0) {
              parts.push(body.slice(idx + sep.length, nextIdx));
              pos = nextIdx;
            } else break;
          }
          for (const part of parts) {
            if (part.includes(Buffer.from('name="file"')) || part.includes(Buffer.from('name="image"'))) {
              const idx = part.indexOf(Buffer.from('\r\n\r\n'));
              if (idx >= 0) {
                // 去掉尾部 \r\n
                let endIdx = part.length - 1;
                while (endIdx > idx + 4 && (part[endIdx] === 10 || part[endIdx] === 13)) endIdx--;
                imageBuffer = part.slice(idx + 4, endIdx + 1);
                break;
              }
            }
          }
        }
      } else {
        // 直接就是二进制图片数据
        imageBuffer = body;
      }
      
      if (!imageBuffer || imageBuffer.length < 100) {
        res.writeHead(400); res.end(JSON.stringify({error: '没收到图片'}));
        return;
      }
      
      console.log(`[OCR] 收到图片 ${(imageBuffer.length/1024).toFixed(1)}KB`);
      const result = await doOCR(imageBuffer);
      console.log(`[OCR] 结果: phone=${result.phone||'(无)'}`);
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[OCR] ERROR:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({error: 'OCR 处理失败: ' + e.message}));
    }
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('============================');
  console.log('静态预览服务已启动');
  console.log('  主页:   http://localhost:' + PORT + '/');
  console.log('  配置页: http://localhost:' + PORT + '/config.html');
  console.log('  目录:   ' + ROOT);
  console.log('按 Ctrl+C 停止服务');
  console.log('============================');
});
