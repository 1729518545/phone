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

const PHONE_REGEX = /(?:^|[^\d])(1\d{10})(?:[^\d]|$)/;

// 快速通道：eng + 数字白名单
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
    });
    console.log('[OCR-fast] fast worker 就绪');
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

  // ========== 第一阶段：快速通道 ==========
  // eng + 数字白名单 → 仅识别数字，速度快 5-10 倍
  // 尝试多种尺寸：小图用 1000px，大图用 2000px + 强对比度
  try {
    const fw = await initFastOCR();
    const fastVariants = [];
    // 变体1：1000px 灰度（适合小图和快速扫描）
    fastVariants.push({
      name: 'fast_1000',
      buf: await sharp(imageBuffer).resize({ width: Math.min(1000, meta.width) })
        .grayscale().linear(1.5, -20).jpeg({ quality: 100 }).toBuffer()
    });
    // 变体2：1500px + s1.5（适合大图，与完整通道 gray 变体参数一致）
    if (maxDim > 2500) {
      fastVariants.push({
        name: 'fast_1500',
        buf: await sharp(imageBuffer).resize({ width: 1500 })
          .grayscale().linear(1.5, -20).jpeg({ quality: 100 }).toBuffer()
      });
      // 变体3：2000px + s1.8（适合大图，用已验证的强对比度参数）
      fastVariants.push({
        name: 'fast_2000_s1.8',
        buf: await sharp(imageBuffer).resize({ width: 2000 })
          .grayscale().linear(1.8, -20).jpeg({ quality: 100 }).toBuffer()
      });
    }
    for (const v of fastVariants) {
      const r = await fw.recognize(v.buf);
      const text = r.data.text;
      const phoneMatch = text.match(PHONE_REGEX);
      console.log(`[OCR-fast] ${v.name}: phone=${phoneMatch ? phoneMatch[1] : '(无)'}`);
      if (phoneMatch) {
        return { text, phone: phoneMatch[1], hasPhone: true, stage: 'fast' };
      }
    }
  } catch (e) {
    console.log('[OCR-fast] error:', e.message);
  }

  // ========== 第二阶段：完整通道（兜底） ==========
  // chi_sim+eng + 多变体预处理，针对快速通道无法识别的图片
  const worker = await initFullOCR();
  const targetW = maxDim > 2500 ? 1500 : meta.width;

  const variants = [];
  if (maxDim > 2500) {
    variants.push({ name: 'resize1500', buf: await sharp(imageBuffer).resize({ width: 1500 }).jpeg({ quality: 100 }).toBuffer() });
  } else {
    variants.push({ name: 'orig', buf: imageBuffer });
  }
  variants.push({
    name: 'gray',
    buf: await sharp(imageBuffer).resize({ width: targetW }).grayscale().linear(1.5, -20).jpeg({ quality: 100 }).toBuffer()
  });
  if (maxDim <= 2500) {
    variants.push({
      name: 'scale1.5',
      buf: await sharp(imageBuffer).resize({ width: Math.round(meta.width * 1.5) }).grayscale().linear(1.3, -10).jpeg({ quality: 100 }).toBuffer()
    });
  }
  if (maxDim > 2500) {
    variants.push({
      name: 'gray_w2000_s1.8',
      buf: await sharp(imageBuffer).resize({ width: 2000 }).grayscale().linear(1.8, -20).jpeg({ quality: 100 }).toBuffer()
    });
    variants.push({
      name: 'gray_w2000_s2.0',
      buf: await sharp(imageBuffer).resize({ width: 2000 }).grayscale().linear(2.0, -20).jpeg({ quality: 100 }).toBuffer()
    });
  }

  let bestText = '';
  let bestPhone = null;

  for (let i = 0; i < variants.length; i++) {
    try {
      const r = await worker.recognize(variants[i].buf);
      const text = r.data.text;
      const phoneMatch = text.match(PHONE_REGEX);
      const phone = phoneMatch ? phoneMatch[1] : null;
      console.log(`[OCR-full] ${variants[i].name}: phone=${phone ? 'FOUND' : '-'}`);

      if (phone) {
        bestPhone = phone;
        bestText = text;
        break;
      }
      if (text.length > bestText.length) bestText = text;
    } catch (e) {
      console.log(`[OCR-full] ${variants[i].name} error:`, e.message);
    }
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
        // 简单 multipart 处理（提取 base64 块）
        const boundary = contentType.split('boundary=')[1];
        if (boundary) {
          const parts = body.split(Buffer.from('--' + boundary));
          for (const part of parts) {
            if (part.includes(Buffer.from('Content-Disposition: form-data; name="file"')) ||
                part.includes(Buffer.from('Content-Disposition: form-data; name="image"'))) {
              // 找到两个 \r\n\r\n 之间的内容
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
