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
      tessedit_pageseg_mode: '4',    // PSM4: 单列文本（小票最佳，比PSM3快）
      tessedit_enable_dict: '0',
      tessedit_do_invert: '0',
      user_defined_dpi: '300',
    });
    console.log('[OCR-fast] fast worker 就绪 (PSM4+无字典)');
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

  // ========== 快速通道：单变体，无兜底（3s 内完成）==========
  // eng + 数字白名单 + PSM4 + 禁用字典 → 仅识别数字
  // 客户端已压缩到 1200px，服务端仅在图片过大时缩小
  try {
    const fw = await initFastOCR();
    // 客户端已压缩到 1200px，图片不大时直接处理（省去 resize 时间）
    let procBuf;
    if (maxDim <= 1200) {
      // 已压缩，仅灰度+对比度增强
      procBuf = await sharp(imageBuffer)
        .grayscale().normalize().linear(1.4, -15).jpeg({ quality: 90 }).toBuffer();
      console.log(`[OCR-fast] direct (无resize)`);
    } else {
      // 原图过大，缩小到 1000px
      procBuf = await sharp(imageBuffer).resize({ width: 1000, height: 1200, fit: 'inside', withoutEnlargement: true })
        .grayscale().normalize().linear(1.4, -15).jpeg({ quality: 90 }).toBuffer();
      console.log(`[OCR-fast] resize to 1000px`);
    }
    const r = await fw.recognize(procBuf);
    const text = r.data.text;
    const phoneMatch = text.match(PHONE_REGEX);
    console.log(`[OCR-fast] phone=${phoneMatch ? phoneMatch[1] : '(无)'}`);
    if (phoneMatch) {
      return { text, phone: phoneMatch[1], hasPhone: true, stage: 'fast' };
    }
    // 快速通道未命中，返回原始文字
    return { text, phone: null, hasPhone: false, stage: 'fast' };
  } catch (e) {
    console.log('[OCR-fast] error:', e.message);
  }

  return { text: '', phone: null, hasPhone: false, stage: 'error' };
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
