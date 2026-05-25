#!/usr/bin/env node
/**
 * OpenAI 注册流程探索器
 *
 * 用 CloakBrowser（stealth Chromium）打开 OpenAI 注册页，交互式记录每一步。
 * 你在浏览器里手动操作，在终端按 ENTER 拍快照 → 自动写入文档。
 *
 * 输出：
 *   docs/openai-signup-flow.md     · 完整的流程文档（URL、选择器、备注）
 *   docs/signup-shots/step-NNN.png · 每步截图
 *
 * 指令：
 *   ENTER         拍当前页快照（自动提取所有可交互元素 + 截图）
 *   n <文字>      添加备注后拍快照
 *   rent          租 HeroSMS 临时手机号（读取 data/config.json）
 *   code          轮询 HeroSMS 短信验证码
 *   inbox         检查临时邮箱新邮件
 *   email         打印当前临时邮箱
 *   url           打印当前页面 URL
 *   q             退出并关闭浏览器（自动释放手机号）
 *
 * 使用前请先安装：npm install
 */
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOC_PATH = join(ROOT, 'docs', 'openai-signup-flow.md');
const SHOT_DIR = join(ROOT, 'docs', 'signup-shots');
const CONFIG_PATH = join(ROOT, 'data', 'config.json');

// ── 配置加载 ──
function loadCfg() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}
const cfg = loadCfg();
const EMAIL_BASE = (process.env.EMAIL_SERVICE_URL || 'https://free.violetteam.cloud').replace(/\/$/, '');

// ── HeroSMS（SMS-Activate 兼容协议） ──
const SMS_BASE = 'https://api.hero-sms.com/stubs/handler_api.php';
async function smsApi(params, apiKey) {
  const u = new URL(SMS_BASE);
  u.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u.toString());
  return (await r.text()).trim();
}

// ── 临时邮箱 ──
function randLocal(n = 10) {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += c.charAt(Math.floor(Math.random() * c.length));
  return s;
}
async function genEmail() {
  let domains = ['free.violetteam.cloud', 'kami666.xyz'];
  try {
    const r = await fetch(`${EMAIL_BASE}/api/domains`);
    if (r.ok) {
      const d = await r.json();
      const list = (d.domains || [])
        .map((x) => (x.name || (x.api || '').replace(/^https?:\/\//, '').split('/')[0]).trim())
        .filter(Boolean);
      if (list.length) domains = list;
    }
  } catch {}
  return `${randLocal(10)}@${domains[Math.floor(Math.random() * domains.length)]}`;
}
async function checkEmailInbox(email) {
  try {
    const r = await fetch(`${EMAIL_BASE}/api/emails/${encodeURIComponent(email)}`);
    if (!r.ok) return [];
    const d = await r.json();
    return d.emails || [];
  } catch { return []; }
}

// ── 状态 ──
let stepNum = 0;
let currentEmail = null;
let currentPhone = null;
let smsId = null;

// ── 初始化文档与目录 ──
if (!existsSync(dirname(DOC_PATH))) mkdirSync(dirname(DOC_PATH), { recursive: true });
if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

async function initDoc() {
  currentEmail = await genEmail();
  const header = `# OpenAI 注册流程探索文档

> 由 \`scripts/explore-signup.js\` 自动生成
> 生成时间: ${new Date().toLocaleString('zh-CN')}
> 浏览器: CloakBrowser (stealth Chromium)

## 探索元数据

- 临时邮箱: \`${currentEmail}\`
- 邮箱服务: \`${EMAIL_BASE}\`
- HeroSMS: \`${cfg.hero_sms_api_key ? '已配置 (国家=' + (cfg.hero_sms_country || '0') + ')' : '未配置'}\`

## 用法说明

每个步骤记录：当前 URL、页面标题、所有可见的输入框/按钮/链接（含 CSS 选择器）、截图。
末尾的"手动事件"块记录用户在终端触发的辅助操作（生成邮箱、租号、收码）。

---
`;
  writeFileSync(DOC_PATH, header);
  appendFileSync(DOC_PATH, `\n> **手动事件**: 生成临时邮箱 \`${currentEmail}\`\n\n`);
}

async function capture(page, note = '手动快照') {
  stepNum++;
  const url = page.url();
  const title = await page.title().catch(() => '');
  const shotFile = `step-${String(stepNum).padStart(3, '0')}.png`;
  const shotPath = join(SHOT_DIR, shotFile);

  try {
    await page.screenshot({ path: shotPath, fullPage: false });
  } catch (e) {
    console.log('截图失败:', e.message);
  }

  // 提取可交互元素
  const elements = await page.evaluate(() => {
    function bestSelector(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const tid = el.getAttribute('data-testid');
      if (tid) return `[data-testid="${tid}"]`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
      const aria = el.getAttribute('aria-label');
      if (aria) return `[aria-label="${aria}"]`;
      const t = (el.innerText || '').trim().slice(0, 30);
      if (t && ['BUTTON', 'A'].includes(el.tagName)) return `text="${t}"`;
      return '';
    }
    const out = [];
    document
      .querySelectorAll('input, select, textarea, button, a[role="button"], [role="button"], a[href]')
      .forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || el.getAttribute('role') || '',
          name: el.name || '',
          id: el.id || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          placeholder: el.placeholder || '',
          text: (el.innerText || el.value || '').trim().slice(0, 60).replace(/\s+/g, ' '),
          selector: bestSelector(el),
          required: !!el.required,
          href: el.href || '',
        });
      });
    return out;
  }).catch(() => []);

  // 验证码 iframe 检测
  const captcha = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('iframe'))
      .map((f) => f.src || '')
      .filter((s) => /arkose|recaptcha|hcaptcha|turnstile|funcaptcha|client-api/i.test(s));
  }).catch(() => []);

  const lines = [
    `## 步骤 ${stepNum} · ${note}`,
    ``,
    `- **时间**: ${new Date().toLocaleString('zh-CN')}`,
    `- **URL**: \`${url}\``,
    `- **标题**: ${title || '(无)'}`,
    `- **截图**: \`docs/signup-shots/${shotFile}\``,
  ];
  if (captcha.length) {
    lines.push(`- **⚠️ 验证码 iframe**: ${captcha.map((s) => '`' + s + '`').join(', ')}`);
  }
  if (elements.length) {
    lines.push(``, `### 可交互元素 (${elements.length})`, ``);
    lines.push('| Tag | Type | Selector | Name/ID | Aria/Placeholder | 文本 |');
    lines.push('|---|---|---|---|---|---|');
    for (const e of elements) {
      const sel = (e.selector || '(无)').replace(/\|/g, '\\|');
      const ph = (e.ariaLabel || e.placeholder || '—').replace(/\|/g, '\\|');
      const nm = (e.name || e.id || '—').replace(/\|/g, '\\|');
      const tx = (e.text || '—').replace(/\|/g, '\\|');
      lines.push(`| ${e.tag} | ${e.type || '—'} | \`${sel}\` | ${nm} | ${ph} | ${tx} |`);
    }
  }
  lines.push('', '---', '');
  appendFileSync(DOC_PATH, lines.join('\n'));
  console.log(`[✓] 步骤 ${stepNum} 已记录  · ${elements.length} 个元素${captcha.length ? `  · ⚠️ ${captcha.length} 个验证码 iframe` : ''}`);
  return { url, elements, captcha };
}

async function rentNumber() {
  if (!cfg.hero_sms_api_key) {
    console.log('❌ 未配置 HeroSMS API Key（请先在前端 /设置 页填写）');
    return;
  }
  console.log('正在租用 OpenAI 可用号码 (service=oi)...');
  const r = await smsApi({ action: 'getNumber', service: 'oi', country: cfg.hero_sms_country || '0' }, cfg.hero_sms_api_key);
  if (r.startsWith('ACCESS_NUMBER:')) {
    const parts = r.split(':');
    smsId = parts[1];
    currentPhone = parts[2];
    console.log(`✓ 已获取号码: +${currentPhone}  (id=${smsId})`);
    appendFileSync(DOC_PATH, `\n> **手动事件**: 租用 SMS 号码 \`+${currentPhone}\` (HeroSMS id=${smsId})\n\n`);
  } else {
    console.log('❌ 租用失败:', r);
  }
}

async function pollSmsCmd() {
  if (!smsId) { console.log('❌ 还没租号，先执行 "rent"'); return; }
  console.log('轮询 SMS 验证码 (60s 超时)...');
  for (let i = 0; i < 12; i++) {
    const r = await smsApi({ action: 'getStatus', id: smsId }, cfg.hero_sms_api_key);
    if (r.startsWith('STATUS_OK:')) {
      const code = r.split(':')[1];
      console.log(`✓ 收到 SMS: ${code}`);
      appendFileSync(DOC_PATH, `\n> **手动事件**: 收到 SMS 验证码 \`${code}\`\n\n`);
      return;
    }
    console.log(`  [${i + 1}/12] ${r}`);
    await new Promise((res) => setTimeout(res, 5000));
  }
  console.log('❌ 超时未收到 SMS');
}

async function inboxCmd() {
  if (!currentEmail) { console.log('还没生成邮箱'); return; }
  const list = await checkEmailInbox(currentEmail);
  console.log(`📬 邮箱 ${currentEmail}: ${list.length} 封邮件`);
  for (const m of list.slice(0, 5)) {
    const text = [m.subject, m.text, m.html, m.body].filter(Boolean).join(' ');
    const code = m.verificationCode || (text.match(/\b(\d{6})\b/) || [])[1];
    console.log(`  · ${m.subject || '(无主题)'} from ${m.from || '?'}${code ? `  → 验证码 ${code}` : ''}`);
    if (code) appendFileSync(DOC_PATH, `\n> **手动事件**: 邮箱验证码 \`${code}\` (来自 \`${m.from || '?'}\`)\n\n`);
  }
}

async function main() {
  // 动态导入 cloakbrowser（可选依赖，未装时给出清晰错误）
  let launch;
  try {
    const mod = await import('cloakbrowser');
    launch = mod.launch;
  } catch (e) {
    console.error('❌ 未安装 cloakbrowser。请先执行：');
    console.error('   npm install cloakbrowser playwright-core');
    console.error('（首次运行会自动下载约 200MB stealth Chromium 二进制）');
    process.exit(1);
  }

  await initDoc();
  console.log(`✓ 已生成临时邮箱: ${currentEmail}`);
  console.log('启动 CloakBrowser（首次会下载二进制）...');

  const launchOpts = { headless: false, humanize: true };
  // 支持环境变量传入代理：CLOAK_PROXY="http://user:pass@host:port" 或 socks5://...
  if (process.env.CLOAK_PROXY) {
    launchOpts.proxy = process.env.CLOAK_PROXY;
    console.log(`  使用代理: ${process.env.CLOAK_PROXY.replace(/:\/\/[^@]*@/, '://***@')}`);
  }
  const browser = await launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();

  try {
    await page.goto('https://auth.openai.com/create-account', { waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.log('初始导航警告:', e.message);
  }
  await page.waitForTimeout(2500);
  await capture(page, '初始页面（OpenAI create-account）');

  const rl = readline.createInterface({ input, output });
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  CloakBrowser 探索器已就绪                                    ║
╠═══════════════════════════════════════════════════════════════╣
║  ENTER         拍当前页快照                                   ║
║  n <文字>      加备注拍快照（例：n 输入邮箱后）                ║
║  rent          租 HeroSMS 临时号                              ║
║  code          轮询 SMS 验证码                                ║
║  inbox         检查邮箱（找到验证码会自动记录）                ║
║  email         打印当前临时邮箱                               ║
║  url           打印当前 URL                                   ║
║  q             退出并自动释放手机号                           ║
╚═══════════════════════════════════════════════════════════════╝
  当前邮箱: ${currentEmail}
  文档输出: ${DOC_PATH}
`);

  while (true) {
    let cmd;
    try { cmd = (await rl.question('> ')).trim(); }
    catch { break; }

    if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') break;
    if (cmd === '') {
      try { await capture(page); } catch (e) { console.log('错误:', e.message); }
      continue;
    }
    if (cmd === 'rent') { await rentNumber().catch((e) => console.log('错误:', e.message)); continue; }
    if (cmd === 'code') { await pollSmsCmd().catch((e) => console.log('错误:', e.message)); continue; }
    if (cmd === 'inbox') { await inboxCmd().catch((e) => console.log('错误:', e.message)); continue; }
    if (cmd === 'email') { console.log(currentEmail); continue; }
    if (cmd === 'url') { console.log(page.url()); continue; }
    if (/^(n|note)\s+/.test(cmd)) {
      const note = cmd.replace(/^(n|note)\s+/, '').trim();
      try { await capture(page, note); } catch (e) { console.log('错误:', e.message); }
      continue;
    }
    console.log('未知指令。可用：ENTER · n <文字> · rent · code · inbox · email · url · q');
  }

  rl.close();
  if (smsId && cfg.hero_sms_api_key) {
    console.log('释放 SMS 号码...');
    try { await smsApi({ action: 'setStatus', id: smsId, status: 8 }, cfg.hero_sms_api_key); } catch {}
  }
  try { await browser.close(); } catch {}
  console.log(`\n✓ 探索完成！文档: ${DOC_PATH}`);
  console.log('  请通读文档确认所有步骤都已记录，然后告诉我，我会基于此写自动化脚本。');
}

main().catch((e) => { console.error('致命错误:', e); process.exit(1); });
