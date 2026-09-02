/**
 * 打包脚本：将前端静态资源 + OCR 服务复制到 dist/ 目录
 * 发布时直接把 dist/ 上传到任意支持 Node.js 的服务器即可
 * 部署后运行：node server.js 启动服务
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const FILES_TO_COPY = [
    'index.html',
    'config.html',
    'css/style.css',
    'js/app.js',
    'js/config.js',
    'server.js',
    'package.json'
];

/* tessdata/ 目录存放 Tesseract.js 本地语言包（chi_sim.traineddata.gz / eng.traineddata.gz）
   —— 随项目一起部署 → 同源缓存 7 天，再也不用从远端 CDN 重复下载 */
const TESSDATA_SRC_REL = 'tessdata';

/* vendor/ 目录存放 Tesseract.js-core 运行时（wasm/core.js/asm.js + worker.min.js）
   —— 全部本地化，彻底断 unpkg/jsdelivr CDN 依赖，解决国内网络/WebAssembly CORS 加载失败 */
const VENDOR_SRC_REL = 'vendor';

function removeDirRecursive(target) {
    if (!fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
        for (const child of fs.readdirSync(target)) {
            removeDirRecursive(path.join(target, child));
        }
        fs.rmdirSync(target);
    } else {
        fs.unlinkSync(target);
    }
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyFile(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    const srcSize = fs.statSync(src).size;
    const rel = path.relative(ROOT, dest);
    console.log(`  ✅ ${rel}    (${(srcSize / 1024).toFixed(2)} KB)`);
    return srcSize;
}

// ---------- 执行 ----------
console.log('\n📦 开始打包发布文件到 dist/ ...\n');

// 1. 清空旧的 dist 目录
if (fs.existsSync(DIST)) {
    removeDirRecursive(DIST);
    console.log('  🧹 已删除旧 dist/ 目录\n');
}
ensureDir(DIST);

// 2. 复制静态资源
let totalSize = 0;
let totalFiles = 0;
const startAt = Date.now();

for (const rel of FILES_TO_COPY) {
    const src = path.join(ROOT, rel);
    const dest = path.join(DIST, rel);
    if (!fs.existsSync(src)) {
        console.log(`  ❌ ${rel}    文件缺失，跳过`);
        continue;
    }
    totalSize += copyFile(src, dest);
    totalFiles++;
}

// 2.5 复制 tessdata 语言包目录（如果存在）→ dist/tessdata/
const tessSrc = path.join(ROOT, TESSDATA_SRC_REL);
const tessDest = path.join(DIST, TESSDATA_SRC_REL);
if (fs.existsSync(tessSrc) && fs.statSync(tessSrc).isDirectory()) {
    const tessFiles = fs.readdirSync(tessSrc).filter(f => f.endsWith('.traineddata.gz'));
    if (tessFiles.length > 0) {
        console.log(`\n  🧩 复制 Tesseract 本地语言包 (${tessFiles.length} 个) → dist/${TESSDATA_SRC_REL}/`);
        ensureDir(tessDest);
        for (const fn of tessFiles) {
            totalSize += copyFile(path.join(tessSrc, fn), path.join(tessDest, fn));
            totalFiles++;
        }
    }
}

// 2.6 复制 vendor tesseract-core 运行时目录（如果存在）→ dist/vendor/
const vendorSrc = path.join(ROOT, VENDOR_SRC_REL);
const vendorDest = path.join(DIST, VENDOR_SRC_REL);
if (fs.existsSync(vendorSrc) && fs.statSync(vendorSrc).isDirectory()) {
    const vendorFiles = fs.readdirSync(vendorSrc).filter(f =>
        f.endsWith('.wasm') || f.endsWith('.js') || f.endsWith('.asm.js')
    );
    if (vendorFiles.length > 0) {
        console.log(`\n  ⚙️  复制 Tesseract.js-core 运行时 (${vendorFiles.length} 个) → dist/${VENDOR_SRC_REL}/`);
        ensureDir(vendorDest);
        for (const fn of vendorFiles) {
            totalSize += copyFile(path.join(vendorSrc, fn), path.join(vendorDest, fn));
            totalFiles++;
        }
    }
}

const duration = ((Date.now() - startAt) / 1000).toFixed(2);

// 3. 输出结果
console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log(`✅ 打包完成！共复制 ${totalFiles} 个文件`);
console.log(`   📂 输出目录：${DIST}`);
console.log(`   💾 总大小：${(totalSize / 1024).toFixed(2)} KB`);
console.log(`   ⏱ 耗时：${duration} 秒`);
console.log('═══════════════════════════════════════════════════════');
console.log('');
console.log('💡 部署方式（dist/ 含 Node.js OCR 服务）：');
console.log('  ① VPS / 云服务器：上传 dist/ 全部文件，运行 node server.js 启动（需 npm install）');
console.log('  ② Vercel：静态资源自动 CDN，OCR 服务需配合 Serverless Functions');
console.log('  ③ Nginx 反代：静态文件由 Nginx 提供，/api/ocr 反代到 Node.js 服务');
console.log('  ④ 局域网测试：cd dist && npm install && node server.js，访问 http://本机IP:8080');
console.log('  ⑤ Docker：将 dist/ 复制到镜像，EXPOSE 8080，CMD ["node","server.js"]');
console.log('');
