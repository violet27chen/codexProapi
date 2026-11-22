/* CodexPro API — Alpine.js application */
/* globals Alpine */

function app() {
    return {
        /* ── state ── */
        page: 'dashboard',
        version: '...',
        health: null,
        now: '',
        accounts: [],
        accHealth: {},
        usageData: [],
        models: [],
        modelsLastProbed: 0,
        modelsCatalogError: '',
        modelsInProgress: false,
        logs: [],
        cfg: { api_key: '', default_model: '', token_refresh_interval_minutes: 60 },
        refreshStatus: { active: false, intervalMinutes: 60, lastRun: 0, lastSummary: null, isRefreshing: false },
        showKey: false,
        showAdd: false,
        accountEditIndex: null,
        localCodexLoginStatus: { status: 'idle', message: '', output: '' },
        af: { mode: 'json', name: '', authJson: '', access_token: '', account_id: '', refresh_token: '', proxy: '' },
        showBatchImport: false,
        batchImportText: '',
        batchImportResults: null,
        imageCopied: false,
        lf: 'all',
        loading: { usage: false, logs: false, models: false, health: false, addAcc: false, localCodexLogin: false, settings: false, refreshTokens: false, batchImport: false },
        toast: null,
        _tt: null,
        endpoints: [
            { m: 'POST', path: '/v1/chat/completions', desc: '对话补全' },
            { m: 'POST', path: '/v1/responses', desc: 'OpenAI Responses API' },
            { m: 'POST', path: '/v1/messages', desc: 'Claude Messages 格式兼容（OpenAI 格式响应）' },
            { m: 'GET',  path: '/v1/models',            desc: '模型列表' },
            { m: 'GET',  path: '/health',               desc: '健康检查' },
            { m: 'POST', path: '/api/accounts/batch-import', desc: '批量导入账号' },
        ],

        /* ── computed ── */
        get filtLogs() {
            return this.lf === 'all' ? this.logs : this.logs.filter(l => l.level === this.lf);
        },
        get availableModelsCount() {
            return this.models.filter(m => m.available === true).length;
        },
        get unavailableModelsCount() {
            return this.models.filter(m => m.available === false).length;
        },
        get unknownModelsCount() {
            return this.models.filter(m => m.available == null).length;
        },
        get selectableModels() {
            return this.models.filter(m => m.type === 'text' && m.available !== false);
        },
        get imageModels() {
            return this.models.filter(m => m.type === 'image' && m.available !== false);
        },
        get imageModelsAvailable() {
            return this.imageModels.length > 0;
        },
        get displayedEndpoints() {
            if (!this.imageModelsAvailable) return this.endpoints;
            return [
                ...this.endpoints.slice(0, 3),
                { m: 'POST', path: '/v1/images/generations', desc: '图片生成' },
                ...this.endpoints.slice(3),
            ];
        },
        get todayReqs() {
            const d = new Date().toISOString().slice(0, 10);
            return this.logs.filter(l => l.type === 'request' && l.time && l.time.startsWith(d)).length;
        },
        get totalTokens() {
            return this.usageData.reduce((s, u) => s + (u.used_tokens || 0), 0);
        },
        get curlExample() {
            const k = this.cfg.api_key;
            const auth = k ? `  -H "Authorization: Bearer ${k}" \\\n` : '';
            const model = this.cfg.default_model || this.selectableModels[0]?.id || '自动获取的模型 ID';
            const body = { model, messages: [{ role: 'user', content: '你好' }], stream: false };
            return `curl -sS http://localhost:1455/v1/chat/completions \\
  -H "Content-Type: application/json" \\
${auth}  -d '${JSON.stringify(body)}'`;
        },
        get claudeCurlExample() {
            const k = this.cfg.api_key;
            const auth = k ? `  -H "x-api-key: ${k}" \\\n` : '';
            const model = this.cfg.default_model || this.selectableModels[0]?.id || '自动获取的模型 ID';
            const body = {
                model,
                max_tokens: 1024,
                system: 'You are a helpful assistant.',
                messages: [{ role: 'user', content: '你好' }],
                stream: false,
            };
            return `curl -sS http://localhost:1455/v1/messages \\
  -H "Content-Type: application/json" \\
${auth}  -d '${JSON.stringify(body)}'`;
        },
        get responsesCurlExample() {
            const k = this.cfg.api_key;
            const auth = k ? `  -H "Authorization: Bearer ${k}" \\\n` : '';
            const model = this.cfg.default_model || this.selectableModels[0]?.id || '自动获取的模型 ID';
            const body = { model, input: '你好', stream: false };
            return `curl -sS http://localhost:1455/v1/responses \\
  -H "Content-Type: application/json" \\
${auth}  -d '${JSON.stringify(body)}'`;
        },
        get imageCurlExample() {
            const k = this.cfg.api_key;
            const auth = k ? `  -H "Authorization: Bearer ${k}" \\\n` : '';
            const imageModel = this.models.find(m => m.type === 'image' && m.available !== false)?.id;
            const body = { prompt: '一只橘猫坐在窗边', n: 1, size: '1024x1024', ...(imageModel ? { model: imageModel } : {}) };
            return `curl -sS http://localhost:1455/v1/images/generations \\
  -H "Content-Type: application/json" \\
${auth}  -d '${JSON.stringify(body)}'`;
        },
        highlightShellCommand(command) {
            return String(command).split('\n').map((line) => {
                const escaped = line
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
                if (/^\s*curl\b/.test(line)) {
                    return escaped
                        .replace(/\bcurl\b/, '<span class="shell-command">curl</span>')
                        .replace(/(https?:\/\/[^\s\\]+)/, '<span class="shell-url">$1</span>');
                }
                if (/^\s*-H\b/.test(line)) {
                    return escaped
                        .replace(/(^\s*)-H/, '$1<span class="shell-option">-H</span>')
                        .replace(/("[^"]*")/, '<span class="shell-json">$1</span>');
                }
                if (/^\s*-d\b/.test(line)) {
                    return escaped
                        .replace(/(^\s*)-d/, '$1<span class="shell-option">-d</span>')
                        .replace(/('[^']*')/, '<span class="shell-json">$1</span>');
                }
                return escaped;
            }).join('\n');
        },

        /* ── init ── */
        async init() {
            this.updateClock();
            setInterval(() => this.updateClock(), 1000);
            await Promise.all([
                this.loadVer(),
                this.checkHealth(),
                this.loadAccounts(),
                this.loadUsage(),
                this.loadLogs(),
                this.loadSettings(),
                this.loadModels(),
            ]);
            this.handleOAuth();
            this.loadRefreshStatus();
            setInterval(() => {
                if (this.page === 'logs' || this.page === 'dashboard') this.loadLogs();
            }, 10000);
            setInterval(() => {
                if (this.page === 'models' && !this.loading.models) this.doRefreshModels(false);
            }, 60000);
            setInterval(() => this.checkHealth(), 30000);
            setInterval(() => {
                if (this.page === 'settings') this.loadRefreshStatus();
            }, 30000);
        },

        updateClock() {
            this.now = new Date().toLocaleString('zh-CN', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
            }).replace(/\//g, '-');
        },

        async handleOAuth() {
            const p = new URLSearchParams(location.search);
            const o = p.get('oauth');
            if (o === 'success') {
                this.toast2('OAuth 登录成功，账号已添加', 'success');
                await this.loadAccounts();
                this.page = 'accounts';
                history.replaceState({}, '', '/');
            } else if (o === 'error') {
                this.toast2('OAuth 错误：' + (p.get('msg') || '未知'), 'error');
                history.replaceState({}, '', '/');
            }
        },

        /* ── data loaders ── */
        async loadVer() {
            try { this.version = (await (await fetch('/api/version')).json()).version || '?'; } catch { this.version = '?'; }
        },
        async checkHealth() {
            try { this.health = (await (await fetch('/health')).json()).status === 'ok' ? 'ok' : 'error'; } catch { this.health = 'error'; }
        },
        async loadAccounts() {
            try { this.accounts = (await (await fetch('/api/accounts')).json()).accounts || []; } catch {}
        },
        async loadUsage() {
            this.loading.usage = true;
            try {
                const r = await fetch('/api/usage');
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || '读取用量失败');
                this.usageData = d.accounts || [];
            } catch (e) {
                this.toast2('读取配额失败：' + e.message, 'error');
            } finally { this.loading.usage = false; }
        },
        async loadLogs() {
            this.loading.logs = true;
            try { this.logs = (await (await fetch('/api/logs')).json()).logs || []; } catch {} finally { this.loading.logs = false; }
        },
        async loadModels() {
            this.loading.models = true;
            try {
                const d = await (await fetch('/api/models')).json();
                this.models = d.models || [];
                this.modelsLastProbed = d.lastProbed || 0;
                this.modelsCatalogError = d.catalogError || '';
                this.modelsInProgress = d.inProgress === true;
            } catch {} finally { this.loading.models = false; }
        },
        async doRefreshModels(showToast = true) {
            this.loading.models = true;
            this.modelsInProgress = true;
            if (showToast) this.toast2('正在获取模型目录并探测可用性…', 'info');
            try {
                const r = await fetch('/api/models/refresh', { method: 'POST' });
                const d = await r.json();
                if (r.ok) {
                    this.models = d.models || [];
                    this.modelsLastProbed = d.lastProbed || 0;
                    this.modelsCatalogError = d.catalogError || '';
                    this.modelsInProgress = d.inProgress === true;
                    const ok = this.models.filter(m => m.available === true).length;
                    if (showToast && this.modelsCatalogError) {
                        this.toast2('模型目录获取失败：' + this.modelsCatalogError, 'error');
                    } else if (showToast) {
                        this.toast2(`探测完成：${ok}/${this.models.length} 可用`, 'success');
                    }
                } else if (showToast) {
                    this.toast2('探测失败：' + (d.error || ''), 'error');
                }
            } catch (e) { if (showToast) this.toast2('探测失败：' + e.message, 'error'); } finally { this.loading.models = false; this.modelsInProgress = false; }
        },
        async clearLogs() {
            if (!confirm('确定清空所有日志？')) return;
            try {
                await fetch('/api/logs', { method: 'DELETE' });
                this.logs = [];
                this.toast2('日志已清空', 'success');
            } catch { this.toast2('清空失败', 'error'); }
        },
        async loadSettings() {
            try { this.cfg = await (await fetch('/api/settings')).json(); } catch {}
        },
        async saveCfg() {
            this.loading.settings = true;
            try {
                const r = await fetch('/api/settings', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.cfg),
                });
                const d = await r.json();
                if (d.ok) {
                    this.cfg = {
                        api_key: d.api_key || '',
                        default_model: d.default_model || '',
                        token_refresh_interval_minutes: d.token_refresh_interval_minutes || 60,
                    };
                    this.toast2('设置已保存', 'success');
                    this.loadRefreshStatus();
                } else {
                    this.toast2('保存失败', 'error');
                }
            } catch (e) { this.toast2('保存失败：' + e.message, 'error'); } finally { this.loading.settings = false; }
        },

        /* ── accounts ── */
        resetAddForm() {
            this.accountEditIndex = null;
            this.af = { mode: 'json', name: '', authJson: '', access_token: '', account_id: '', refresh_token: '', proxy: '' };
        },
        startBrowserOAuthLogin() {
            window.location.assign('/auth/login');
        },
        editAccount(acc) {
            this.accountEditIndex = acc.index;
            this.af = {
                mode: 'manual',
                name: acc.name || '',
                authJson: '',
                access_token: '',
                account_id: acc.accountId || '',
                refresh_token: '',
                proxy: acc.proxy || '',
            };
            this.showAdd = true;
        },
        async submitAdd() {
            this.loading.addAcc = true;
            try {
                let body;
                if (this.accountEditIndex !== null) {
                    body = {
                        name: this.af.name,
                        access_token: this.af.access_token || undefined,
                        account_id: this.af.account_id,
                        refresh_token: this.af.refresh_token || undefined,
                        proxy: this.af.proxy,
                    };
                } else if (this.af.mode === 'json') {
                    if (!this.af.authJson.trim()) { this.toast2('请粘贴 auth.json 内容', 'error'); return; }
                    body = { name: this.af.name || undefined, authJson: this.af.authJson, proxy: this.af.proxy || undefined };
                } else {
                    if (!this.af.access_token || !this.af.account_id) { this.toast2('请填写 Token 和 Account ID', 'error'); return; }
                    body = { name: this.af.name || undefined, access_token: this.af.access_token, account_id: this.af.account_id, refresh_token: this.af.refresh_token || undefined, proxy: this.af.proxy || undefined };
                }
                const editing = this.accountEditIndex !== null;
                const r = await fetch(editing ? `/api/accounts/${this.accountEditIndex}` : '/api/accounts', {
                    method: editing ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const d = await r.json();
                if (r.ok && d.ok) {
                    this.toast2(editing ? '账号修改成功' : (d.updated ? '账号已存在，信息已更新' : '账号添加成功'), 'success');
                    this.showAdd = false;
                    await this.loadAccounts();
                } else this.toast2((editing ? '修改' : '添加') + '失败：' + (d.error || '未知'), 'error');
            } catch (e) { this.toast2('账号保存失败：' + e.message, 'error'); } finally { this.loading.addAcc = false; }
        },
        async startLocalCodexLogin() {
            this.loading.localCodexLogin = true;
            try {
                let r = await fetch('/api/accounts/local-login', { method: 'POST' });
                let status = await r.json();
                if (!r.ok) {
                    this.localCodexLoginStatus = { ...status, status: 'error' };
                    this.toast2('无法启动登录：' + (status.message || status.error || '未知'), 'error');
                    return;
                }

                this.localCodexLoginStatus = status;
                while (status.status === 'starting' || status.status === 'running' || status.status === 'importing') {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    r = await fetch('/api/accounts/local-login');
                    status = await r.json();
                    if (!r.ok) throw new Error(status.error || '读取登录状态失败');
                    this.localCodexLoginStatus = status;
                }

                if (status.status === 'complete') {
                    this.toast2(status.message || 'Codex 账号添加成功', 'success');
                    await this.loadAccounts();
                } else {
                    this.toast2(status.message || 'Codex 登录失败', 'error');
                }
            } catch (e) {
                this.localCodexLoginStatus = {
                    ...this.localCodexLoginStatus,
                    status: 'error',
                    message: e.message,
                };
                this.toast2('Codex 登录失败：' + e.message, 'error');
            } finally {
                this.loading.localCodexLogin = false;
            }
        },
        async checkAccountsHealth() {
            this.loading.health = true;
            this.toast2('检查中，需 5-15 秒…', 'info');
            try {
                const r = await fetch('/api/accounts/health');
                const d = await r.json();
                if (r.ok && d.accounts) {
                    const map = {};
                    for (const a of d.accounts) {
                        const mask = a.accountId ? a.accountId.slice(0, 8) + '…' : '—';
                        map[mask] = a;
                    }
                    this.accHealth = map;
                    const ok = d.accounts.filter(a => a.healthy).length;
                    const fail = d.accounts.length - ok;
                    this.toast2(`检查完成：${ok} 正常${fail > 0 ? '、' + fail + ' 失效' : ''}`, fail > 0 ? 'error' : 'success');
                }
            } catch (e) { this.toast2('检查失败：' + e.message, 'error'); } finally { this.loading.health = false; }
        },
        async delAcc(idx) {
            if (!confirm(`确定删除账号 #${idx + 1}？`)) return;
            try {
                const r = await fetch(`/api/accounts/${idx}`, { method: 'DELETE' });
                const d = await r.json();
                d.ok ? (this.toast2('账号已删除', 'success'), await this.loadAccounts()) : this.toast2('删除失败', 'error');
            } catch { this.toast2('删除失败', 'error'); }
        },
        /* ── token refresh ── */
        async loadRefreshStatus() {
            try {
                const r = await fetch('/api/accounts/refresh-status');
                if (r.ok) this.refreshStatus = await r.json();
            } catch {}
        },
        async manualRefreshTokens() {
            this.loading.refreshTokens = true;
            this.toast2('正在刷新所有账号 token…', 'info');
            try {
                const r = await fetch('/api/accounts/refresh-tokens', { method: 'POST' });
                const d = await r.json();
                if (r.ok && d.ok) {
                    const s = d.summary;
                    this.toast2(`刷新完成：${s.ok} 成功、${s.fail} 失败、${s.skipped} 跳过`, s.fail > 0 ? 'error' : 'success');
                    await this.loadRefreshStatus();
                    await this.loadAccounts();
                } else {
                    this.toast2('刷新失败：' + (d.error || ''), 'error');
                }
            } catch (e) { this.toast2('刷新失败：' + e.message, 'error'); } finally { this.loading.refreshTokens = false; }
        },

        /* ── batch import ── */
        async submitBatchImport() {
            const tokens = this.batchImportText
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean);
            if (tokens.length === 0) {
                this.toast2('请输入或上传 Refresh Tokens', 'error');
                return;
            }
            this.loading.batchImport = true;
            this.batchImportResults = null;
            try {
                const r = await fetch('/api/accounts/batch-import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refreshTokens: tokens }),
                });
                const d = await r.json();
                if (r.ok && d.ok) {
                    this.toast2(`成功导入：新增 ${d.imported} 个，更新 ${d.updated || 0} 个，共 ${d.total} 个`, 'success');
                    this.batchImportResults = d.results;
                    this.batchImportText = '';
                    await this.loadAccounts();
                } else {
                    this.toast2('导入失败：' + (d.error || '未知'), 'error');
                }
            } catch (e) {
                this.toast2('导入失败：' + e.message, 'error');
            } finally {
                this.loading.batchImport = false;
            }
        },
        handleBatchImportFile(event) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target.result;
                this.batchImportText = text;
                this.toast2('文本读取成功，已填充至输入框', 'success');
            };
            reader.readAsText(file);
        },

        /* ── utils ── */
        getAccName(idx) {
            const a = this.accounts.find(x => x.index === idx);
            return a ? (a.name || `账号 ${idx + 1}`) : `账号 ${idx + 1}`;
        },
        getAccountUsage(account) {
            return this.usageData.find(u => u.accountIdMask && u.accountIdMask === account.accountIdMask);
        },
        quotaResetLabel(timestamp) {
            if (!timestamp) return '';
            const value = typeof timestamp === 'number' && timestamp < 1e12 ? timestamp * 1000 : timestamp;
            const date = new Date(value);
            return Number.isNaN(date.getTime())
                ? ''
                : '重置 ' + date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        },
        modelStatusLabel(model) {
            if (model.available === true) return '可用';
            if (model.available === false) return '不可用';
            return '探测中';
        },
        modelReasonLabel(reason) {
            const labels = {
                model_not_found: '模型不存在或不支持',
                auth_failed: '认证失败',
                token_invalidated: 'Token 已失效',
                timeout: '探测超时',
                network_error: '网络错误',
                no_healthy_account: '没有可用账号',
                not_probed: '尚未探测',
            };
            return reason ? (labels[reason] || reason) : '—';
        },
        formatTok(n) {
            if (!n) return '0';
            if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
            return String(n);
        },
        fmtTime(iso, full = false) {
            if (!iso) return '—';
            const d = new Date(iso);
            if (isNaN(d)) return '—';
            const diff = (Date.now() - d) / 1000;
            if (full) return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            if (diff < 60) return Math.round(diff) + '秒前';
            if (diff < 3600) return Math.round(diff / 60) + '分钟前';
            if (diff < 86400) return Math.round(diff / 3600) + '小时前';
            return d.toLocaleDateString('zh-CN');
        },
        async copyTxt(txt) {
            try { await navigator.clipboard.writeText(txt); this.toast2('已复制', 'success'); } catch { this.toast2('复制失败', 'error'); }
        },
        async copyImageCommand() {
            try {
                await navigator.clipboard.writeText(this.imageCurlExample);
                this.imageCopied = true;
                this.toast2('图片生成命令已复制', 'success');
                setTimeout(() => { this.imageCopied = false; }, 2000);
            } catch {
                this.toast2('复制失败', 'error');
            }
        },
        toast2(msg, type = 'info') {
            this.toast = { msg, type };
            if (this._tt) clearTimeout(this._tt);
            this._tt = setTimeout(() => { this.toast = null; }, 3000);
        },
    };
}
