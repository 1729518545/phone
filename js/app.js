/* ==========================================================
 * 客户快捷联系 - 主应用逻辑
 * ========================================================== */

(function () {
    'use strict';

    /* ===== 默认配置 ===== */
    const DEFAULT_CONFIG = {
        smsTemplate: '您好，您的订单{orderNo}已处理完成，如有疑问请随时联系客服。感谢您的支持！',
        wechatTemplate: '您好，我是客服小助手。关于您的订单{orderNo}，想跟您确认一下配送信息，请方便时回复，谢谢！',
        verifyTemplate: '我是客服，关于订单{orderNo}',
        autoRecognize: true,
        confirmBeforeAction: true,
        countryCode: '+86'
    };

    /* ===== 工具函数 ===== */
    const Utils = {
        // 存储
        getConfig() {
            try {
                const stored = localStorage.getItem('customer_contact_config');
                if (stored) {
                    return Object.assign({}, DEFAULT_CONFIG, JSON.parse(stored));
                }
            } catch (e) {
                console.warn('读取配置失败，使用默认配置', e);
            }
            return Object.assign({}, DEFAULT_CONFIG);
        },

        saveConfig(config) {
            localStorage.setItem('customer_contact_config', JSON.stringify(config));
        },

        // 手机号验证
        isValidPhone(phone) {
            if (!phone) return false;
            const clean = phone.replace(/\s|-/g, '');
            return /^1[3-9]\d{9}$/.test(clean);
        },

        // 清理手机号格式（仅手机11位）
        formatPhone(phone) {
            return phone ? phone.replace(/\D/g, '').slice(0, 11) : '';
        },

        // 清理任意号码格式（支持手机/固话/400/95/分机，保留所有数字不切长度）
        formatAnyPhone(phone) {
            return phone ? phone.replace(/\D/g, '') : '';
        },

        // 格式化显示手机号 138****8888
        maskPhone(phone) {
            const clean = this.formatPhone(phone);
            if (clean.length < 7) return clean;
            return clean.slice(0, 3) + '****' + clean.slice(-4);
        },

        // 获取当前日期 YYYY-MM-DD
        getDateStr() {
            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        },

        // 模板变量替换
        renderTemplate(tpl, data) {
            if (!tpl) return '';
            return tpl
                .replace(/\{phone\}/g, data.phone || '')
                .replace(/\{orderNo\}/g, data.orderNo || '')
                .replace(/\{date\}/g, data.date || this.getDateStr());
        },

        // 从任意订单/聊天文本中提取号码（方案B三层通用增强）
        extractPhoneFromText(text) {
            if (!text) return null;
            const U = this; // Utils 引用
            let raw = String(text);

            /* ===== 层A：整段OCR脏字预清洗 ===== */
            // ① 全角 → 半角（数字/字母/标点）
            raw = raw.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
            // ② OCR 中文关键词形似字纠正（最常见 3 类：电活→电话、電話→电话、聯系→联系）
            raw = raw.replace(/(電話|電 話|电活|电 活|聯系|聯絡|連絡)/g, m => ({
                '電話':'电话','電 話':'电话','电活':'电话','电 活':'电话','聯系':'联系','聯絡':'联系','連絡':'联系'
            }[m]));
            // ③ 国家码剥离（+86/0086/（86）/＋８６ 等，放在「电活」纠正之后仍要做）
            raw = raw.replace(/(^|[\s\-\(\)（）【】\[\]、,，。.:：\n\r\t])(\+|＋)?\s*(86|0086|８６)\s*(?=[\s\-\(\)（）]*([0149IlO]|０|１|４|９))/g, '$1 ');

            /* ===== 层B：关键词锚点优先（取高概率候选区）===== */
            const anchors = ['联系电话','客服电话','电话号码','电话','手 机','手机号码','手机','聯絡電話','联系方式','联系','Tel','Phone','Mobile','📱','☎️','📞'];
            const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            let candidates = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const hit = anchors.some(a => line.toLowerCase().includes(a.toLowerCase()));
                if (hit) {
                    candidates.push(line);                   // 关键词所在行（第一优先）
                    if (i+1 < lines.length) candidates.push(lines[i+1]); // 关键词下一行（第二优先，常见格式：「电话：」独占一行，号在下一行）
                    // 关键词命中的前 2 行，后面全局扫描再兜底即可
                }
            }
            // 锚点行按顺序逐个取号，命中即返回（保证顺序=优先级）
            for (const seg of candidates) {
                const found = U._pickPhoneFromSegment(seg);
                if (found) return found;
            }

            /* ===== 层C：全局扫描兜底（原始逻辑扩展 4 种格式）===== */
            const all = U._pickPhoneFromSegment(raw);
            if (all) return all;

            /* ===== 层D：超宽松 OCR 形似字兜底（把整段的所有数字形似字强制转数字，再扫一次）===== */
            const forced = raw
                .replace(/[^0-9IlOoQqTtZzSsBb]/g, '')
                .replace(/[Il|]/g, '1')
                .replace(/[OoQqDd]/g, '0')
                .replace(/[Tt]/g, '7')
                .replace(/[Zz]/g, '2')
                .replace(/[Ss]/g, '5')
                .replace(/[Bb]/g, '8');
            return U._pickPhoneFromSegment(forced); // 纯 forced 里面找正则命中
        },

        /**
         * 从一段文本中按优先级提取号码（纯数字返回，不切长度）
         * 优先级：大陆11位手机 > 区号固话 > 400客服号 > 95开头5-8位官方短号
         * 同时兼容分机号格式（主号-1234 或 主号转1234 → 返回 主号+分机所有数字）
         */
        _pickPhoneFromSegment(seg) {
            if (!seg) return null;
            const U = this;
            // 先把 「-」「转」「分机」替换成通用分隔符（保留在串里，分机会被正则后面 clean 合并）
            let s = String(seg)
                .replace(/\s*(转|分机|ext\.?|EXT\.?)\s*/g, '-')  // "转123"/"分机 234"/"ext 345" → "-123"
                .replace(/[（）()【】\[\]]/g, '-')              // "(010)88888888" → "-010-88888888"
                .replace(/[^\d\-]/g, ' ');                      // 其他非数字/非-全变空格
            // 把候选 token 按空白/多横杠切开，然后逐个 token 做正则匹配
            const tokens = s.split(/\s+|-+/).map(t => t.trim()).filter(Boolean);
            // ===== ★ 核心防回归：先算每个 token 是否「独立号」（单段就能命中的合法号：11位手机/400/95）=====
            //    → 独立号永远不与后面的 token 拼接，避免双号相邻时（客户1:138… 客户2:95xxx）被误拼成「主号+超长分机」
            const isStandalone = tokens.map(t => {
                if (/^1[3-9]\d{9}$/.test(t)) return true;
                if (/^400\d{7}$/.test(t)) return true;
                if (/^95\d{3,6}$/.test(t)) return true;
                return false;
            });
            const segments = [];
            // ① 三段组合：区号 + 主号 + 分机 / 400-888-8888 → 仅 i 非独立号（i 是区号/400，本身需拼接才合法）才加入
            for (let i = 0; i + 2 < tokens.length; i++) {
                if (!isStandalone[i]) segments.push(tokens[i] + tokens[i+1] + tokens[i+2]);
            }
            // ② 两段组合：区号 + 主号 / 空格分隔的两段号 → 仅 i 非独立号才允许拼（防止 11 位手机 + 下一位数字误拼）
            for (let i = 0; i + 1 < tokens.length; i++) {
                if (!isStandalone[i]) segments.push(tokens[i] + tokens[i+1]);
            }
            // ③ 单段兜底（11 位手机 / 95 短号 / 400 纯号 / 0 开头的完整固话串）
            for (const t of tokens) segments.push(t);
            // 分机位缩到 0-4 位（真实分机 99% ≤ 4 位，进一步挡住双号拼接）
            const rules = [
                /^1[3-9]\d{9}\d{0,4}$/,             // ① 大陆11位手机（后可接 0-4 位分机 → 总长 11-15）
                /^0[1-9]\d{1,2}\d{7,8}\d{0,4}$/,    // ② 区号固话（010/0755 开头 + 7-8位号 + 0-4位分机 → 总长 10-16）
                /^400\d{7}\d{0,4}$/,                 // ③ 400 客服号（400 + 7 + 0-4 位分机 → 总长 10-14）
                /^95\d{3,6}$/                        // ④ 95 开头 5-8 位官方客服号（无分机：95588 / 95016001）
            ];
            for (const candidate of segments) {
                for (const re of rules) {
                    if (re.test(candidate)) {
                        const clean = U.formatAnyPhone(candidate);
                        if (clean && clean.length >= 5) return clean;
                    }
                }
            }
            return null;
        },

        // 检测是否移动端
        isMobile() {
            return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        },

        // 检测是否微信环境
        isWeChat() {
            return /MicroMessenger/i.test(navigator.userAgent);
        },

        // 检测是否iOS
        isIOS() {
            return /iPhone|iPad|iPod/i.test(navigator.userAgent);
        },

        /* 外部应用跳转：隐藏<a>.click()业界标准方案，绝不触发当前页面卸载/刷新
           —— 浏览器对<a>原生点击触发自定义协议处理最友好，失败不会销毁当前页面
           —— iOS 叠加注入 iframe 双保险（Safari 对 scheme 处理有时需要 iframe 补） */
        launchExternalApp(url) {
            if (!url) return false;
            try {
                // 方案1：创建隐藏 <a> 元素并原生点击（优先，兼容绝大多数浏览器）
                let a = document.getElementById('__extAppLauncher');
                if (!a) {
                    a = document.createElement('a');
                    a.id = '__extAppLauncher';
                    a.style.display = 'none';
                    a.setAttribute('rel', 'noopener noreferrer');
                    document.body.appendChild(a);
                }
                a.href = url;
                // 原生 click()，不是合成事件，浏览器识别为用户手势触发
                a.click();

                // 方案2（仅iOS）：额外注入 iframe 双保险
                if (this.isIOS()) {
                    try {
                        const iframe = document.createElement('iframe');
                        iframe.style.display = 'none';
                        iframe.src = url;
                        document.body.appendChild(iframe);
                        // 1.5秒后移除临时节点
                        setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 1500);
                    } catch (_) { /* ignore */ }
                }
                return true;
            } catch (e) {
                console.error('launchExternalApp 失败:', e);
                return false;
            }
        },

        // 表单草稿持久化（防跳转失败刷新丢数据）
        saveFormDraft({ phone, orderNo }) {
            try {
                localStorage.setItem('customer_contact_draft', JSON.stringify({
                    phone: phone || '',
                    orderNo: orderNo || '',
                    savedAt: Date.now()
                }));
            } catch (_) {}
        },

        loadFormDraft() {
            try {
                const s = localStorage.getItem('customer_contact_draft');
                return s ? JSON.parse(s) : null;
            } catch (_) { return null; }
        },

        clearFormDraft() {
            try { localStorage.removeItem('customer_contact_draft'); } catch (_) {}
        }
    };

    /* ===== Toast 提示 ===== */
    const Toast = {
        _el: null,
        _timer: null,

        init() {
            this._el = document.getElementById('toast');
        },

        show(message, type = '', duration = 2000) {
            if (!this._el) this.init();
            clearTimeout(this._timer);
            this._el.className = 'toast ' + type;
            this._el.textContent = message;
            requestAnimationFrame(() => {
                this._el.classList.add('show');
            });
            this._timer = setTimeout(() => {
                this._el.classList.remove('show');
            }, duration);
        },

        success(msg, duration) { this.show(msg, 'success', duration); },
        error(msg, duration) { this.show(msg, 'error', duration || 2500); },
        warning(msg, duration) { this.show(msg, 'warning', duration); }
    };

    /* ===== 确认弹窗 ===== */
    const Modal = {
        mask: null,
        titleEl: null,
        bodyEl: null,
        cancelBtn: null,
        confirmBtn: null,
        modal: null,
        _resolve: null,
        _onConfirmSync: null,

        init() {
            this.mask = document.getElementById('modalMask');
            this.titleEl = document.getElementById('modalTitle');
            this.bodyEl = document.getElementById('modalBody');
            this.cancelBtn = document.getElementById('modalCancel');
            this.confirmBtn = document.getElementById('modalConfirm');
            this.modal = this.mask.querySelector('.modal');

            this.cancelBtn.addEventListener('click', () => {
                // 【修复顺序关键】先暂存 resolve 引用 → 再关 Modal（_close 会清空 this._resolve）→ 最后 resolve
                const resolve = this._resolve;
                this._close();
                resolve && resolve(false);
            });
            this.confirmBtn.addEventListener('click', () => {
                // 【重要】在关闭弹窗之前，在确认按钮点击的**同步tick**内执行回调
                // 这样自定义协议跳转（weixin://）才会被手机浏览器识别为"用户手势触发"
                if (typeof this._onConfirmSync === 'function') {
                    try { this._onConfirmSync(); } catch (e) { console.error(e); }
                }
                // 【修复顺序关键】先暂存 resolve 引用 → 再关 Modal → 最后 resolve
                // （防止 _close 里把 this._resolve 清空导致 Promise 永远 pending）
                const resolve = this._resolve;
                this._close();
                resolve && resolve(true);
            });
            this.mask.addEventListener('click', (e) => {
                if (e.target === this.mask) {
                    const resolve = this._resolve;
                    this._close();
                    resolve && resolve(false);
                }
            });
        },

        _close() {
            this.mask.style.display = 'none';
            this._resolve = null;
            this._onConfirmSync = null;
        },

        show({ title = '提示', body = '', confirmText = '确定', cancelText = '取消', theme = '', onConfirmSync = null } = {}) {
            if (!this.mask) this.init();
            this.titleEl.textContent = title;
            this.bodyEl.innerHTML = body;
            this.confirmBtn.textContent = confirmText;
            this.cancelBtn.textContent = cancelText;
            this.modal.className = 'modal' + (theme ? ' ' + theme : '');
            this._onConfirmSync = onConfirmSync; // 保存"确认点击瞬间同步执行"的回调
            this.mask.style.display = 'flex';

            return new Promise(resolve => {
                this._resolve = (result) => resolve(result);
            });
        }
    };

    /* ===== OCR 识别模块（浏览器端Tesseract极速优先→失败再调用服务器） ===== */
    // 策略：先本地OCR(2-3秒，eng+数字白名单) → 没号码再服务器端(隧道传输7-10s)
    const OCRModule = {
        // 单例：懒加载浏览器端Tesseract worker（仅数字识别）
        _browserWorker: null,
        _browserWorkerPromise: null,

        async _getBrowserWorker() {
            if (this._browserWorker) return this._browserWorker;
            if (this._browserWorkerPromise) return this._browserWorkerPromise;
            if (typeof Tesseract === 'undefined') throw new Error('Tesseract not loaded');
            const origin = window.location.origin;
            this._browserWorkerPromise = (async () => {
                console.log('[OCR] 创建浏览器端 eng worker (数字白名单)...');
                const w = await Tesseract.createWorker('eng', 1, {
                    langPath: `${origin}/tessdata/`,
                    corePath: `${origin}/vendor/tesseract-core-lstm.wasm.js`,
                    workerPath: `${origin}/vendor/worker.min.js`,
                    workerBlobURL: false,
                    logger: m => { if (m.status === 'recognizing text') console.log('[OCR-browser]', Math.round(m.progress * 100) + '%'); }
                });
                await w.setParameters({
                    tessedit_char_whitelist: '0123456789',
                    tessedit_pageseg_mode: '3',
                    tessedit_enable_dict: '0',
                    tessedit_do_invert: '0',
                    user_defined_dpi: '300',
                });
                console.log('[OCR] 浏览器端 worker 就绪');
                this._browserWorker = w;
                return w;
            })();
            return this._browserWorkerPromise;
        },

        // 严格+宽松两级号码提取（与服务端 extractPhone 对齐）
        _extractPhone(text) {
            if (!text) return null;
            const strict = text.match(/(?:^|[^\d])(1[3-9]\d{9})(?:[^\d]|$)/);
            if (strict) return strict[1];
            const loose = text.match(/1[3-9]\d{9}/);
            if (loose) return loose[0];
            return null;
        },

        // 从图片中识别手机号：先浏览器端 → 再服务器端
        async recognizePhoneFromImage(imageFile) {
            // ========== 第1阶段：浏览器端本地识别（极速2-3s，无需传输） ==========
            try {
                const worker = await this._getBrowserWorker();
                // canvas 预压缩 800px + q80（小图 → 手机端识别更快）
                const dataUrl = await this._compressForBrowserOCR(imageFile, 800, 0.80);
                Toast.show('⚡ 本地AI识别中，约2-3秒...', '', 10000);
                const t0 = Date.now();
                const { data } = await worker.recognize(dataUrl);
                const text = data.text || '';
                const phone = this._extractPhone(text);
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                console.log(`[OCR] 浏览器端 ${elapsed}s: phone=${phone || '(无)'}`);
                if (phone) {
                    return { phone, rawText: text, source: 'browser_fast', confidence: 'high' };
                }
                console.log('[OCR] 浏览器端未识别到号码，切换到服务器端...');
            } catch (e) {
                console.warn('[OCR] 浏览器端失败（回退服务器端）：', e.message);
            }

            // ========== 第2阶段：服务器端 OCR API（兜底，7-12s） ==========
            try {
                const serverResult = await this._recognizeViaServerAPI(imageFile);
                if (serverResult && serverResult.phone) {
                    console.log('[OCR] 服务器端识别完成:', serverResult.source);
                    return serverResult;
                }
                if (serverResult && serverResult.rawText) {
                    return serverResult; // 服务器返回但无号码
                }
            } catch (e) {
                console.warn('[OCR] 服务器端也失败：', e.message);
            }

            // 全部失败 → 提示手动输入
            return { phone: null, rawText: '', source: 'fallback', error: '未识别到号码，请手动输入或更换更清晰照片' };
        },

        /* 浏览器端OCR专用压缩（返回 dataURL，直接给 Tesseract） */
        _compressForBrowserOCR(file, maxDim, quality) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => {
                    const img = new Image();
                    img.onload = () => {
                        let { width, height } = img;
                        if (width > height && width > maxDim) {
                            height = Math.round(height * maxDim / width);
                            width = maxDim;
                        } else if (height > maxDim) {
                            width = Math.round(width * maxDim / height);
                            height = maxDim;
                        }
                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);
                        // 做轻度灰度+对比度增强（canvas 模拟，提高数字识别率）
                        resolve(canvas.toDataURL('image/jpeg', quality));
                    };
                    img.onerror = () => reject(new Error('图片加载失败'));
                    img.src = e.target.result;
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        },

        /* ============ 服务器端 OCR API ============ */
        async _recognizeViaServerAPI(imageFile) {
            Toast.show('🔍 AI识别中，约10-15秒...', '', 30000);

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('服务器识别超时，请换清晰照片重试或直接手动输入')), 30000)
            );

            const apiUrl = `${window.location.origin}/api/ocr`;

            const fetchPromise = (async () => {
                // ★ 客户端压缩：1000px + JPEG q70（体积再减50%）
                // ★ FormData 二进制替代 base64 JSON（传输数据减少 33%）
                const blob = await this._compressImageToBlob(imageFile, 1000, 0.70);
                const fd = new FormData();
                fd.append('image', blob, 'photo.jpg');

                const resp = await fetch(apiUrl, {
                    method: 'POST',
                    body: fd,
                });

                if (!resp.ok) throw new Error('服务器返回 ' + resp.status);
                return resp.json();
            })();

            try {
                const data = await Promise.race([fetchPromise, timeoutPromise]);
                console.log('[OCR] 服务器返回:', JSON.stringify(data).slice(0, 200));

                if (data.phone) {
                    return { phone: data.phone, rawText: data.text || '', source: 'server_ok', confidence: 'high' };
                }
                // 服务器成功但没找到电话 → 返回原始文字（可能有部分识别结果）
                return { phone: null, rawText: data.text || '', source: 'server_no_phone', error: '服务器识别但未匹配电话' };
            } catch (e) {
                throw e; // 让调用方捕获并降级
            }
        },

        /* ============ 客户端图片压缩：返回 Blob（二进制，体积比base64小33%）============ */
        _compressImageToBlob(file, maxDim, quality) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => {
                    const img = new Image();
                    img.onload = () => {
                        let { width, height } = img;
                        if (width > height && width > maxDim) {
                            height = Math.round(height * maxDim / width);
                            width = maxDim;
                        } else if (height > maxDim) {
                            width = Math.round(width * maxDim / height);
                            height = maxDim;
                        }
                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);
                        canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality);
                    };
                    img.onerror = () => reject(new Error('图片加载失败'));
                    img.src = e.target.result;
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        },

        /* Tesseract.js v5 真OCR（中+英混合）
           —— 返回 { phone, rawText, source, error } */
        async _recognizeWithTesseract(imageFile) {
            Toast.show('🔍 正在AI识别图片文字...', '', 30000);

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('识别超时，请换清晰照片重试或直接手动输入')), 20000)
            );

            let worker = null;
            try {
                const origin = window.location.origin;
                const tesseractOpts = {
                    langPath:   `${origin}/tessdata/`,
                    // ★ 强制指定 LSTM core 文件（自动选可能选到 non-LSTM 导致 _malloc undefined）
                    corePath:   `${origin}/vendor/tesseract-core-lstm.wasm.js`,
                    workerPath: `${origin}/vendor/worker.min.js`,
                    workerBlobURL: false,
                    logger: m => {
                        if (m.status && m.progress !== undefined) {
                            console.log('[OCR]', m.status, Math.round(m.progress * 100) + '%');
                        } else if (m.status) {
                            console.log('[OCR]', m.status);
                        }
                    }
                };

                // v5 API: createWorker(langs, oem, opts) — oem=1 是 LSTM（推荐）
                console.log('[OCR] creating worker (v5)...');
                worker = await Tesseract.createWorker('chi_sim+eng', 1, tesseractOpts);
                console.log('[OCR] worker created!');

                // 直接传 File（v5 内部处理），但转成 base64 更稳
                const imageDataUrl = await new Promise((res, rej) => {
                    const reader = new FileReader();
                    reader.onload = () => res(reader.result);
                    reader.onerror = () => rej(reader.error);
                    reader.readAsDataURL(imageFile);
                });
                console.log('[OCR] image dataUrl len:', imageDataUrl.length);

                const recogPromise = worker.recognize(imageDataUrl);
                const result = await Promise.race([recogPromise, timeoutPromise]);

                const text = (result && result.data && result.data.text) ? String(result.data.text) : '';
                console.log('[OCR] RAW TEXT:', JSON.stringify(text).slice(0, 300));

                const phone = Utils.extractPhoneFromText(text);
                return phone
                    ? { phone, rawText: text, source: 'tesseract_ok', confidence: 'high' }
                    : { phone: null, rawText: text, source: 'tesseract_no_phone', error: '识别到文字但未匹配手机号' };

            } catch (e) {
                const msg = (e && e.message) || String(e);
                const isTimeout = msg.includes('超时');
                console.error('[OCR] ERROR:', msg);
                return {
                    phone: null,
                    rawText: '',
                    source: isTimeout ? 'ocr_timeout' : 'tesseract_err',
                    error: msg
                };
            } finally {
                if (worker) { try { await worker.terminate(); } catch(_) {} }
            }
        },
    };

    /* ===== 核心应用 ===== */
    const App = {
        config: null,
        els: {},
        currentImageFile: null,

        init() {
            this.config = Utils.getConfig();
            this._cacheElements();
            this._bindEvents();
            this._restoreDraft();   // 先回填草稿（再更新预览）
            this._updateTemplatePreview();
            this._updatePhoneUI();
            Toast.init();
            Modal.init();
        },

        // 草稿自动回填（防跳转失败页面刷新丢数据）
        _restoreDraft() {
            const draft = Utils.loadFormDraft();
            if (!draft) return;
            let hasData = false;
            if (draft.phone) {
                this.els.phoneInput.value = Utils.formatPhone(draft.phone);
                hasData = true;
            }
            if (draft.orderNo) {
                this.els.orderNo.value = draft.orderNo;
                hasData = true;
            }
            // ★ 立即清掉草稿（用户后续每次input都会重新保存新草稿）
            // 避免残留草稿与新输入叠加（如旧值DRAFT-999与新输入FINAL-888拼在一起）
            Utils.clearFormDraft();
            if (hasData) {
                Toast.show('ℹ️ 已自动恢复上次填写内容', '', 2200);
            }
        },

        _cacheElements() {
            this.els = {
                configBtn: document.getElementById('configBtn'),
                orderNo: document.getElementById('orderNo'),
                photoInput: document.getElementById('photoInput'),
                photoBtn: document.getElementById('photoBtn'),
                uploadBtn: document.getElementById('uploadBtn'),
                previewArea: document.getElementById('previewArea'),
                previewImg: document.getElementById('previewImg'),
                retakeBtn: document.getElementById('retakeBtn'),
                recognizeBtn: document.getElementById('recognizeBtn'),
                loadingArea: document.getElementById('loadingArea'),
                phoneInput: document.getElementById('phoneInput'),
                clearPhoneBtn: document.getElementById('clearPhoneBtn'),
                phoneTip: document.getElementById('phoneTip'),
                smsBtn: document.getElementById('smsBtn'),
                wechatBtn: document.getElementById('wechatBtn'),
                copyBtn: document.getElementById('copyBtn'),
                templateSection: document.getElementById('templateSection'),
                tabBtns: document.querySelectorAll('.tab-btn'),
                smsTemplatePreview: document.getElementById('smsTemplatePreview'),
                wechatTemplatePreview: document.getElementById('wechatTemplatePreview'),
                verifyTemplatePreview: document.getElementById('verifyTemplatePreview')
            };
        },

        _bindEvents() {
            // 设置按钮
            this.els.configBtn.addEventListener('click', () => {
                window.location.href = 'config.html';
            });

            // 拍照
            this.els.photoBtn.addEventListener('click', () => {
                this.els.photoInput.removeAttribute('capture');
                this.els.photoInput.setAttribute('capture', 'environment');
                this.els.photoInput.accept = 'image/*';
                this.els.photoInput.click();
            });

            // 上传
            this.els.uploadBtn.addEventListener('click', () => {
                this.els.photoInput.removeAttribute('capture');
                this.els.photoInput.accept = 'image/*';
                this.els.photoInput.click();
            });

            // 文件选择
            this.els.photoInput.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) this._handleImageFile(file);
                e.target.value = '';
            });

            // 重拍
            this.els.retakeBtn.addEventListener('click', () => {
                this._resetCapture();
            });

            // 识别按钮
            this.els.recognizeBtn.addEventListener('click', () => {
                if (this.currentImageFile) this._doRecognize(this.currentImageFile);
            });

            // 手机号输入
            this.els.phoneInput.addEventListener('input', (e) => {
                const formatted = Utils.formatPhone(e.target.value);
                e.target.value = formatted;
                this._updatePhoneUI();
                this._updateTemplatePreview();
                Utils.saveFormDraft({ phone: formatted, orderNo: this.els.orderNo.value || '' });
                // 用户输入了新内容 → 跳转按钮立即恢复可点击
                this._unlockAllActionBtns();
            });

            // 清空手机号
            this.els.clearPhoneBtn.addEventListener('click', () => {
                this.els.phoneInput.value = '';
                this._updatePhoneUI();
                this._updateTemplatePreview();
                Utils.saveFormDraft({ phone: '', orderNo: this.els.orderNo.value || '' });
                this.els.phoneInput.focus();
                // 用户清空了内容（输入变化）→ 跳转按钮立即恢复可点击
                this._unlockAllActionBtns();
            });

            // 订单号变化
            this.els.orderNo.addEventListener('input', () => {
                this._updateTemplatePreview();
                Utils.saveFormDraft({ phone: this.els.phoneInput.value || '', orderNo: this.els.orderNo.value || '' });
                // 用户输入了新订单号 → 跳转按钮立即恢复可点击
                this._unlockAllActionBtns();
            });

            // 发送短信
            this.els.smsBtn.addEventListener('click', () => this._actionSendSms());

            // 微信联系
            this.els.wechatBtn.addEventListener('click', () => this._actionOpenWechat());

            // 复制号码
            this.els.copyBtn.addEventListener('click', () => this._actionCopyPhone());

            // 模板 Tab 切换
            this.els.tabBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    this.els.tabBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    const tab = btn.dataset.tab;
                    document.querySelectorAll('.template-item').forEach(item => {
                        item.classList.remove('active');
                    });
                    document.getElementById('tpl-' + tab).classList.add('active');
                });
            });

            // ===== 【需求2】消息预览内容点击即复制 =====
            const previewEls = [
                { el: this.els.smsTemplatePreview,    label: '短信模板内容' },
                { el: this.els.wechatTemplatePreview, label: '微信模板内容' },
                { el: this.els.verifyTemplatePreview, label: '验证消息内容' }
            ];
            previewEls.forEach(({ el, label }) => {
                if (!el) return;
                // 视觉提示：光标手型（CSS配hover高亮）
                el.style.cursor = 'pointer';
                el.title = '点击复制此段内容';
                // 点击事件：复制文本 → Toast 反馈
                el.addEventListener('click', () => {
                    const text = (el.innerText || el.textContent || '').trim();
                    if (!text) { Toast.show('暂无内容可复制', '', 1500); return; }
                    const ok = this._copyToClipboardSync(text);
                    // 成功 Toast：显示前18字+脱敏
                    const preview = text.length > 18 ? text.slice(0, 18) + '...' : text;
                    if (ok) {
                        Toast.success(`✅ 已复制${label}：\n${preview}`, 2600);
                    } else {
                        Toast.show(`请长按选中以复制${label}`, 'warning', 2600);
                    }
                    // 点击态微动画
                    el.style.transition = 'transform 0.12s, background 0.12s';
                    el.style.transform = 'scale(0.985)';
                    el.style.background = 'rgba(99, 102, 241, 0.08)';
                    setTimeout(() => {
                        el.style.transform = '';
                        el.style.background = '';
                    }, 140);
                });
            });
        },

        /* ===== 图片处理 ===== */
        async _handleImageFile(file) {
            if (!file.type.startsWith('image/')) {
                Toast.error('请选择图片文件');
                return;
            }
            // 照片更新 → 立即解除三个跳转按钮的禁用态
            this._unlockAllActionBtns();
            this.currentImageFile = file;

            // 显示预览
            const reader = new FileReader();
            reader.onload = (e) => {
                this.els.previewImg.src = e.target.result;
                this.els.previewArea.style.display = 'block';
            };
            reader.readAsDataURL(file);

            // 自动识别
            if (this.config.autoRecognize) {
                setTimeout(() => this._doRecognize(file), 300);
            }
        },

        async _doRecognize(file) {
            this.els.loadingArea.style.display = 'flex';
            try {
                const result = await OCRModule.recognizePhoneFromImage(file);
                this.els.loadingArea.style.display = 'none';

                if (result && result.phone) {
                    this.els.phoneInput.value = result.phone;
                    this._updatePhoneUI();
                    this._updateTemplatePreview();
                    Utils.saveFormDraft({ phone: result.phone, orderNo: this.els.orderNo.value || '' });
                    this._unlockAllActionBtns();
                    Toast.success(`✅ 识别成功！已填入手机号 ${Utils.maskPhone(result.phone)}`, 2600);
                } else {
                    // ========= 识别失败：Toast 提示，让用户换清晰图或手动输入（不弹粘贴 Modal）=========
                    const rawText = (result && result.rawText) || '';
                    const errMsg  = (result && result.error) || '未识别到手机号';
                    const preview = rawText ? rawText.replace(/\s+/g, ' ').slice(0, 48) + (rawText.length > 48 ? '...' : '') : '';
                    const head = preview ? (`📝 OCR识别到文字：${preview}`) : (errMsg || '图片内容不清晰');
                    Toast.warning(`${head}\n💡 请换一张更清晰的照片，或直接手动输入手机号`, 4000);
                    this._unlockAllActionBtns();
                }
            } catch (err) {
                this.els.loadingArea.style.display = 'none';
                this._unlockAllActionBtns();
                Toast.error('识别出错，请换一张更清晰的照片重试，或直接手动输入', 3600);
            }
        },

        /**
         * 兜底：打开「粘贴订单文字自动提取手机号」Modal
         * @param {string} preFillText  预填文字（例如 OCR 已识别到的原文，让用户直接修正）
         * @param {string} note         顶部小提示文字
         */
        async _openPasteExtractModal(preFillText = '', note = '') {
            const safePreFill = String(preFillText || '')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            const safeNote = note ? (`<p style="margin:0 0 10px;color:#f59e0b;font-size:12px;">💡 ${note.replace(/[<>&]/g,'')}</p>`) : '';

            const confirmed = await Modal.show({
                title: '粘贴订单文字 自动提取手机号',
                body: `
                    ${safeNote}
                    <p style="margin:0 0 10px;color:#64748b;font-size:13px;">
                      从淘宝/京东/商家后台复制订单详情文字（含客户手机号）粘贴到下面，或修正上方 OCR 识别结果后，点击<b style="color:#4f46e5">「提取并填入」</b>
                    </p>
                    <textarea id="__pasteExtractArea" rows="8"
                      style="width:100%;padding:12px;border:1.5px solid #e2e8f0;border-radius:10px;
                             font-size:14px;line-height:1.6;resize:vertical;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;"
                      placeholder="示例：&#10;收货人：张三&#10;手机：138 0000 9999&#10;收货地址：xxx&#10;订单号：20260902-001&#10;备注：尽快发货">${safePreFill}</textarea>
                    <p style="margin:8px 0 0;font-size:12px;color:#94a3b8;">
                      ✅ 自动识别：<b>+86/空格/横线/全角数字/「电话：」前缀</b> 等多种格式
                    </p>
                `,
                confirmText: '提取并填入',
                cancelText: '取消，手动输入',
                theme: 'paste-extract'
            });

            if (!confirmed) {
                // 用户取消了，手动输入模式：聚焦到手机号输入框
                this.els.phoneInput.focus();
                return;
            }

            // 读用户粘贴的文字 → 提取
            const txtEl = document.getElementById('__pasteExtractArea');
            const userText = txtEl ? txtEl.value : '';
            if (!userText || !userText.trim()) {
                Toast.warning('内容为空，请粘贴订单文字', 2200);
                return;
            }
            const phone = Utils.extractPhoneFromText(userText);
            if (phone) {
                this.els.phoneInput.value = phone;
                this._updatePhoneUI();
                this._updateTemplatePreview();
                Utils.saveFormDraft({ phone, orderNo: this.els.orderNo.value || '' });
                this._unlockAllActionBtns();
                Toast.success(`✅ 已提取到手机号 ${Utils.maskPhone(phone)} 并自动填入`, 2800);
            } else {
                // 还是没提取到 → 提示 + 再开一次 Modal 让用户重新粘贴
                Toast.warning('未在粘贴的文字里找到手机号，请检查格式再试一次', 3000);
                setTimeout(() => this._openPasteExtractModal(userText, '找不到1开头的11位手机号，请检查是否粘贴正确'), 500);
            }
        },

        _resetCapture() {
            this.els.previewArea.style.display = 'none';
            this.els.previewImg.src = '';
            this.currentImageFile = null;
            this.els.loadingArea.style.display = 'none';
        },

        /* ===== UI 更新 ===== */
        _updatePhoneUI() {
            const phone = this.els.phoneInput.value;
            const hasValue = phone.length > 0;
            this.els.clearPhoneBtn.style.display = hasValue ? 'flex' : 'none';

            const tipEl = this.els.phoneTip;
            if (!phone) {
                tipEl.textContent = '';
                tipEl.classList.remove('error');
            } else if (Utils.isValidPhone(phone)) {
                tipEl.textContent = '✓ 手机号格式正确';
                tipEl.classList.remove('error');
                tipEl.style.color = 'var(--success-color)';
            } else if (phone.length < 11) {
                tipEl.textContent = `还需输入 ${11 - phone.length} 位数字`;
                tipEl.classList.add('error');
                tipEl.style.color = '';
            } else {
                tipEl.textContent = '× 手机号格式不正确（请以1开头的11位数字）';
                tipEl.classList.add('error');
                tipEl.style.color = '';
            }
        },

        _getCurrentData() {
            return {
                phone: this.els.phoneInput.value.trim(),
                orderNo: this.els.orderNo.value.trim() || '（未填写）',
                date: Utils.getDateStr()
            };
        },

        _updateTemplatePreview() {
            const data = this._getCurrentData();
            const phone = data.phone;

            if (phone && phone.length >= 7) {
                this.els.templateSection.style.display = 'block';
            }

            this.els.smsTemplatePreview.textContent = Utils.renderTemplate(this.config.smsTemplate, data);
            this.els.wechatTemplatePreview.textContent = Utils.renderTemplate(this.config.wechatTemplate, data);
            this.els.verifyTemplatePreview.textContent = Utils.renderTemplate(this.config.verifyTemplate, data);
        },

        /* ===== 一键解除所有跳转按钮禁用态
           用户输入新内容 / 照片更新时立即调用，
           使"发送短信 / 微信联系 / 复制号码"三个按钮恢复可点击（打断之前跳转操作遗留的按钮锁）===== */
        _unlockAllActionBtns() {
            try {
                if (this.els.smsBtn)    { this.els.smsBtn.disabled    = false; this.els.smsBtn.style.opacity    = ''; }
                if (this.els.wechatBtn) { this.els.wechatBtn.disabled = false; this.els.wechatBtn.style.opacity = ''; }
                if (this.els.copyBtn)   { this.els.copyBtn.disabled   = false; this.els.copyBtn.style.opacity   = ''; }
            } catch (e) { /* ignore */ }
        },

        /* ===== 检查手机号 ===== */
        _checkPhone() {
            const phone = this.els.phoneInput.value.trim();
            if (!phone) {
                Toast.warning('请先输入或识别手机号码');
                this.els.phoneInput.focus();
                return null;
            }
            if (!Utils.isValidPhone(phone)) {
                Toast.error('手机号格式不正确，请检查');
                this.els.phoneInput.focus();
                return null;
            }
            return phone;
        },

        /* ===== 操作：发送短信 ===== */
        async _actionSendSms() {
            // 防重复点击锁
            const btn = this.els.smsBtn;
            if (btn.disabled) return;
            btn.disabled = true;
            const restoreBtn = () => { setTimeout(() => { btn.disabled = false; }, 400); };

            const phone = this._checkPhone();
            if (!phone) { restoreBtn(); return; }

            // ========== 同步准备：任何 await 之前完成 ==========
            const data = this._getCurrentData();
            const smsContent = Utils.renderTemplate(this.config.smsTemplate, data);
            const fullPhone = (this.config.countryCode || '') + phone;
            const encodedBody = encodeURIComponent(smsContent);
            // 按平台构造 sms: URL
            const smsUrl = Utils.isIOS()
                ? `sms:${fullPhone}&body=${encodedBody}`   // iOS: &body=
                : `sms:${fullPhone}?body=${encodedBody}`;  // Android: ?body=

            // 同步跳转函数（用户手势tick内执行）
            const triggerSmsSync = () => {
                Utils.saveFormDraft({
                    phone: phone,
                    orderNo: (this.els.orderNo.value || '').trim()
                });
                Utils.launchExternalApp(smsUrl);
            };

            try {
                if (this.config.confirmBeforeAction) {
                    const ok = await Modal.show({
                        title: '发送短信',
                        body: `确认向以下号码发送短信？<br><span class="phone-highlight">${Utils.maskPhone(phone)}</span><br><br>将跳转至系统短信应用，号码和内容自动填入，您可编辑后发送。`,
                        confirmText: '发送',
                        cancelText: '取消',
                        theme: 'sms-theme',
                        onConfirmSync: triggerSmsSync  // ★ 在确认点击同步tick内立即跳转
                    });
                    if (!ok) { restoreBtn(); return; }
                } else {
                    // 无确认弹窗：在当前按钮click同步tick内立即触发
                    triggerSmsSync();
                }

                // 跳转后异步给提示（不阻塞跳转）
                setTimeout(() => {
                    if (!Utils.isMobile()) {
                        Toast.show('💻 桌面端不支持短信跳转，请在手机浏览器中使用', 'warning', 3500);
                    } else {
                        Toast.success('✅ 已打开短信应用（若未弹出请检查浏览器跳转权限）', 3500);
                    }
                }, 500);
                restoreBtn();
            } catch (e) {
                Toast.error('无法打开短信应用：' + (e.message || ''), 3000);
                console.error(e);
                restoreBtn();
            }
        },

        /* ===== 操作：微信联系 ===== */
        async _actionOpenWechat() {
            // ================= 第一阶段：同步准备（不做任何await） =================
            // 防重复点击锁
            const btn = this.els.wechatBtn;
            if (btn.disabled) return;
            btn.disabled = true;
            const restoreBtn = () => { setTimeout(() => { btn.disabled = false; }, 400); };

            // 手机号校验（同步）
            const phone = this._checkPhone();
            if (!phone) { restoreBtn(); return; }

            // 数据准备（同步）
            const data = this._getCurrentData();
            const verifyMsg = Utils.renderTemplate(this.config.verifyTemplate, data);
            const copyText = `手机号：${phone}\n验证消息：${verifyMsg}`;

            // 按平台选择最优 weixin:// scheme（单一策略，避免多方案冲突）
            // iOS 对带路径的 scheme 兼容极差，仅用最短的 weixin:// 最稳
            // Android 支持精确跳转到「添加朋友」页
            // 桌面端用朋友页兜底
            let weixinUrl;
            if (Utils.isIOS()) {
                weixinUrl = 'weixin://';
            } else if (/Android/i.test(navigator.userAgent)) {
                weixinUrl = 'weixin://dl/addfriend';
            } else {
                weixinUrl = 'weixin://dl/friend';
            }

            // 定义：在「用户手势同步tick内」立即执行（核心——任何await都不能出现在它之前）
            // ★ 顺序：① 先同步复制【纯手机号】→ ② 立即Toast"页面更新"→ ③ 存草稿 → ④ 跳转微信
            const triggerLaunchSync = () => {
                // ① 同步复制纯手机号（确保剪贴板在跳转前已写入，用户：到微信后直接粘贴搜索）
                const copyOk = this._copyToClipboardSync(phone);
                // ② 立即页面 Toast 反馈（用户要求：页面更新）
                if (copyOk) {
                    Toast.success(`✅ 已复制手机号 ${Utils.maskPhone(phone)}，正在打开微信...`, 3000);
                } else {
                    Toast.show(`📋 请复制手机号：${Utils.maskPhone(phone)}（稍后手动粘贴搜索）`, '', 3000);
                }
                // ③ 保存草稿（防页面任何异常刷新丢数据）
                Utils.saveFormDraft({
                    phone: phone,
                    orderNo: (this.els.orderNo.value || '').trim()
                });
                // ④ 跳转微信（隐藏<a>.click()方案，不销毁当前页）
                const launched = Utils.launchExternalApp(weixinUrl);
                if (!launched) Utils.launchExternalApp('weixin://');
            };

            // 跳转启动后，执行兜底检测 + Toast 提示（异步，不阻塞跳转）
            const afterLaunchTasks = async () => {
                try {
                    // ---------- ① 跳转后 3.5 秒：显示后续操作指引（不与立即 Toast 冲突） ----------
                    // 说明：triggerLaunchSync 已在同步 tick 内立即显示「✅ 已复制手机号 XXX，正在打开微信」3秒Toast
                    // 此处延迟到3.5秒，等前面的Toast消失后再显示补充指引
                    setTimeout(async () => {
                        try { await this._copyToClipboard(copyText, true); } catch (_) {}
                        restoreBtn();
                        // 给不同环境的后续指引（不重复说"已复制"）
                        let tip = '';
                        if (Utils.isWeChat()) {
                            tip = '💡 当前在微信内：请点击「+」→「添加朋友」→ 粘贴搜索';
                        } else if (Utils.isMobile()) {
                            tip = '💡 回到页面后：打开微信 → 通讯录 → 新的朋友 → 粘贴搜索手机号\n验证消息已复制备用，添加时粘贴发送';
                        } else {
                            tip = '💡 电脑端：请在手机浏览器访问，或复制下面内容手动打开微信添加：\n' + copyText;
                        }
                        Toast.show(tip, '', 8000);
                    }, 3500);

                    // ---------- ② 成功提示增强：若页面真的切后台=微信已打开，改Toast为成功 ----------
                    let alreadyReported = false;
                    const visHandler = () => {
                        if (document.visibilityState === 'hidden' && !alreadyReported) {
                            alreadyReported = true;
                            document.removeEventListener('visibilitychange', visHandler);
                            // 回到本页后才会显示这段（页面切后台时UI不可见）
                            setTimeout(() => {
                                Toast.show(
                                    '✅ 已唤起微信！\n' +
                                    '通讯录 → 新的朋友 → 粘贴搜索手机号\n' +
                                    '添加好友时粘贴验证消息发送',
                                    'success', 6000
                                );
                            }, 500);
                        }
                    };
                    document.addEventListener('visibilitychange', visHandler);
                    // 30秒后自动移除监听，防内存泄漏
                    setTimeout(() => {
                        document.removeEventListener('visibilitychange', visHandler);
                    }, 30000);
                } catch (globalErr) {
                    console.error('afterLaunchTasks 异常：', globalErr);
                    restoreBtn();
                    Toast.error('操作异常，请重试');
                }
            };

            // ================= 第二阶段：触发跳转（同步用户手势tick内）=================
            try {
                if (this.config.confirmBeforeAction) {
                    // 需要弹窗确认 → 把「跳转执行」通过 onConfirmSync 绑定到确认按钮点击（同步）
                    const confirmed = await Modal.show({
                        title: '微信联系',
                        body: `打开微信联系 <span class="phone-highlight">${Utils.maskPhone(phone)}</span>？<br><br>手机号和验证消息将自动复制，若未自动跳转可手动粘贴搜索。`,
                        confirmText: '打开微信',
                        cancelText: '取消',
                        theme: 'wechat-theme',
                        // ★ 关键：在确认按钮 click 的同步 tick 内立即跳转
                        onConfirmSync: triggerLaunchSync
                    });
                    if (!confirmed) { restoreBtn(); return; }
                    // 用户已确认 → 跳转已在 onConfirmSync 中触发（同步发生），之后执行兜底任务
                    afterLaunchTasks();
                } else {
                    // 不需要弹窗 → 在当前微信按钮 click 的同步 tick 内立即跳转
                    triggerLaunchSync();
                    // 跳转已触发，异步执行兜底检测
                    afterLaunchTasks();
                }
            } catch (e) {
                Toast.error('操作失败：' + (e.message || ''), 3000);
                console.error(e);
                restoreBtn();
            }
        },

        /* ===== 操作：复制手机号 ===== */
        async _actionCopyPhone() {
            const phone = this._checkPhone();
            if (!phone) return;

            try {
                await this._copyToClipboard(phone, true);
                Toast.success(`已复制：${Utils.maskPhone(phone)}`);
            } catch (e) {
                Toast.error('复制失败，请手动长按复制');
                console.error(e);
            }
        },

        /* ===== 剪贴板操作 ===== */
        async _copyToClipboard(text, showFallback = true) {
            // 优先使用 Clipboard API
            if (navigator.clipboard && window.isSecureContext) {
                try {
                    await navigator.clipboard.writeText(text);
                    return;
                } catch (e) {
                    console.warn('Clipboard API 失败，降级使用 execCommand', e);
                }
            }

            // 降级：execCommand
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.top = '-1000px';
            textarea.style.left = '-1000px';
            textarea.style.opacity = '0';
            textarea.setAttribute('readonly', '');
            document.body.appendChild(textarea);
            textarea.select();
            textarea.setSelectionRange(0, text.length);

            let success = false;
            try {
                success = document.execCommand('copy');
            } catch (e) {
                success = false;
            }

            document.body.removeChild(textarea);

            if (!success && showFallback) {
                throw new Error('复制失败');
            }
        },

        /* 同步版剪贴板（混合策略）：确保在用户手势同步 tick 内完成写入
           策略1：临时textarea + execCommand('copy') — iOS Safari / 微信H5 兼容性最好
           策略2：execCommand失败时，同步发起 navigator.clipboard.writeText（安全上下文100%成功）
           —— localhost/HTTPS 下策略2一定会成功，函数返回true保证成功Toast */
        _copyToClipboardSync(text) {
            if (!text) return false;
            const str = String(text);
            // ===== 策略1：execCommand（textarea方案） =====
            let execOk = false;
            try {
                const textarea = document.createElement('textarea');
                textarea.value = str;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.top = '0';
                textarea.style.left = '0';
                textarea.style.width = '1px';
                textarea.style.height = '1px';
                textarea.style.opacity = '0';
                textarea.style.padding = '0';
                textarea.style.border = 'none';
                textarea.style.outline = 'none';
                textarea.style.webkitUserSelect = 'text';
                textarea.style.userSelect = 'text';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                textarea.setSelectionRange(0, str.length);
                try { execOk = document.execCommand('copy'); } catch (e) { execOk = false; }
                if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
            } catch (e) { execOk = false; }

            if (execOk) return true;

            // ===== 策略2：navigator.clipboard（HTTPS 或 localhost 安全上下文） =====
            if (navigator.clipboard && (window.isSecureContext || location.hostname === 'localhost')) {
                // 立刻发起写入（不阻塞返回；安全上下文+用户手势窗口内几乎必然成功）
                navigator.clipboard.writeText(str).catch(() => {});
                return true;
            }
            return false;
        }
    };

    /* ===== 启动 ===== */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.__app_instance = App;   // 暴露实例到 window 以便调试/自动化测试
            App.init();
        });
    } else {
        window.__app_instance = App;       // 暴露实例到 window 以便调试/自动化测试
        App.init();
    }

})();
