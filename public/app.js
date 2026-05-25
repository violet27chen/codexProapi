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
        logs: [],
        cfg: { api_key: '', token_refresh_interval_minutes: 60 },
        refreshStatus: { active: false, intervalMinutes: 60, lastRun: 0, lastSummary: null, isRefreshing: false },
        showKey: false,
        showAdd: false,
        af: { mode: 'json', name: '', authJson: '', access_token: '', account_id: '', proxy: '' },
        showBatchImport: false,
        batchImportText: '',
        batchImportResults: null,
        lf: 'all',
        showBindProxy: false,
        proxyEditIndex: null,
        proxyEditUrl: '',
        loading: { usage: false, logs: false, models: false, health: false, addAcc: false, settings: false, refreshTokens: false, batchImport: false, bindProxy: false },
        toast: null,
        _tt: null,
        endpoints: [
            { m: 'POST', path: '/v1/chat/completions', desc: '对话补全' },
            { m: 'POST', path: '/v1/images/generations', desc: '图片生成' },
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
        get todayReqs() {
            const d = new Date().toISOString().slice(0, 10);
            return this.logs.filter(l => l.type === 'request' && l.time && l.time.startsWith(d)).length;
        },
        get totalTokens() {
            return this.usageData.reduce((s, u) => s + (u.used_tokens || 0), 0);
        },
        get curlExample() {
            const k = this.cfg.api_key;
            const auth = k ? `\n  -H "Authorization: Bearer ${k}" \\` : '';
            return `curl http://localhost:1455/v1/chat/completions \\
  -H "Content-Type: application/json" \\${auth}
  -d '{"model":"gpt-5.3-codex","messages":[{"role":"user","content":"你好"}]}'`;
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
            ]);
            this.handleOAuth();
            this.loadRefreshStatus();
            setInterval(() => {
                if (this.page === 'logs' || this.page === 'dashboard') this.loadLogs();
            }, 10000);
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
            try { this.usageData = (await (await fetch('/api/usage')).json()).accounts || []; } catch {} finally { this.loading.usage = false; }
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
            } catch {} finally { this.loading.models = false; }
        },
        async doRefreshModels() {
            this.loading.models = true;
            this.toast2('探测进行中，需 10-30 秒…', 'info');
            try {
                const r = await fetch('/api/models/refresh', { method: 'POST' });
                const d = await r.json();
                if (r.ok) {
                    this.models = d.models || [];
                    this.modelsLastProbed = d.lastProbed || 0;
                    const ok = this.models.filter(m => m.available === true).length;
                    this.toast2(`探测完成：${ok}/${this.models.length} 可用`, 'success');
                } else {
                    this.toast2('探测失败：' + (d.error || ''), 'error');
                }
            } catch (e) { this.toast2('探测失败：' + e.message, 'error'); } finally { this.loading.models = false; }
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
            this.af = { mode: 'json', name: '', authJson: '', access_token: '', account_id: '', proxy: '' };
        },
        async submitAdd() {
            this.loading.addAcc = true;
            try {
                let body;
                if (this.af.mode === 'json') {
                    if (!this.af.authJson.trim()) { this.toast2('请粘贴 auth.json 内容', 'error'); return; }
                    body = { name: this.af.name || undefined, authJson: this.af.authJson, proxy: this.af.proxy || undefined };
                } else {
                    if (!this.af.access_token || !this.af.account_id) { this.toast2('请填写 Token 和 Account ID', 'error'); return; }
                    body = { name: this.af.name || undefined, access_token: this.af.access_token, account_id: this.af.account_id, proxy: this.af.proxy || undefined };
                }
                const r = await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const d = await r.json();
                if (r.ok && d.ok) { this.toast2('账号添加成功', 'success'); this.showAdd = false; await this.loadAccounts(); }
                else this.toast2('添加失败：' + (d.error || '未知'), 'error');
            } catch (e) { this.toast2('添加失败：' + e.message, 'error'); } finally { this.loading.addAcc = false; }
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
        editProxy(idx, currentProxy) {
            this.proxyEditIndex = idx;
            this.proxyEditUrl = currentProxy || '';
            this.showBindProxy = true;
        },
        async submitBindProxy() {
            if (this.proxyEditIndex === null) return;
            this.loading.bindProxy = true;
            try {
                const r = await fetch(`/api/accounts/${this.proxyEditIndex}/proxy`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ proxy: this.proxyEditUrl }),
                });
                const d = await r.json();
                if (r.ok && d.ok) {
                    this.toast2('代理绑定成功', 'success');
                    this.showBindProxy = false;
                    await this.loadAccounts();
                } else {
                    this.toast2('修改失败：' + (d.error || '未知'), 'error');
                }
            } catch (e) {
                this.toast2('修改失败：' + e.message, 'error');
            } finally {
                this.loading.bindProxy = false;
            }
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
                    this.toast2(`成功导入 ${d.imported}/${d.total} 个账号`, 'success');
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
        toast2(msg, type = 'info') {
            this.toast = { msg, type };
            if (this._tt) clearTimeout(this._tt);
            this._tt = setTimeout(() => { this.toast = null; }, 3000);
        },
    };
}
