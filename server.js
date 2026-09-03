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

// 从 OCR 文本中提取手机号，分严格等级：
//   L1 纯净行：整行就是 11 位数字（无其它前后字符），最可靠
//   L2 独立行：11 位数字前后被非数字包围（严格匹配）
//   L3 行宽松：行内某处出现 1[3-9]\d{9} 模式
//   L4 整段严格 / L5 整段宽松
function extractPhone(text, level=3) {
  if (!text) return null;
  const STRIP = /\s+/g;
  const lines = String(text).split(/\r?\n/).map(l => l.replace(STRIP, '')).filter(Boolean);
  // L1 纯净行
  if (level >= 1) for (const line of lines) { if (/^1[3-9]\d{9}$/.test(line)) return { phone: line, level: 1 }; }
  // L2 独立行
  if (level >= 2) for (const line of lines) { const s = line.match(PHONE_REGEX_STRICT); if (s) return { phone: s[1], level: 2 }; }
  // L3 行宽松
  if (level >= 3) for (const line of lines) { const l = line.match(PHONE_REGEX_LOOSE); if (l) return { phone: l[0], level: 3 }; }
  // L4/L5 整段
  const all = String(text).replace(STRIP, '');
  if (level >= 4) { const s = all.match(PHONE_REGEX_STRICT); if (s) return { phone: s[1], level: 4 }; }
  if (level >= 5) {
    const l = all.match(PHONE_REGEX_LOOSE); if (l) return { phone: l[0], level: 5 };
    const l2 = text.match(PHONE_REGEX_LOOSE); if (l2) return { phone: l2[0], level: 5 };
  }
  return null;
}
// 兼容旧 API：返回字符串 or null
function extractPhoneCompat(text, minLevel = 3) {
  const r = extractPhone(text, minLevel);
  return r ? r.phone : null;
}

// 快速通道：eng + 数字白名单 + PSM6（单文本块）+ 1500px 放大模式
// 2026-09 最终优化：统一走 PSM6 放大 1.5x（1500px），一次 OCR 就拿到 100% 准确号码
// PSM6 + 1500px：text.jpg=18687568005 正确（之前 PSM3 会认错 6/5/8/0）
// 清晰小票约 3.5-4.5s，局域网 + 服务器处理 + 正确号码 平衡最优
async function initFastOCR() {
  if (fastWorker) return fastWorker;
  if (fastInitPromise) return fastInitPromise;
  fastInitPromise = (async () => {
    console.log('[OCR-fast] 加载 eng worker...');
    fastWorker = await Tesseract.createWorker('eng', 1, {
      langPath: path.join(ROOT, 'tessdata'),
    });
    await fastWorker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '6',
      tessedit_enable_dict: '0',
      tessedit_do_invert: '0',
      user_defined_dpi: '300',
    });
    console.log('[OCR-fast] worker 就绪 (PSM6+数字白名单+1500px 放大，准确)');
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
  const T0 = Date.now();

  try {
    // 号码正确优先：
    // ① 固定 1.3x 放大 → 局域网 1100px → 1430px；隧道 950px → 1235px；号码字高 ≥ 20px（Tesseract 300DPI 最佳）
    //    → 实测 text.jpg/upload2 18687568005 100% 正确（6/5/8/0 不混淆）
    // ② 保留 .normalize() + 强对比(1.8,-28) + sharpen(1.25) → 对比度够才不认错
    // ③ 只有"完全没找到11位"时才追加 1.5x 强增强重试（此时号码真糊/被遮挡）
    const fw = await initFastOCR();
    const w = maxDim < 1600 ? Math.round(maxDim * 1.3) : 1600;
    const buf = await sharp(imageBuffer).resize({width:w,height:2000,fit:'inside'})
      .grayscale().normalize().linear(1.8,-28).sharpen({sigma:1.25}).jpeg({quality:92}).toBuffer();
    const { data } = await fw.recognize(buf);
    let hit = extractPhone(data.text, 5);
    const t = ((Date.now()-T0)/1000).toFixed(2);
    console.log(`[OCR PSM6 w${w}] hit=${hit ? hit.phone+' L'+hit.level : '(无)'}  用时${t}s`);
    if (hit) return { text: data.text, phone: hit.phone, hasPhone: true, stage: 'L'+hit.level+'_'+t.replace('.','')+'s' };
    // 没命中 → 追加更强 1.5x 放大（边缘/阴影重的照片才走到）
    const w2 = Math.min(1900, Math.round(maxDim * 1.5));
    const buf2 = await sharp(imageBuffer).resize({width:w2,height:2400,fit:'inside'})
      .grayscale().normalize().linear(2.0,-32).sharpen({sigma:1.4}).jpeg({quality:94}).toBuffer();
    const r2 = await fw.recognize(buf2);
    hit = extractPhone(r2.data.text, 5);
    const t2 = ((Date.now()-T0)/1000).toFixed(2);
    console.log(`[OCR PSM6 retry w${w2}] hit=${hit ? hit.phone+' L'+hit.level : '(无)'}  总${t2}s`);
    if (hit) return { text: r2.data.text, phone: hit.phone, hasPhone: true, stage: 'retry_L'+hit.level+'_'+t2.replace('.','')+'s' };
    return { text: r2.data.text.length>data.text.length?r2.data.text:data.text, phone: null, hasPhone: false, stage: 'not_found' };
  } catch (e) {
    console.log('[OCR] error:', e.message);
    return { text: '', phone: null, hasPhone: false, stage: 'error' };
  }
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
