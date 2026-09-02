/* ==========================================================
 * 预设文案配置页逻辑
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

    /* ===== 工具 ===== */
    function getConfig() {
        try {
            const stored = localStorage.getItem('customer_contact_config');
            if (stored) {
                return Object.assign({}, DEFAULT_CONFIG, JSON.parse(stored));
            }
        } catch (e) {
            console.warn('读取配置失败', e);
        }
        return Object.assign({}, DEFAULT_CONFIG);
    }

    function saveConfig(config) {
        localStorage.setItem('customer_contact_config', JSON.stringify(config));
    }

    /* ===== Toast ===== */
    const Toast = {
        _el: null,
        _timer: null,
        show(message, type = '', duration = 2000) {
            if (!this._el) this._el = document.getElementById('toast');
            clearTimeout(this._timer);
            this._el.className = 'toast ' + type;
            this._el.textContent = message;
            requestAnimationFrame(() => this._el.classList.add('show'));
            this._timer = setTimeout(() => this._el.classList.remove('show'), duration);
        },
        success(msg, d) { this.show(msg, 'success', d); },
        error(msg, d) { this.show(msg, 'error', d || 2500); },
        warning(msg, d) { this.show(msg, 'warning', d); }
    };

    /* ===== 配置页逻辑 ===== */
    const ConfigPage = {
        els: {},
        config: null,

        init() {
            this.config = getConfig();
            this._cache();
            this._fill();
            this._bind();
        },

        _cache() {
            this.els = {
                backBtn: document.getElementById('backBtn'),
                smsTemplate: document.getElementById('smsTemplate'),
                wechatTemplate: document.getElementById('wechatTemplate'),
                verifyTemplate: document.getElementById('verifyTemplate'),
                autoRecognize: document.getElementById('autoRecognize'),
                confirmBeforeAction: document.getElementById('confirmBeforeAction'),
                countryCode: document.getElementById('countryCode'),
                saveBtn: document.getElementById('saveBtn'),
                resetBtn: document.getElementById('resetBtn')
            };
        },

        _fill() {
            const c = this.config;
            this.els.smsTemplate.value = c.smsTemplate || '';
            this.els.wechatTemplate.value = c.wechatTemplate || '';
            this.els.verifyTemplate.value = c.verifyTemplate || '';
            this.els.autoRecognize.checked = !!c.autoRecognize;
            this.els.confirmBeforeAction.checked = !!c.confirmBeforeAction;
            this.els.countryCode.value = c.countryCode || '+86';
        },

        _bind() {
            this.els.backBtn.addEventListener('click', () => {
                this._tryBack();
            });

            this.els.saveBtn.addEventListener('click', () => this._save());

            this.els.resetBtn.addEventListener('click', async () => {
                const ok = await this._confirm('恢复默认', '确定要恢复所有配置为默认值吗？当前修改将丢失。');
                if (ok) {
                    this.config = Object.assign({}, DEFAULT_CONFIG);
                    this._fill();
                    saveConfig(this.config);
                    Toast.success('已恢复默认配置');
                }
            });

            // 输入框实时预览变量替换
            ['smsTemplate', 'wechatTemplate', 'verifyTemplate'].forEach(key => {
                const el = this.els[key];
                if (!el) return;
                el.addEventListener('input', () => {
                    el.style.borderColor = '';
                });
            });
        },

        async _confirm(title, body) {
            // 简单原生确认，或实现轻量弹窗
            return window.confirm(title + '\n\n' + body);
        },

        _tryBack() {
            // 对比当前表单值和保存的配置
            const current = this._collect();
            const saved = this.config;
            const changed = JSON.stringify(current) !== JSON.stringify(saved);

            if (changed) {
                const ok = window.confirm('有未保存的修改，是否保存后返回？\n\n点击"确定"保存并返回，点击"取消"直接返回不保存。');
                if (ok) {
                    const result = this._save(true);
                    if (result) this._goBack();
                    return;
                }
            }
            this._goBack();
        },

        _goBack() {
            if (document.referrer && document.referrer.includes('index.html')) {
                history.back();
            } else {
                window.location.href = 'index.html';
            }
        },

        _collect() {
            return {
                smsTemplate: this.els.smsTemplate.value.trim(),
                wechatTemplate: this.els.wechatTemplate.value.trim(),
                verifyTemplate: this.els.verifyTemplate.value.trim(),
                autoRecognize: this.els.autoRecognize.checked,
                confirmBeforeAction: this.els.confirmBeforeAction.checked,
                countryCode: this.els.countryCode.value
            };
        },

        _save(silent = false) {
            const data = this._collect();

            // 简单校验
            if (!data.smsTemplate) {
                Toast.warning('短信模板不能为空');
                this.els.smsTemplate.focus();
                return false;
            }
            if (!data.wechatTemplate) {
                Toast.warning('微信聊天模板不能为空');
                this.els.wechatTemplate.focus();
                return false;
            }
            if (!data.verifyTemplate) {
                Toast.warning('好友验证消息不能为空');
                this.els.verifyTemplate.focus();
                return false;
            }

            try {
                saveConfig(data);
                this.config = data;
                if (!silent) Toast.success('配置已保存');
                return true;
            } catch (e) {
                console.error(e);
                Toast.error('保存失败，请重试');
                return false;
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => ConfigPage.init());
    } else {
        ConfigPage.init();
    }

})();
