/**
 * 知忆 Zhiyi · 模型配置页（挂载于网关 /settings 端点）。
 * 统一管理面向 Agent 客户端调用的主对话模型（Proxy 组）与后台记忆提取处理模型（Memory 组），
 * 提供实时通路预检与 Agent 接入指引。
 */
import { PROVIDER_PRESETS } from './model-settings';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const INITIAL_PRESETS_HTML: string = PROVIDER_PRESETS
  .filter((p) => ['deepseek', 'openai', 'anthropic', 'custom'].includes(p.id))
  .map(
    (p) =>
      `<button type="button" class="preset-card" data-preset-id="${escapeHtml(p.id)}">
        <div class="preset-badge">${escapeHtml(p.upstreamProtocol === 'anthropic_messages' ? 'Anthropic' : 'OpenAI')}</div>
        <div class="preset-name">${escapeHtml(p.label)}</div>
        <div class="preset-desc">${escapeHtml(p.description)}</div>
      </button>`,
  )
  .join('');

export const SETTINGS_PAGE_HTML: string = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>知忆 Zhiyi · 模型配置</title>
<style>
:root{
  color-scheme:light;
  --ink:#0f172a;
  --ink-soft:#334155;
  --muted:#64748b;
  --line:#e2e8f0;
  --soft:#f8fafc;
  --bg:#f1f5f9;
  --card:#ffffff;
  --accent:#2563eb;
  --accent-hover:#1d4ed8;
  --accent-soft:#eff6ff;
  --accent-line:#bfdbfe;
  --ok:#059669;
  --ok-soft:#ecfdf5;
  --ok-line:#a7f3d0;
  --bad:#dc2626;
  --bad-soft:#fef2f2;
  --bad-line:#fecaca;
  --warn:#d97706;
  --warn-soft:#fffbeb;
  --warn-line:#fde68a;
  --shadow-sm:0 1px 3px rgba(15,23,42,.05);
  --shadow-md:0 4px 12px -2px rgba(15,23,42,.08),0 2px 6px -1px rgba(15,23,42,.04);
  --shadow-pop:0 16px 40px -8px rgba(15,23,42,.16),0 4px 12px -2px rgba(15,23,42,.06);
  --ease:cubic-bezier(.22,1,.36,1);
  --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
}
*{box-sizing:border-box}
body{
  margin:0;
  background:var(--bg);
  color:var(--ink);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1160px;margin:0 auto;padding:28px 24px 64px}

/* 顶部导航与状态栏 */
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px}
.logo-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#2563eb,#3b82f6);display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;font-weight:700;box-shadow:0 4px 10px rgba(37,99,235,.28)}
.title-group h1{font-size:20px;font-weight:700;margin:0;letter-spacing:-0.015em}
.title-group .sub{color:var(--muted);font-size:13px;margin-top:2px}
.top-actions{display:flex;align-items:center;gap:10px}
.status-pill{display:inline-flex;align-items:center;gap:7px;padding:6px 14px;border-radius:999px;font-size:12.5px;font-weight:500;background:#fff;color:var(--ink-soft);border:1px solid var(--line);box-shadow:var(--shadow-sm)}
.status-pill .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);transition:background .2s}
.status-pill.bad .dot{background:var(--bad)}
.status-pill.warn .dot{background:var(--warn)}

/* 布局体系 */
.layout{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:22px;align-items:start}
@media (max-width:960px){.layout{grid-template-columns:1fr}}
.sidebar{position:sticky;top:20px;display:flex;flex-direction:column;gap:16px}
@media (max-width:960px){.sidebar{position:static}}

/* 卡片基础规范 */
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:var(--shadow-sm);transition:box-shadow .2s var(--ease);margin-bottom:18px}
.card:last-child{margin-bottom:0}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
.card-head-title{display:flex;align-items:center;gap:10px}
.card-head h2{font-size:15.5px;font-weight:700;margin:0;color:var(--ink)}
.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;background:var(--soft);color:var(--muted);border:1px solid var(--line)}
.badge.accent{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-line)}
.badge.ok{background:var(--ok-soft);color:var(--ok);border-color:var(--ok-line)}
.hint-inline{font-size:12px;color:var(--muted)}

/* 常用预设网格 */
.presets-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (max-width:600px){.presets-grid{grid-template-columns:1fr}}
.preset-card{
  text-align:left;padding:12px 14px;border:1px solid var(--line);border-radius:12px;
  background:var(--soft);cursor:pointer;color:var(--ink);position:relative;
  transition:all .16s var(--ease)
}
.preset-card:hover{border-color:var(--accent-line);background:var(--accent-soft);transform:translateY(-1px);box-shadow:var(--shadow-sm)}
.preset-card:active{transform:translateY(0) scale(.99)}
.preset-card.active{border-color:var(--accent);background:var(--accent-soft);box-shadow:0 0 0 1px var(--accent)}
.preset-badge{font-size:10px;font-weight:600;text-transform:uppercase;color:var(--muted);margin-bottom:3px}
.preset-name{font-size:13px;font-weight:700;color:var(--ink);margin-bottom:3px}
.preset-desc{font-size:11.5px;color:var(--muted);line-height:1.4}

/* 表单字段 */
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:600px){.form-grid{grid-template-columns:1fr}}
.col-span-2{grid-column:1 / -1}
.field-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.field-header .field-label{margin-bottom:0}
.btn-fetch-models{
  display:inline-flex;align-items:center;gap:4px;background:transparent;border:none;
  color:var(--accent);font-size:12px;font-weight:600;cursor:pointer;padding:2px 6px;border-radius:6px;
  transition:all .15s var(--ease)
}
.btn-fetch-models:hover{background:var(--accent-soft);color:var(--accent-hover)}
.btn-fetch-models:disabled{color:var(--muted);cursor:not-allowed;opacity:.7}
.btn-fetch-models svg{transition:transform .3s var(--ease)}
.btn-fetch-models.loading svg{animation:spin 1s linear infinite}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.model-picker-wrap{display:flex;flex-direction:column;gap:6px}
.field-label{display:block;font-size:12.5px;font-weight:600;color:var(--ink-soft);margin-bottom:6px}
.field-tip{font-size:11.5px;font-weight:400;color:var(--muted);margin-top:4px}
.input-wrap{position:relative;display:flex;align-items:center}
input.input,select.select{
  width:100%;height:40px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;
  background:#fff;color:var(--ink);font-size:13px;line-height:1.4;outline:none;
  transition:border-color .15s,box-shadow .15s
}
input.mono{font-family:var(--mono)}
input.input:focus,select.select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.input-btn{
  position:absolute;right:8px;height:26px;padding:0 8px;border-radius:6px;border:none;
  background:transparent;color:var(--muted);cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center
}
.input-btn:hover{color:var(--ink);background:var(--soft)}

/* 复选框与折叠区域 */
.reuse-banner{
  display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;
  border-radius:10px;background:var(--accent-soft);border:1px solid var(--accent-line);margin-bottom:10px
}
.checkbox-label{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--ink);cursor:pointer}
.checkbox-label input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent);cursor:pointer}
.reuse-summary{
  font-size:12.5px;color:var(--ink-soft);padding:10px 14px;background:var(--soft);
  border-radius:10px;border:1px solid var(--line);margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap
}
.memory-form-collapse{overflow:hidden;transition:all .22s var(--ease)}
.memory-form-collapse.collapsed{display:none}

/* 按钮规范 */
.btn-primary{
  width:100%;height:42px;border:none;border-radius:10px;background:var(--accent);color:#fff;
  font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;
  transition:all .15s var(--ease);box-shadow:0 2px 6px rgba(37,99,235,.2)
}
.btn-primary:hover{background:var(--accent-hover);transform:translateY(-1px);box-shadow:0 4px 12px rgba(37,99,235,.28)}
.btn-primary:active{transform:translateY(0) scale(.99)}
.btn-row{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:8px}
.btn-secondary{
  height:38px;padding:0 12px;border:1px solid var(--line);border-radius:9px;background:#fff;
  color:var(--ink);font-size:13px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  transition:all .14s var(--ease)
}
.btn-secondary:hover{border-color:#94a3b8;background:var(--soft);transform:translateY(-1px)}
.btn-secondary:active{transform:scale(.99)}
.btn-danger-link{
  width:100%;margin-top:8px;background:transparent;border:none;padding:6px;color:var(--muted);
  font-size:12px;cursor:pointer;text-align:center;transition:color .14s
}
.btn-danger-link:hover{color:var(--bad);text-decoration:underline}

/* 通路预检诊断面板 */
.diag-panel{border:1px solid var(--line);border-radius:12px;background:var(--soft);padding:14px;margin-top:14px}
.diag-group{margin-bottom:12px}
.diag-group:last-child{margin-bottom:0}
.diag-group-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.diag-title{font-size:12.5px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:6px}
.diag-badge{font-size:11px;padding:2px 7px;border-radius:999px;font-weight:600}
.diag-badge.ok{background:var(--ok-soft);color:var(--ok);border:1px solid var(--ok-line)}
.diag-badge.bad{background:var(--bad-soft);color:var(--bad);border:1px solid var(--bad-line)}
.diag-badge.warn{background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn-line)}
.diag-detail{font-size:12px;color:var(--muted);line-height:1.5;background:#fff;padding:8px 10px;border-radius:8px;border:1px solid var(--line);word-break:break-all}
.chat-bubble{background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:10px;padding:10px 12px;font-size:12.5px;color:var(--ink);margin-top:8px}

/* 快速接入指引代码卡片 */
.guide-code-box{background:#0f172a;border-radius:10px;padding:12px;color:#f8fafc;font-family:var(--mono);font-size:12px;margin:8px 0;position:relative}
.guide-code-box pre{margin:0;overflow-x:auto}
.copy-pill{
  position:absolute;top:8px;right:8px;height:24px;padding:0 8px;border-radius:6px;border:none;
  background:rgba(255,255,255,.14);color:#e2e8f0;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:4px;
  transition:all .14s
}
.copy-pill:hover{background:rgba(255,255,255,.24);color:#fff}
.copy-pill.copied{background:var(--ok);color:#fff}

/* 状态概览键值清单 */
.status-list{display:grid;gap:8px;font-size:12.5px}
.status-row{display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid #f1f5f9}
.status-row:last-child{padding-bottom:0;border-bottom:none}
.status-k{color:var(--muted)}
.status-v{font-weight:600;font-family:var(--mono);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* 悬浮 Toast 与模态弹窗 */
.toast-stack{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:200;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.toast{
  pointer-events:auto;display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:12px;
  background:rgba(15,23,42,.92);color:#fff;font-size:13px;font-weight:500;box-shadow:var(--shadow-pop);
  animation:toastIn .24s var(--ease) forwards
}
.toast.ok{background:rgba(6,95,70,.95)}
.toast.bad{background:rgba(153,27,27,.95)}
.toast.leaving{animation:toastOut .2s ease forwards}
@keyframes toastIn{from{opacity:0;transform:translateY(-8px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes toastOut{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-6px)}}

.modal-backdrop{
  position:fixed;inset:0;z-index:180;display:flex;align-items:center;justify-content:center;padding:20px;
  background:rgba(15,23,42,.45);opacity:0;pointer-events:none;transition:opacity .2s ease
}
.modal-backdrop.open{opacity:1;pointer-events:auto}
.modal-card{width:100%;max-width:380px;background:#fff;border-radius:16px;padding:22px;box-shadow:var(--shadow-pop)}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
.modal-actions button{height:36px;padding:0 14px;border-radius:8px;font-size:13px;cursor:pointer}
</style>
</head>
<body>
<div class="toast-stack" id="toastStack"></div>

<div class="modal-backdrop" id="resetModal">
  <div class="modal-card">
    <h3 style="margin:0 0 8px;font-size:16px">恢复默认配置</h3>
    <p style="margin:0;font-size:13px;color:var(--muted);line-height:1.5">将清空当前自定义设置，回退到环境变量 .env 配置，确定继续吗？</p>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="cancelReset">取消</button>
      <button type="button" class="btn-primary" style="background:var(--bad);box-shadow:none" id="confirmReset">确认恢复</button>
    </div>
  </div>
</div>

<div class="wrap">
  <header class="topbar">
    <div class="brand">
      <div class="logo-icon">知</div>
      <div class="title-group">
        <h1>知忆 Zhiyi · 模型配置</h1>
        <div class="sub">统一配置面向 Agent 客户端调用的主对话模型（Proxy 组）与后台记忆提取处理模型（Memory 组）</div>
      </div>
    </div>
    <div class="top-actions">
      <span class="status-pill" id="gatewayStatusBadge"><i class="dot"></i><span>网关读取中…</span></span>
    </div>
  </header>

  <div class="layout">
    <main>
      <!-- 常用提供商快捷预设 -->
      <section class="card">
        <div class="card-head">
          <div class="card-head-title">
            <h2>常用模型服务商预设</h2>
            <span class="badge accent">一键填入</span>
          </div>
          <span class="hint-inline">点击自动填充 API 端点、出站协议与推荐模型</span>
        </div>
        <div class="presets-grid" id="presetsGrid">
          ${INITIAL_PRESETS_HTML}
        </div>
      </section>

      <!-- Proxy 组：面向用户/Agent 的主对话模型 -->
      <section class="card">
        <div class="card-head">
          <div class="card-head-title">
            <h2>主对话模型 (Proxy 组)</h2>
            <span class="badge accent">客户端与 Agent 转发</span>
          </div>
          <span class="hint-inline">Claude Code / Cursor / OpenCode / Web 对话使用的模型</span>
        </div>

        <div class="form-grid">
          <div class="col-span-2">
            <label class="field-label" for="proxyBaseUrl">API 接口地址（Base URL）</label>
            <input class="input mono" id="proxyBaseUrl" placeholder="例如 https://api.deepseek.com/v1 或 https://api.openai.com/v1" autocomplete="off">
            <div class="field-tip">上游 OpenAI 兼容或官方接口地址，以 http(s):// 开头</div>
          </div>

          <div class="col-span-2" id="proxyApiKeyContainer">
            <label class="field-label" for="proxyApiKey">API Key / 接口密钥</label>
            <div class="input-wrap">
              <input class="input" id="proxyApiKey" type="password" placeholder="sk-... 或留空保持当前已保存的 Key" autocomplete="new-password">
              <button type="button" class="input-btn" id="toggleApiKey">显示</button>
            </div>
            <div class="field-tip" id="proxyApiKeyTip">密钥保存在本机本地网关，不向外部泄露</div>
          </div>

          <div class="col-span-2">
            <div class="field-header">
              <label class="field-label" for="proxyModelSelect">主模型 ID</label>
              <button type="button" class="btn-fetch-models" id="btnFetchProxyModels" title="从 API 拉取实时可用模型列表">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                <span>拉取模型列表</span>
              </button>
            </div>
            <div class="model-picker-wrap">
              <select class="select mono" id="proxyModelSelect"></select>
              <input class="input mono" id="proxyModel" placeholder="请输入自定义模型 ID，例如 deepseek-chat" autocomplete="off" style="display:none">
            </div>
            <div class="field-tip" id="proxyModelTip">选择上游服务的模型标识</div>
          </div>
        </div>

        <input type="hidden" id="proxyProtocol" value="auto">

        <div style="display:none" aria-hidden="true">
          <input type="checkbox" id="ducxReport" checked>
          <span>来源上报</span>
          <input class="input mono" id="ducxExecutable" autocomplete="off">
        </div>
      </section>

      <!-- Memory 组：知忆内部内核记忆处理模型 -->
      <section class="card">
        <div class="card-head">
          <div class="card-head-title">
            <h2>内核记忆模型 (Memory 组)</h2>
            <span class="badge">知忆推理与抽取引擎</span>
          </div>
          <span class="hint-inline">负责对话事实抽取、反思演进与元数据生成</span>
        </div>

        <div class="reuse-banner">
          <label class="checkbox-label">
            <input type="checkbox" id="memoryReuseProxy" checked>
            <span>复用 Proxy 组配置（默认推荐）</span>
          </label>
          <span class="badge ok" id="reuseBadge">已复用 Proxy 组</span>
        </div>

        <div class="reuse-summary" id="reuseSummary">
          <span style="color:var(--muted)">当前继承 Proxy 组：</span>
          <span>端点: <code class="mono" id="sumMemUrl" style="font-weight:600">-</code></span>
          <span>·</span>
          <span>模型: <code class="mono" id="sumMemModel" style="font-weight:600;color:var(--accent)">-</code></span>
        </div>

        <div class="memory-form-collapse collapsed" id="memoryCustomSection">
          <div class="form-grid">
            <div class="col-span-2">
              <label class="field-label" for="memBaseUrl">Memory 接口地址（Base URL）</label>
              <input class="input mono" id="memBaseUrl" placeholder="例如 https://api.deepseek.com/v1" autocomplete="off">
            </div>

            <div class="col-span-2" id="memApiKeyContainer">
              <label class="field-label" for="memApiKey">Memory API Key</label>
              <input class="input" id="memApiKey" type="password" placeholder="留空沿用主模型 Key" autocomplete="new-password">
            </div>

            <div class="col-span-2">
              <div class="field-header">
                <label class="field-label" for="memModelSelect">Memory 抽取模型 ID</label>
                <button type="button" class="btn-fetch-models" id="btnFetchMemModels" title="从 API 拉取实时可用模型列表">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                  <span>拉取模型列表</span>
                </button>
              </div>
              <div class="model-picker-wrap">
                <select class="select mono" id="memModelSelect"></select>
                <input class="input mono" id="memModel" placeholder="请输入自定义模型 ID，例如 deepseek-chat" autocomplete="off" style="display:none">
              </div>
              <div class="field-tip" id="memModelTip">推荐配置响应极速、性价比高的模型，加速后台记忆抽取</div>
            </div>
          </div>
          <input type="hidden" id="memProtocol" value="auto">
        </div>
      </section>
    </main>

    <!-- 侧边栏：操作、通路预检诊断与 Agent 接入指引 -->
    <aside class="sidebar">
      <!-- 操作与诊断卡片 -->
      <section class="card">
        <button type="button" class="btn-primary" id="btnSave">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          保存配置并生效
        </button>

        <div class="btn-row">
          <button type="button" class="btn-secondary" id="btnCheckHealth">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            LLM 通路预检
          </button>
          <button type="button" class="btn-secondary" id="btnTestChat">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            对话测试
          </button>
        </div>

        <button type="button" class="btn-danger-link" id="btnOpenReset">恢复默认配置 (.env)</button>

        <!-- 实时通路预检卡片 -->
        <div class="diag-panel" id="diagPanel">
          <div class="diag-group">
            <div class="diag-group-header">
              <span class="diag-title">Proxy 组通路 (主模型)</span>
              <span class="diag-badge ok" id="proxyDiagBadge">就绪</span>
            </div>
            <div class="diag-detail" id="proxyDiagDetail">点击「LLM 通路预检」即可测试端点连通性</div>
          </div>

          <div class="diag-group" style="margin-top:10px">
            <div class="diag-group-header">
              <span class="diag-title">Memory 组通路 (记忆模型)</span>
              <span class="diag-badge ok" id="memDiagBadge">复用主组</span>
            </div>
            <div class="diag-detail" id="memDiagDetail">复用主对话模型配置</div>
          </div>

          <div id="chatReplyBubble" class="chat-bubble" style="display:none"></div>
        </div>
      </section>

      <!-- Agent 快速接入指引 -->
      <section class="card">
        <div class="card-head">
          <div class="card-head-title">
            <h2>Agent 接入指引</h2>
            <span class="badge accent">8790 端口</span>
          </div>
        </div>
        <p style="font-size:12px;color:var(--muted);margin:0 0 8px">将 Agent 请求代理到知忆网关，自动沉淀长期记忆：</p>

        <div style="font-size:12px;font-weight:600;margin-top:8px">Claude Code 终端接入</div>
        <div class="guide-code-box">
          <button type="button" class="copy-pill" id="copyClaudeBtn">复制</button>
          <pre id="claudeCodeSnippet">export ANTHROPIC_BASE_URL="http://127.0.0.1:8790/v1"
claude --model &lt;当前主模型&gt;</pre>
        </div>

        <div style="font-size:12px;font-weight:600;margin-top:10px">OpenAI SDK / Python 接入</div>
        <div class="guide-code-box">
          <button type="button" class="copy-pill" data-copy="from openai import OpenAI&#10;client = OpenAI(base_url=&quot;http://127.0.0.1:8790/v1&quot;, api_key=&quot;zhiyi-local&quot;)">复制</button>
          <pre>from openai import OpenAI
client = OpenAI(
  base_url="http://127.0.0.1:8790/v1",
  api_key="zhiyi-local"
)</pre>
        </div>

        <div style="font-size:12px;font-weight:600;margin-top:10px">网页端对话体验 (ADP Chat)</div>
        <div style="margin-top:4px">
          <a href="http://127.0.0.1:5174" target="_blank" style="color:var(--accent);font-size:12.5px;font-weight:600;text-decoration:none">
            打开网页对话客户端 (http://127.0.0.1:5174) &rarr;
          </a>
        </div>
      </section>

      <!-- 当前生效状态概览 -->
      <section class="card">
        <div class="card-head">
          <div class="card-head-title">
            <h2>网关当前生效状态</h2>
          </div>
        </div>
        <div class="status-list" id="statusList">
          <div class="status-row"><span class="status-k">网关本地端口</span><span class="status-v">127.0.0.1:8790</span></div>
          <div class="status-row"><span class="status-k">Proxy 转发上游</span><span class="status-v" id="stProxyUrl">-</span></div>
          <div class="status-row"><span class="status-k">Proxy 生效模型</span><span class="status-v" id="stProxyModel">-</span></div>
          <div class="status-row"><span class="status-k">Memory 组状态</span><span class="status-v" id="stMemoryStatus">复用 Proxy 组</span></div>
        </div>
      </section>
    </aside>
  </div>
</div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var presets = ${JSON.stringify(PROVIDER_PRESETS)};
  var currentSettings = null;
  var currentProxyAuth = 'api_key';
  var currentMemAuth = 'api_key';

  /* 悬浮 Toast 提示 */
  function toast(msg, type){
    var stack = $('toastStack');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'ok');
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(function(){
      el.classList.add('leaving');
      setTimeout(function(){ if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, 2800);
  }

  /* API 调用封装 */
  function api(url, method, body){
    var init = { method: method || 'GET', headers: { 'content-type': 'application/json' } };
    if (body) init.body = JSON.stringify(body);
    return fetch(url, init).then(function(res){
      return res.json().then(function(data){
        if (!res.ok) throw new Error(data.error?.message || data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  /* 联动核心：更新继承展示、Agent 代码示例与状态卡片 */
  function syncAllLinkages(){
    var pUrl = $('proxyBaseUrl').value.trim();
    var pModel = $('proxyModel').value.trim();

    var isReused = $('memoryReuseProxy').checked;

    // 1. 同步 Memory 组继承展示
    var sumBox = $('reuseSummary');
    if (isReused) {
      if (sumBox) sumBox.style.display = 'flex';
      $('sumMemUrl').textContent = pUrl || '(未设置)';
      $('sumMemModel').textContent = pModel || '(未设置)';
      $('reuseBadge').textContent = '已复用 Proxy 组';
      $('reuseBadge').className = 'badge ok';
      $('memoryCustomSection').classList.add('collapsed');
    } else {
      if (sumBox) sumBox.style.display = 'none';
      $('reuseBadge').textContent = '独立配置';
      $('reuseBadge').className = 'badge accent';
      $('memoryCustomSection').classList.remove('collapsed');
    }

    // 2. 同步右侧 Agent 接入代码 (Claude Code 与 OpenAI SDK)
    var modelForSnippet = pModel || 'deepseek-chat';
    var claudeCmd = 'export ANTHROPIC_BASE_URL="http://127.0.0.1:8790/v1"\\nclaude --model ' + modelForSnippet;
    var preClaude = $('claudeCodeSnippet');
    if (preClaude) preClaude.textContent = claudeCmd;
    var btnClaude = $('copyClaudeBtn');
    if (btnClaude) btnClaude.setAttribute('data-copy', claudeCmd);

    // 3. 同步右侧网关当前生效状态卡片
    $('stProxyUrl').textContent = pUrl || '默认';
    $('stProxyModel').textContent = pModel || '默认';
    if (isReused) {
      $('stMemoryStatus').textContent = '复用 Proxy 组' + (pModel ? ' (' + pModel + ')' : '');
    } else {
      var mModel = $('memModel').value.trim();
      $('stMemoryStatus').textContent = '独立模型: ' + (mModel || '未设置');
    }

    // 4. 高亮当前匹配的预设卡片
    var matchedPreset = presets.find(function(p){
      return p.baseUrl === pUrl && (p.defaultModel === pModel || !pModel);
    });
    document.querySelectorAll('.preset-card').forEach(function(c){
      c.classList.toggle('active', Boolean(matchedPreset && c.getAttribute('data-preset-id') === matchedPreset.id));
    });
  }

  /* 认证方式设置 */
  function setProxyAuth(mode){
    currentProxyAuth = mode || 'api_key';
  }

  /* 切换 API Key 显示明暗 */
  $('toggleApiKey').addEventListener('click', function(){
    var input = $('proxyApiKey');
    if (input.type === 'password') {
      input.type = 'text';
      this.textContent = '隐藏';
    } else {
      input.type = 'password';
      this.textContent = '显示';
    }
  });

  /* 填充模型下拉列表（保留选择框，默认选中列表首个模型，支持手动输入） */
  function populateModelSelect(selectEl, inputEl, models, currentVal) {
    if (!selectEl || !inputEl) return;
    selectEl.innerHTML = '';
    if (!models || models.length === 0) {
      selectEl.style.display = 'none';
      inputEl.style.display = 'block';
      return;
    }

    selectEl.style.display = 'block';
    var firstModelId = '';

    models.forEach(function(m, idx) {
      var id = typeof m === 'string' ? m : m.id;
      if (idx === 0) firstModelId = id;
      var name = typeof m === 'string' ? m : (m.name || m.id);
      var tag = '';
      if (m && typeof m === 'object') {
        if (m.supportsThinking) tag = ' [推理]';
        else if (m.supportsImage) tag = ' [生图]';
      }
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id + tag + (name && name !== id ? ' (' + name + ')' : '');
      selectEl.appendChild(opt);
    });

    var customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = '✏️ 手动输入其它自定义模型...';
    selectEl.appendChild(customOpt);

    // 选中逻辑：已有值且在列表中则保留，否则默认设置返回列表的第一个模型
    var selectedId = '';
    if (currentVal && currentVal !== '__custom__') {
      for (var i = 0; i < selectEl.options.length; i++) {
        if (selectEl.options[i].value === currentVal) {
          selectEl.selectedIndex = i;
          selectedId = currentVal;
          break;
        }
      }
    }

    if (!selectedId) {
      if (firstModelId) {
        selectEl.value = firstModelId;
        selectedId = firstModelId;
      } else {
        selectEl.value = '__custom__';
        selectedId = '__custom__';
      }
    }

    if (selectEl.value === '__custom__') {
      inputEl.style.display = 'block';
      inputEl.value = currentVal && currentVal !== '__custom__' ? currentVal : '';
    } else {
      inputEl.style.display = 'none';
      inputEl.value = selectEl.value;
    }

    syncAllLinkages();
  }

  /* 拉取上游可用模型列表 */
  function fetchModels(forMemory) {
    var btn = forMemory ? $('btnFetchMemModels') : $('btnFetchProxyModels');
    var baseUrl = forMemory ? ($('memBaseUrl').value.trim() || $('proxyBaseUrl').value.trim()) : $('proxyBaseUrl').value.trim();
    var apiKey = forMemory ? ($('memApiKey').value.trim() || $('proxyApiKey').value.trim()) : $('proxyApiKey').value.trim();
    var tipEl = forMemory ? $('memModelTip') : $('proxyModelTip');

    if (!baseUrl) {
      toast('请先填写 Base URL 接口地址', 'bad');
      return;
    }

    btn.classList.add('loading');
    btn.disabled = true;
    var span = btn.querySelector('span');
    var origText = span ? span.textContent : '拉取模型列表';
    if (span) span.textContent = '正在拉取...';

    api('/v1/zhiyi/models', 'POST', {
      baseUrl: baseUrl,
      apiKey: apiKey || undefined,
      refresh: true,
    }).then(function(res) {
      var list = res.data || [];
      if (list.length === 0) {
        toast('未发现可用模型，请核对 API Key 与 Base URL', 'bad');
        return;
      }
      toast('成功获取 ' + list.length + ' 个可用模型！');
      if (tipEl) tipEl.textContent = '✓ 已从服务获取 ' + list.length + ' 个可用模型，已默认选择首个模型';

      populateModelSelect(
        forMemory ? $('memModelSelect') : $('proxyModelSelect'),
        forMemory ? $('memModel') : $('proxyModel'),
        list,
        forMemory ? $('memModel').value : $('proxyModel').value
      );
      if (!forMemory) {
        populateModelSelect($('memModelSelect'), $('memModel'), list, $('memModel').value);
      }
    }).catch(function(err) {
      toast('拉取模型失败: ' + err.message + '，可直接手动输入', 'bad');
    }).finally(function() {
      btn.classList.remove('loading');
      btn.disabled = false;
      if (span) span.textContent = origText;
    });
  }

  $('btnFetchProxyModels').addEventListener('click', function(){ fetchModels(false); });
  $('btnFetchMemModels').addEventListener('click', function(){ fetchModels(true); });

  $('proxyModelSelect').addEventListener('change', function(){
    if (this.value === '__custom__') {
      $('proxyModel').style.display = 'block';
      $('proxyModel').value = '';
      $('proxyModel').focus();
    } else {
      $('proxyModel').style.display = 'none';
      $('proxyModel').value = this.value;
    }
    syncAllLinkages();
  });

  $('memModelSelect').addEventListener('change', function(){
    if (this.value === '__custom__') {
      $('memModel').style.display = 'block';
      $('memModel').value = '';
      $('memModel').focus();
    } else {
      $('memModel').style.display = 'none';
      $('memModel').value = this.value;
    }
    syncAllLinkages();
  });

  /* 输入事件全链路联动 */
  $('proxyBaseUrl').addEventListener('input', syncAllLinkages);
  $('proxyModel').addEventListener('input', syncAllLinkages);
  if ($('proxyProtocol')) $('proxyProtocol').addEventListener('change', syncAllLinkages);
  $('memBaseUrl').addEventListener('input', syncAllLinkages);
  $('memModel').addEventListener('input', syncAllLinkages);
  if ($('memProtocol')) $('memProtocol').addEventListener('change', syncAllLinkages);
  $('memoryReuseProxy').addEventListener('change', syncAllLinkages);

  /* 预设卡片点击填入并连贯联动 */
  $('presetsGrid').addEventListener('click', function(e){
    var card = e.target.closest('.preset-card');
    if (!card) return;
    var id = card.getAttribute('data-preset-id');
    var found = presets.find(function(p){ return p.id === id; });
    if (!found) return;

    $('proxyBaseUrl').value = found.baseUrl || '';
    setProxyAuth(found.authMode || 'api_key');
    if (found.upstreamProtocol) $('proxyProtocol').value = found.upstreamProtocol;
    if (found.defaultModel) $('proxyModel').value = found.defaultModel;

    if (found.models && found.models.length > 0) {
      populateModelSelect($('proxyModelSelect'), $('proxyModel'), found.models, found.defaultModel);
      populateModelSelect($('memModelSelect'), $('memModel'), found.models, found.defaultModel);
      $('proxyModelTip').textContent = '✓ 已预置常用模型，点击右上角「拉取模型列表」可获取该服务实时模型';
    }

    // 若当前未复用且记忆字段为空，自动填充对应默认值
    if (!$('memoryReuseProxy').checked && !$('memModel').value.trim()) {
      if (found.defaultModel) $('memModel').value = found.defaultModel;
      if (found.baseUrl) $('memBaseUrl').value = found.baseUrl;
      if (found.upstreamProtocol) $('memProtocol').value = found.upstreamProtocol;
    }

    syncAllLinkages();
    toast('已套用预设: ' + found.label);
    $('proxyApiKey').focus();
  });

  /* 刷新状态面板 */
  function updateStatus(data){
    currentSettings = data;
    $('gatewayStatusBadge').innerHTML = '<i class="dot"></i><span>' + (data.active ? '运行中 (自定义配置)' : '运行中 (环境默认)') + '</span>';
    syncAllLinkages();
  }

  /* 加载页面数据 */
  function loadSettings(){
    return api('/v1/zhiyi/settings').then(function(data){
      $('proxyBaseUrl').value = data.baseUrl || '';
      setProxyAuth(data.authMode || 'api_key');
      $('proxyProtocol').value = data.upstreamProtocol || 'auto';
      $('proxyModel').value = data.model || '';

      if (data.apiKeySet) {
        $('proxyApiKey').placeholder = '已配置（留空保持不变）';
        $('proxyApiKeyTip').textContent = '密钥已保存在本地，输入新密钥可覆盖';
      } else {
        $('proxyApiKey').placeholder = 'sk-...';
        $('proxyApiKeyTip').textContent = '密钥仅保存在本机网关，绝不向外部泄露';
      }

      var reuse = (data.memoryReuseProxy !== false);
      $('memoryReuseProxy').checked = reuse;

      $('memBaseUrl').value = data.memoryBaseUrl || '';
      currentMemAuth = data.memoryAuthMode || 'api_key';
      $('memProtocol').value = data.memoryProtocol || 'auto';
      $('memModel').value = data.memoryModel || '';
      $('memApiKey').placeholder = data.memoryApiKeySet ? '已配置（留空保持不变）' : '留空沿用主模型 Key';

      if ($('ducxReport')) $('ducxReport').checked = (data.ducxReport !== false);
      if ($('ducxExecutable') && data.ducxExecutable) $('ducxExecutable').value = data.ducxExecutable;

      updateStatus(data);
      api('/v1/zhiyi/models').then(function(res){
        var list = res.data || [];
        if (list.length > 0) {
          populateModelSelect($('proxyModelSelect'), $('proxyModel'), list, $('proxyModel').value);
          populateModelSelect($('memModelSelect'), $('memModel'), list, $('memModel').value);
          $('proxyModelTip').textContent = '✓ 已从服务获取 ' + list.length + ' 个可用模型，已默认选择首个模型';
        }
      }).catch(function(){});
    }).catch(function(err){
      toast('读取配置失败: ' + err.message, 'bad');
    });
  }

  function getFormPatch(){
    var patch = {
      baseUrl: $('proxyBaseUrl').value.trim(),
      authMode: currentProxyAuth,
      upstreamProtocol: $('proxyProtocol').value,
      model: $('proxyModel').value.trim(),
      memoryReuseProxy: $('memoryReuseProxy').checked,
      memoryBaseUrl: $('memBaseUrl').value.trim(),
      memoryAuthMode: currentMemAuth,
      memoryProtocol: $('memProtocol').value,
      memoryModel: $('memModel').value.trim(),
      ducxReport: $('ducxReport') ? $('ducxReport').checked : true,
    };

    if ($('ducxExecutable') && $('ducxExecutable').value.trim()) {
      patch.ducxExecutable = $('ducxExecutable').value.trim();
    }

    var keyVal = $('proxyApiKey').value.trim();
    if (keyVal !== '') patch.apiKey = keyVal;

    var memKeyVal = $('memApiKey').value.trim();
    if (memKeyVal !== '') patch.memoryApiKey = memKeyVal;

    return patch;
  }

  /* 保存配置 */
  $('btnSave').addEventListener('click', function(){
    var btn = this;
    btn.disabled = true;
    btn.innerHTML = '正在保存...';

    var patch = getFormPatch();

    api('/v1/zhiyi/settings', 'PUT', patch).then(function(saved){
      toast('配置保存成功，已立即生效！');
      $('proxyApiKey').value = '';
      $('memApiKey').value = '';
      loadSettings();
      runHealthCheck(false);
    }).catch(function(err){
      toast('保存失败: ' + err.message, 'bad');
    }).finally(function(){
      btn.disabled = false;
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> 保存配置并生效';
    });
  });

  /* 通路预检与连通性测试 */
  function runHealthCheck(withChat){
    var badgeProxy = $('proxyDiagBadge');
    var detailProxy = $('proxyDiagDetail');
    var badgeMem = $('memDiagBadge');
    var detailMem = $('memDiagDetail');
    var bubble = $('chatReplyBubble');

    badgeProxy.className = 'diag-badge warn';
    badgeProxy.textContent = '测试中...';
    detailProxy.textContent = '正在发起握手检测...';

    if (withChat) {
      bubble.style.display = 'block';
      bubble.textContent = '正在发送对话探测测试...';
    } else {
      bubble.style.display = 'none';
    }

    var patch = getFormPatch();
    api('/v1/zhiyi/settings', 'PUT', patch).catch(function(){}).then(function(){
      return api('/v1/zhiyi/settings/test', 'POST', { chat: Boolean(withChat) });
    }).then(function(res){
      if (res.ok) {
        badgeProxy.className = 'diag-badge ok';
        badgeProxy.textContent = '200 OK (' + res.latencyMs + 'ms)';
        detailProxy.textContent = '✓ 通路正常 · 模型: ' + res.model + ' · 可用模型数: ' + (res.modelCount || 0);

        if (res.memoryGroup) {
          if (res.memoryGroup.reused) {
            badgeMem.className = 'diag-badge ok';
            badgeMem.textContent = '已复用主组';
            detailMem.textContent = '✓ 自动复用 Proxy 组配置，状态正常';
          } else if (res.memoryGroup.ok) {
            badgeMem.className = 'diag-badge ok';
            badgeMem.textContent = '200 OK (' + res.memoryGroup.latencyMs + 'ms)';
            detailMem.textContent = '✓ 独立 Memory 通路正常 · 模型: ' + res.memoryGroup.model;
          } else {
            badgeMem.className = 'diag-badge bad';
            badgeMem.textContent = '失败';
            detailMem.textContent = '✗ ' + (res.memoryGroup.error || '连接失败');
          }
        }

        if (withChat && res.chat) {
          bubble.innerHTML = '<b>助手真实回复回显：</b>' + escapeHtml(res.chat);
        }
        if (res.modelCount) {
          api('/v1/zhiyi/models').then(function(mRes){
            var list = mRes.data || [];
            if (list.length > 0) {
              populateModelSelect($('proxyModelSelect'), $('proxyModel'), list, $('proxyModel').value);
              populateModelSelect($('memModelSelect'), $('memModel'), list, $('memModel').value);
              $('proxyModelTip').textContent = '✓ 已从服务获取 ' + list.length + ' 个可用模型，已默认选择首个模型';
            }
          }).catch(function(){});
        }
        toast('LLM 通路测试通过！');
      } else {
        badgeProxy.className = 'diag-badge bad';
        badgeProxy.textContent = '失败';
        detailProxy.textContent = '✗ ' + (res.error || '未知错误');
        toast('通路测试未通过：' + (res.error || '检查配置'), 'bad');
      }
    }).catch(function(err){
      badgeProxy.className = 'diag-badge bad';
      badgeProxy.textContent = '异常';
      detailProxy.textContent = '✗ ' + err.message;
      toast('连通性测试异常: ' + err.message, 'bad');
    });
  }

  $('btnCheckHealth').addEventListener('click', function(){ runHealthCheck(false); });
  $('btnTestChat').addEventListener('click', function(){ runHealthCheck(true); });

  /* 恢复默认弹窗 */
  $('btnOpenReset').addEventListener('click', function(){ $('resetModal').classList.add('open'); });
  $('cancelReset').addEventListener('click', function(){ $('resetModal').classList.remove('open'); });
  $('confirmReset').addEventListener('click', function(){
    $('resetModal').classList.remove('open');
    api('/v1/zhiyi/settings/reset', 'POST', {}).then(function(){
      toast('已恢复为环境变量默认配置');
      loadSettings();
    }).catch(function(err){
      toast('恢复失败: ' + err.message, 'bad');
    });
  });

  /* 一键复制代码 */
  document.addEventListener('click', function(e){
    var pill = e.target.closest('.copy-pill');
    if (!pill) return;
    var text = pill.getAttribute('data-copy');
    if (!text) return;
    navigator.clipboard.writeText(text).then(function(){
      pill.textContent = '已复制！';
      pill.classList.add('copied');
      setTimeout(function(){
        pill.textContent = '复制';
        pill.classList.remove('copied');
      }, 2000);
    });
  });

  // 初始加载
  loadSettings();
})();
</script>
</body>
</html>`;