/**
 * 知忆 · 模型服务设置页（零依赖静态页，挂在 Gateway 的 /settings）。
 * 面向终端用户提供通用模型中转配置与连通性测试，页面本身不保存任何明文密钥。
 */
import { PROVIDER_PRESETS } from './model-settings';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const INITIAL_PRESETS_HTML: string = PROVIDER_PRESETS.map(
  (p) =>
    `<button type="button" class="preset" data-preset-id="${escapeHtml(p.id)}"><b>${escapeHtml(p.label)}</b><span>${escapeHtml(p.description)}</span></button>`,
).join('');

export const SETTINGS_PAGE_HTML: string = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>知忆 Zhiyi · 模型服务设置</title>
<style>
:root{
  color-scheme:light;
  --ink:#0f172a;
  --ink-soft:#334155;
  --muted:#64748b;
  --line:#e2e8f0;
  --soft:#f8fafc;
  --bg:#f3f5f8;
  --card:#ffffff;
  --accent:#2563eb;
  --accent-hover:#1d4ed8;
  --accent-soft:#eff6ff;
  --ok:#059669;
  --ok-soft:#ecfdf5;
  --ok-line:#a7f3d0;
  --bad:#dc2626;
  --bad-soft:#fef2f2;
  --bad-line:#fecaca;
  --shadow-sm:0 1px 3px rgba(15,23,42,.04);
  --shadow-pop:0 16px 40px -8px rgba(15,23,42,.16),0 4px 12px -2px rgba(15,23,42,.06);
  --ease:cubic-bezier(.22,1,.36,1);
  --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
}
*{box-sizing:border-box}
body{
  margin:0;
  background:var(--bg);
  color:var(--ink);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 64px}

.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap}
.title-group h1{font-size:21px;font-weight:700;margin:0;letter-spacing:-0.015em}
.title-group .sub{color:var(--muted);font-size:13px;margin-top:3px}
.pill{display:inline-flex;align-items:center;gap:7px;padding:6px 13px;border-radius:999px;font-size:12px;font-weight:500;background:#fff;color:var(--ink-soft);border:1px solid var(--line);box-shadow:var(--shadow-sm)}
.pill .dot{width:7px;height:7px;border-radius:50%;background:var(--ok);transition:background .2s}
.pill.muted .dot{background:#94a3b8}

.layout{display:grid;grid-template-columns:minmax(0,1fr) 348px;gap:20px;align-items:start}
@media (max-width:920px){.layout{grid-template-columns:1fr}}
.sidebar{position:sticky;top:24px}
@media (max-width:920px){.sidebar{position:static}}

.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px;margin-bottom:16px;box-shadow:var(--shadow-sm);transition:box-shadow .2s var(--ease)}
.card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}
.card-head h2{font-size:15px;font-weight:600;margin:0;color:var(--ink)}
.card-head .hint-inline{font-size:12px;color:var(--muted)}

.presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
@media (max-width:680px){.presets{grid-template-columns:1fr}}
.preset{
  text-align:left;padding:13px 14px;border:1px solid var(--line);border-radius:12px;
  background:var(--soft);cursor:pointer;color:var(--ink);
  transition:transform .16s var(--ease),border-color .16s var(--ease),background .16s var(--ease),box-shadow .16s var(--ease)
}
.preset:hover{border-color:#93c5fd;background:var(--accent-soft);transform:translateY(-1px)}
.preset:active{transform:translateY(0) scale(.99)}
.preset.active{border-color:var(--accent);background:var(--accent-soft);box-shadow:0 0 0 1px var(--accent)}
.preset b{display:block;font-size:13px;font-weight:600;margin-bottom:4px}
.preset span{display:block;font-size:12px;color:var(--muted);line-height:1.45}

.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:640px){.grid-2{grid-template-columns:1fr}}
.span-2{grid-column:1 / -1}

.field{display:block;font-size:12.5px;font-weight:500;color:var(--ink-soft);margin:0}
.field input,.field select.native-select{
  display:block;width:100%;margin-top:6px;padding:10px 12px;height:40px;
  border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);
  font-size:13px;line-height:1.4;transition:border-color .15s,box-shadow .15s
}
.field input{font-family:var(--mono)}
.field input[type=password]{font-family:inherit}
.field input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.12)}

/* 自定义美化下拉框 */
.cselect{position:relative;margin-top:6px}
.cselect-btn{
  width:100%;height:40px;padding:0 36px 0 12px;border:1px solid var(--line);border-radius:10px;
  background:#fff;color:var(--ink);font-size:13px;font-weight:400;text-align:left;cursor:pointer;
  display:flex;align-items:center;justify-content:space-between;
  transition:border-color .16s,box-shadow .16s,background .16s
}
.cselect-btn:hover{border-color:#94a3b8;background:#fff}
.cselect.open .cselect-btn{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.cselect-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cselect-arrow{
  position:absolute;right:12px;top:50%;width:16px;height:16px;margin-top:-8px;
  color:var(--muted);pointer-events:none;transition:transform .22s var(--ease)
}
.cselect.open .cselect-arrow{transform:rotate(180deg);color:var(--accent)}
.cselect-menu{
  position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:80;
  background:#fff;border:1px solid var(--line);border-radius:12px;padding:5px;
  box-shadow:var(--shadow-pop);
  opacity:0;transform:translateY(-6px) scale(.98);pointer-events:none;
  transition:opacity .18s var(--ease),transform .18s var(--ease);
}
.cselect.open .cselect-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.cselect-opt{
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  width:100%;padding:8px 10px;border:none;border-radius:8px;background:transparent;
  color:var(--ink);font-size:13px;font-weight:400;text-align:left;cursor:pointer;
  transition:background .12s,color .12s
}
.cselect-opt:hover{background:var(--soft)}
.cselect-opt.active{background:var(--accent-soft);color:var(--accent);font-weight:500}
.cselect-opt .opt-check{width:14px;height:14px;opacity:0;flex-shrink:0}
.cselect-opt.active .opt-check{opacity:1}

/* 平滑展开的高级设置 */
.adv-wrap{margin-top:16px;border-top:1px solid var(--line);padding-top:14px}
.adv-toggle{
  width:100%;background:transparent;border:none;padding:0;cursor:pointer;
  display:flex;align-items:center;justify-content:space-between;
  font-size:12.5px;font-weight:500;color:var(--muted);text-align:left
}
.adv-toggle:hover{color:var(--ink);background:transparent}
.adv-toggle svg{width:15px;height:15px;transition:transform .24s var(--ease)}
.adv-wrap.open .adv-toggle svg{transform:rotate(180deg)}
.adv-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .26s var(--ease),opacity .22s ease;opacity:0}
.adv-wrap.open .adv-collapse{grid-template-rows:1fr;opacity:1}
.adv-inner{overflow:hidden}
.adv-body{padding-top:14px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:640px){.adv-body{grid-template-columns:1fr}}

.ducx-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding-top:4px}
.check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink-soft);cursor:pointer;margin:0}
.check input{width:auto;margin:0}

.toolbar{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
.toolbar input{flex:1 1 200px;height:38px;padding:0 12px;border:1px solid var(--line);border-radius:10px;font-size:13px;background:#fff;color:var(--ink);transition:border-color .15s,box-shadow .15s}
.toolbar input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.12)}

.model-stats{font-size:12px;color:var(--muted);margin:10px 0 8px}
.model-list{max-height:290px;overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fff}
.model-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 13px;border-bottom:1px solid #f1f5f9;cursor:pointer;transition:background .12s}
.model-item:last-child{border-bottom:none}
.model-item:hover{background:var(--soft)}
.model-item.selected{background:var(--accent-soft)}
.model-main{min-width:0;flex:1}
.model-id{font:13px/1.4 var(--mono);font-weight:600;color:var(--ink);word-break:break-all}
.model-name{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.model-tags{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0}
.tag{font-size:11px;padding:2px 8px;border-radius:999px;background:#f1f5f9;color:var(--muted);white-space:nowrap}
.tag.cap{background:var(--accent-soft);color:var(--accent)}
.empty-row{padding:20px;text-align:center;font-size:12.5px;color:var(--muted)}

button.btn{padding:0 14px;height:38px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);cursor:pointer;font-size:13px;font-weight:500;transition:all .15s var(--ease)}
button.btn:hover{border-color:#94a3b8;background:var(--soft)}
button.btn:active{transform:scale(.98)}
button.btn:disabled{opacity:.45;cursor:not-allowed}
button.primary{width:100%;height:42px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s,transform .15s var(--ease),box-shadow .15s}
button.primary:hover{background:var(--accent-hover);box-shadow:0 4px 12px rgba(37,99,235,.22)}
button.primary:active{transform:scale(.985)}
button.subtle{height:32px;padding:0 11px;font-size:12px;color:var(--ink-soft)}
button.link-danger{width:100%;margin-top:8px;height:34px;border-radius:9px;background:transparent;border:1px solid transparent;color:var(--muted);font-size:12.5px;cursor:pointer;transition:all .15s}
button.link-danger:hover{color:var(--bad);background:var(--bad-soft);border-color:var(--bad-line)}

.btn-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}

.notice{margin-top:12px;padding:11px 13px;border-radius:10px;border:1px solid var(--line);background:var(--soft);color:var(--ink-soft);font-size:12.5px;line-height:1.55;word-break:break-word;transition:all .2s var(--ease)}
.notice.ok{background:var(--ok-soft);border-color:var(--ok-line);color:#065f46}
.notice.bad{background:var(--bad-soft);border-color:var(--bad-line);color:#991b1b}

.kv-list{display:grid;gap:10px;font-size:12.5px}
.kv{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:9px;border-bottom:1px solid #f1f5f9}
.kv:last-child{padding-bottom:0;border-bottom:none}
.kv span{color:var(--muted);flex-shrink:0}
.kv b{color:var(--ink);font-weight:600;text-align:right;font-family:var(--mono);font-size:12px;max-width:205px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kv b.text{font-family:inherit;font-size:12.5px;max-width:none}
.kv b.ok{color:var(--ok)}
.kv b.bad{color:var(--bad)}

.footer-note{font-size:12px;color:var(--muted);line-height:1.6;padding:0 4px}

/* 悬浮 Toast 提示弹框 */
.toast-stack{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:200;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:min(460px,calc(100vw - 32px))}
.toast{
  pointer-events:auto;display:flex;align-items:center;gap:10px;padding:10px 15px;border-radius:12px;
  background:rgba(15,23,42,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  color:#fff;font-size:13px;font-weight:500;box-shadow:var(--shadow-pop);
  animation:toastIn .28s var(--ease) forwards;
}
.toast.ok{background:rgba(6,95,70,.95)}
.toast.bad{background:rgba(153,27,27,.95)}
.toast.leaving{animation:toastOut .2s ease forwards}
.toast-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex-shrink:0}
.toast.ok .toast-dot{background:#34d399}
.toast.bad .toast-dot{background:#f87171}
.toast.info .toast-dot{background:#60a5fa}

/* 模态确认弹框 */
.modal-backdrop{
  position:fixed;inset:0;z-index:180;display:flex;align-items:center;justify-content:center;padding:20px;
  background:rgba(15,23,42,.38);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
  opacity:0;pointer-events:none;transition:opacity .2s ease
}
.modal-backdrop.open{opacity:1;pointer-events:auto}
.modal-card{
  width:100%;max-width:400px;background:#fff;border:1px solid var(--line);border-radius:16px;
  padding:22px;box-shadow:var(--shadow-pop);
  transform:scale(.94) translateY(8px);transition:transform .24s var(--ease)
}
.modal-backdrop.open .modal-card{transform:scale(1) translateY(0)}
.modal-title{font-size:16px;font-weight:600;margin:0 0 8px;color:var(--ink)}
.modal-desc{font-size:13px;color:var(--muted);line-height:1.6;margin:0 0 18px}
.modal-actions{display:flex;gap:10px;justify-content:flex-end}
.modal-actions button{height:36px;padding:0 16px;border-radius:9px;font-size:13px;font-weight:500;cursor:pointer}
.modal-cancel{border:1px solid var(--line);background:#fff;color:var(--ink)}
.modal-cancel:hover{background:var(--soft)}
.modal-confirm{border:none;background:var(--bad);color:#fff}
.modal-confirm:hover{background:#b91c1c}

@keyframes toastIn{
  from{opacity:0;transform:translateY(-12px) scale(.96)}
  to{opacity:1;transform:translateY(0) scale(1)}
}
@keyframes toastOut{
  from{opacity:1;transform:translateY(0) scale(1)}
  to{opacity:0;transform:translateY(-8px) scale(.96)}
}
.hidden{display:none!important}
</style>
</head>
<body>
<div class="toast-stack" id="toastStack"></div>

<div class="modal-backdrop" id="confirmModal" aria-hidden="true">
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <h3 class="modal-title" id="modalTitle">恢复默认配置</h3>
    <p class="modal-desc" id="modalDesc">将清空当前自定义设置并回退到环境变量默认配置，确定要继续吗？</p>
    <div class="modal-actions">
      <button type="button" class="modal-cancel" id="modalCancel">取消</button>
      <button type="button" class="modal-confirm" id="modalConfirm">确认恢复</button>
    </div>
  </div>
</div>

<div class="wrap">
  <header class="topbar">
    <div class="title-group">
      <h1>模型服务配置</h1>
      <div class="sub">统一管理上游接口地址、认证凭证与默认模型，保存后立即生效</div>
    </div>
    <span class="pill" id="activeBadge"><i class="dot"></i><span>读取中…</span></span>
  </header>

  <div class="layout">
    <main>
      <section class="card">
        <div class="card-head">
          <h2>常用预设</h2>
          <span class="hint-inline">点击即可快速填入，右侧保存生效</span>
        </div>
        <div class="presets" id="presets">${INITIAL_PRESETS_HTML}</div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>接口与认证</h2>
          <span class="hint-inline">支持标准 OpenAI 及多种协议兼容中转</span>
        </div>

        <div class="grid-2">
          <label class="field span-2">API 地址（Base URL）
            <input id="baseUrl" placeholder="https://api.openai.com/v1" autocomplete="off">
          </label>

          <div class="field">认证方式
            <select id="authMode" class="native-select hidden">
              <option value="api_key">API Key（Bearer 密钥）</option>
              <option value="ducx">本机登录态（DUCX）</option>
              <option value="none">无需认证</option>
            </select>
          </div>

          <div class="field">接口协议
            <select id="upstreamProtocol" class="native-select hidden">
              <option value="auto">自动适配（推荐）</option>
              <option value="openai_chat">OpenAI Chat (/v1/chat/completions)</option>
              <option value="anthropic_messages">Anthropic Messages (/v1/messages)</option>
              <option value="openai_responses">OpenAI Responses (/v1/responses)</option>
            </select>
          </div>

          <label class="field span-2" id="apiKeyRow">API Key（留空表示不修改）
            <input id="apiKey" type="password" placeholder="sk-… 或留空" autocomplete="new-password">
          </label>
        </div>

        <div class="adv-wrap" id="advWrap">
          <button type="button" class="adv-toggle" id="advToggle">
            <span>高级设置（生图/标题模型 · 模型策略 · 远程管理）</span>
            <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
          </button>
          <div class="adv-collapse">
            <div class="adv-inner">
              <div class="adv-body">
                <label class="field">默认生图模型
                  <input id="imageModel" list="modelOptions" placeholder="gpt-image-2" autocomplete="off">
                </label>
                <label class="field">会话标题生成模型（留空沿用默认模型）
                  <input id="titleModel" list="modelOptions" placeholder="例如 Claude Haiku 5.5 / gpt-4o-mini" autocomplete="off">
                </label>
                <div class="field">模型优先级
                  <select id="modelOverride" class="native-select hidden">
                    <option value="settings">以本页选中模型为准（推荐）</option>
                    <option value="request">以调用方请求参数为准</option>
                  </select>
                </div>
                <label class="field">模型列表路径
                  <input id="modelsPath" value="/models" autocomplete="off">
                </label>
                <div class="field">模型列表聚合方式
                  <select id="modelsSource" class="native-select hidden">
                    <option value="auto">自动发现全部可用模型</option>
                    <option value="single">仅读取标准列表接口</option>
                  </select>
                </div>
                <label class="field">远程管理令牌（本机访问可留空）
                  <input id="adminToken" type="password" placeholder="ZHIYI_SETTINGS_TOKEN" autocomplete="off">
                </label>
                <div id="ducxAdvGroup" class="span-2 hidden">
                  <div class="grid-2">
                    <label class="field span-2">DUCX 可执行文件路径
                      <input id="ducxExecutable" placeholder="~/.baidu-cx/baidu-cx/bin/ducx" autocomplete="off">
                    </label>
                    <div class="span-2">
                      <label class="check"><input type="checkbox" id="ducxReport" checked> 启用客户端来源信息上报</label>
                    </div>
                    <div class="span-2 ducx-tools">
                      <button id="refreshDucx" class="btn subtle" type="button">刷新登录凭证</button>
                      <button id="testReport" class="btn subtle" type="button">测试来源上报</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>默认模型</h2>
          <span class="hint-inline">点击列表选中，或直接输入模型 ID</span>
        </div>

        <label class="field">当前使用模型
          <input id="model" list="modelOptions" placeholder="gpt-4o / deepseek-chat / claude-sonnet" autocomplete="off">
          <datalist id="modelOptions"></datalist>
        </label>

        <div class="toolbar">
          <input id="modelSearch" placeholder="搜索模型名称、ID 或能力…" autocomplete="off">
          <button id="refreshModels" class="btn" type="button">刷新列表</button>
          <button id="clearFilter" class="btn" type="button">清除</button>
        </div>

        <div class="model-stats" id="modelStats">正在加载模型列表…</div>
        <div class="model-list" id="modelList"></div>
      </section>
    </main>

    <aside class="sidebar">
      <section class="card">
        <button id="save" class="primary" type="button">保存并应用</button>
        <div class="btn-pair">
          <button id="test" class="btn" type="button">连通性测试</button>
          <button id="testChat" class="btn" type="button">对话测试</button>
        </div>
        <button id="reset" class="link-danger" type="button">恢复环境变量默认配置</button>
        <div id="output" class="notice">准备就绪，修改配置后请点击「保存并应用」。</div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>当前生效状态</h2>
        </div>
        <div class="kv-list" id="status">读取中…</div>
      </section>

      <div class="footer-note">
        所有配置与密钥仅保存在本机网关，不会上传到第三方。
      </div>
    </aside>
  </div>
</div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var tokenKey = 'zhiyi_settings_token';
  $('adminToken').value = localStorage.getItem(tokenKey) || '';

  /* 悬浮动效 Toast */
  function showToast(text, type){
    var stack = $('toastStack');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.innerHTML = '<span class="toast-dot"></span><span></span>';
    el.querySelectorAll('span')[1].textContent = text;
    stack.appendChild(el);
    setTimeout(function(){
      el.classList.add('leaving');
      setTimeout(function(){ if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, 2800);
  }

  function log(text, bad){
    var out = $('output');
    out.textContent = text;
    out.className = 'notice ' + (bad ? 'bad' : 'ok');
    showToast(text, bad ? 'bad' : 'ok');
  }
  function busy(text){
    var out = $('output');
    out.textContent = text;
    out.className = 'notice';
  }

  /* 折叠动画 */
  $('advToggle').addEventListener('click', function(){
    $('advWrap').classList.toggle('open');
  });

  /* 自定义下拉增强组件（与隐藏 select 双向同步） */
  var customSelects = [];
  function initCustomSelect(selectEl){
    var wrap = document.createElement('div');
    wrap.className = 'cselect';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cselect-btn';
    btn.innerHTML = '<span class="cselect-label"></span><svg class="cselect-arrow" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>';
    var menu = document.createElement('div');
    menu.className = 'cselect-menu';

    function syncFromNative(){
      var chosen = selectEl.options[selectEl.selectedIndex] || selectEl.options[0];
      btn.querySelector('.cselect-label').textContent = chosen ? chosen.textContent : '';
      var opts = menu.querySelectorAll('.cselect-opt');
      opts.forEach(function(o){ o.classList.toggle('active', o.getAttribute('data-val') === selectEl.value); });
    }

    Array.prototype.forEach.call(selectEl.options, function(opt){
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'cselect-opt';
      item.setAttribute('data-val', opt.value);
      item.innerHTML = '<span></span><svg class="opt-check" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd"/></svg>';
      item.querySelector('span').textContent = opt.textContent;
      item.addEventListener('click', function(){
        selectEl.value = opt.value;
        syncFromNative();
        wrap.classList.remove('open');
        selectEl.dispatchEvent(new Event('change'));
      });
      menu.appendChild(item);
    });

    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var wasOpen = wrap.classList.contains('open');
      closeAllSelects();
      if (!wasOpen) wrap.classList.add('open');
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    selectEl.parentNode.appendChild(wrap);
    syncFromNative();
    customSelects.push({ wrap: wrap, sync: syncFromNative });
  }
  function closeAllSelects(){
    customSelects.forEach(function(c){ c.wrap.classList.remove('open'); });
  }
  function syncAllCustomSelects(){
    customSelects.forEach(function(c){ c.sync(); });
  }
  document.addEventListener('click', closeAllSelects);
  ['authMode', 'upstreamProtocol', 'modelOverride', 'modelsSource'].forEach(function(id){
    initCustomSelect($(id));
  });

  /* 优雅确认弹框 */
  function openConfirm(onYes){
    var modal = $('confirmModal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    function cleanup(){
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      $('modalConfirm').onclick = null;
      $('modalCancel').onclick = null;
    }
    $('modalCancel').onclick = cleanup;
    modal.onclick = function(e){ if (e.target === modal) cleanup(); };
    $('modalConfirm').onclick = function(){ cleanup(); onYes(); };
  }

  $('adminToken').addEventListener('change', function(){
    localStorage.setItem(tokenKey, $('adminToken').value.trim());
    log('已更新当前浏览器的管理令牌。');
  });

  function authHeaders(){
    var h = {'content-type':'application/json'};
    var t = (localStorage.getItem(tokenKey) || '').trim();
    if (t) h.authorization = 'Bearer ' + t;
    return h;
  }
  function api(path, method, body){
    return fetch(path, {
      method: method || 'GET',
      headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function(res){
      return res.text().then(function(text){
        var json; try { json = JSON.parse(text); } catch(e){ json = text; }
        if (!res.ok) {
          var msg = (json && json.error && json.error.message) || ('HTTP ' + res.status);
          if (res.status === 401) msg += '（请在「高级设置」填入管理令牌）';
          throw new Error(msg);
        }
        return json;
      });
    });
  }

  function syncAuthVisibility(){
    var mode = $('authMode').value;
    $('apiKeyRow').classList.toggle('hidden', mode !== 'api_key');
    $('ducxAdvGroup').classList.toggle('hidden', mode !== 'ducx');
  }

  function currentPatch(){
    return {
      baseUrl: $('baseUrl').value.trim(),
      apiKey: $('apiKey').value,
      authMode: $('authMode').value,
      upstreamProtocol: $('upstreamProtocol').value,
      model: $('model').value.trim(),
      imageModel: $('imageModel').value.trim() || 'gpt-image-2',
      titleModel: $('titleModel').value.trim(),
      modelsPath: $('modelsPath').value.trim() || '/models',
      modelsSource: $('modelsSource').value,
      ducxReport: $('ducxReport').checked,
      ducxExecutable: $('ducxExecutable').value.trim(),
      modelOverride: $('modelOverride').value
    };
  }

  function esc(s){
    return String(s == null ? '-' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function kvRow(label, value, cls, withTitle){
    var titleAttr = withTitle ? ' title="' + esc(value) + '"' : '';
    return '<div class="kv"><span>' + esc(label) + '</span><b class="' + (cls || '') + '"' + titleAttr + '>' + esc(value) + '</b></div>';
  }
  function protocolLabel(p){
    if (p === 'openai_chat') return 'OpenAI Chat';
    if (p === 'anthropic_messages') return 'Anthropic Messages';
    if (p === 'openai_responses') return 'OpenAI Responses';
    return '自动适配';
  }
  function authLabel(data){
    if (data.authMode === 'none') return '无需认证';
    if (data.authMode === 'ducx') return (data.ducx && data.ducx.available) ? '本机登录态 · 就绪' : '本机登录态 · 未检测到组件';
    return data.apiKeySet ? 'API Key · 已配置' : 'API Key · 未填写';
  }

  var lastPresets = [];
  function syncPresetHighlight(){
    var curBase = ($('baseUrl').value || '').trim().replace(/\\/+$/,'');
    var curAuth = $('authMode').value;
    var btns = $('presets').querySelectorAll('.preset');
    var matchedCustom = false;
    btns.forEach(function(b, idx){
      var p = lastPresets[idx];
      if (!p) return;
      var match = p.baseUrl !== '' && p.baseUrl.replace(/\\/+$/,'') === curBase && p.authMode === curAuth;
      if (match) matchedCustom = true;
      b.classList.toggle('active', match);
    });
    if (!matchedCustom) {
      btns.forEach(function(b, idx){
        if (lastPresets[idx] && lastPresets[idx].id === 'custom') b.classList.add('active');
      });
    }
  }

  function render(data){
    $('baseUrl').value = data.baseUrl || '';
    $('authMode').value = data.authMode || 'api_key';
    $('upstreamProtocol').value = data.upstreamProtocol || 'auto';
    $('modelsPath').value = data.modelsPath || '/models';
    $('modelsSource').value = data.modelsSource || 'auto';
    $('ducxReport').checked = data.ducxReport !== false;
    $('ducxExecutable').value = data.ducxExecutable || '';
    $('model').value = data.model || '';
    $('imageModel').value = data.imageModel || 'gpt-image-2';
    $('titleModel').value = data.titleModel || '';
    $('modelOverride').value = data.modelOverride || 'settings';
    $('apiKey').value = '';
    $('apiKey').placeholder = data.apiKeySet ? ('已保存密钥（' + data.apiKeyMasked + '），留空不变') : 'sk-… 或留空';

    var badge = $('activeBadge');
    badge.querySelector('span').textContent = data.active ? '自定义配置生效中' : '默认配置生效中';
    badge.className = data.active ? 'pill' : 'pill muted';

    syncAllCustomSelects();
    syncAuthVisibility();

    var d = data.ducx || {};
    var rows = [
      kvRow('上游地址', data.effectiveBaseUrl || '-', '', true),
      kvRow('默认模型', data.model || '-', '', true),
      kvRow('接口协议', protocolLabel(data.upstreamProtocol || 'auto'), 'text'),
      kvRow('认证状态', authLabel(data), (data.authMode === 'none' || data.apiKeySet || d.available) ? 'ok text' : 'text')
    ];
    if (d.lastError && data.authMode === 'ducx') rows.push(kvRow('登录态异常', d.lastError, 'bad text', true));
    $('status').innerHTML = rows.join('');

    renderPresets(data.presets || []);
    syncPresetHighlight();
  }

  var INITIAL_PRESETS = ${JSON.stringify(PROVIDER_PRESETS)};

  function renderPresets(presets){
    if (!presets || presets.length === 0) return;
    lastPresets = presets;
    var box = $('presets');
    box.innerHTML = '';
    lastPresets.forEach(function(p){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.innerHTML = '<b></b><span></span>';
      b.querySelector('b').textContent = p.label;
      b.querySelector('span').textContent = p.description;
      b.addEventListener('click', function(){
        if (p.baseUrl) $('baseUrl').value = p.baseUrl;
        $('authMode').value = p.authMode;
        $('upstreamProtocol').value = 'auto';
        $('modelsPath').value = p.modelsPath;
        $('modelsSource').value = p.modelsSource || 'auto';
        syncAllCustomSelects();
        syncAuthVisibility();
        syncPresetHighlight();
        log('已套用「' + p.label + '」，请点击「保存并应用」使配置生效。');
      });
      box.appendChild(b);
    });
  }

  var allModels = [];
  function renderModels(models){
    allModels = models || [];
    var list = $('modelOptions');
    list.innerHTML = '';
    allModels.forEach(function(m){
      var o = document.createElement('option');
      o.value = m.id;
      if (m.name) o.label = m.name;
      list.appendChild(o);
    });
    renderModelRows();
  }

  function renderModelRows(){
    var q = ($('modelSearch').value || '').trim().toLowerCase();
    var box = $('modelList');
    box.innerHTML = '';
    var shown = 0;
    allModels.forEach(function(m){
      var tags = [];
      if (m.supportsThinking) tags.push({label:'推理', cap:true});
      if (m.supportsImage) tags.push({label:'识图', cap:true});
      if (m.ratio) tags.push({label:m.ratio, cap:false});
      var hay = [m.id, m.name, m.description, tags.map(function(t){return t.label;}).join(' ')].join(' ').toLowerCase();
      if (q && hay.indexOf(q) === -1) return;
      shown++;
      var row = document.createElement('div');
      row.className = 'model-item' + ($('model').value === m.id ? ' selected' : '');

      var main = document.createElement('div');
      main.className = 'model-main';
      var idEl = document.createElement('div');
      idEl.className = 'model-id';
      idEl.textContent = m.id;
      main.appendChild(idEl);
      if (m.name || m.description) {
        var nameEl = document.createElement('div');
        nameEl.className = 'model-name';
        nameEl.textContent = m.name || m.description;
        main.appendChild(nameEl);
      }
      row.appendChild(main);

      if (tags.length > 0) {
        var tagWrap = document.createElement('div');
        tagWrap.className = 'model-tags';
        tags.forEach(function(t){
          var s = document.createElement('span');
          s.className = 'tag' + (t.cap ? ' cap' : '');
          s.textContent = t.label;
          tagWrap.appendChild(s);
        });
        row.appendChild(tagWrap);
      }

      row.addEventListener('click', function(){
        $('model').value = m.id;
        renderModelRows();
        log('已选中模型「' + m.id + '」，点击「保存并应用」后生效。');
      });
      box.appendChild(row);
    });
    if (shown === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty-row';
      empty.textContent = '没有匹配的模型，也可以直接在上方输入框手动填写模型 ID。';
      box.appendChild(empty);
    }
    $('modelStats').textContent = '共 ' + allModels.length + ' 个模型，当前显示 ' + shown + ' 个';
  }

  function load(){
    return api('/v1/zhiyi/settings').then(function(data){
      render(data);
      return api('/v1/zhiyi/models');
    }).then(function(res){
      renderModels(res.data);
      busy('准备就绪，修改配置后请点击「保存并应用」。');
    }).catch(function(err){ log('读取配置失败：' + err.message, true); });
  }

  $('authMode').addEventListener('change', function(){
    syncAuthVisibility();
    syncPresetHighlight();
  });
  $('baseUrl').addEventListener('input', syncPresetHighlight);
  $('modelSearch').addEventListener('input', renderModelRows);
  $('clearFilter').addEventListener('click', function(){
    $('modelSearch').value = '';
    renderModelRows();
  });
  $('refreshModels').addEventListener('click', function(){
    busy('正在从上游获取最新模型列表…');
    api('/v1/zhiyi/models?refresh=1').then(function(res){
      renderModels(res.data);
      log('模型列表已更新，共 ' + res.data.length + ' 个可用模型。');
    }).catch(function(err){ log('获取模型列表失败：' + err.message, true); });
  });
  $('save').addEventListener('click', function(){
    busy('正在保存并应用配置…');
    api('/v1/zhiyi/settings', 'PUT', currentPatch()).then(function(data){
      render(data);
      $('apiKey').value = '';
      return api('/v1/zhiyi/models?refresh=1');
    }).then(function(res){
      renderModels(res.data);
      var current = $('model').value.trim();
      var ids = (res.data || []).map(function(m){ return m.id; });
      if (current && ids.length > 0 && ids.indexOf(current) === -1) {
        var fallback = ids[0];
        $('model').value = fallback;
        return api('/v1/zhiyi/settings', 'PUT', {model:fallback}).then(function(updated){
          render(updated);
          log('配置已生效。原模型不在新列表内，已自动切换为「' + fallback + '」。');
        });
      }
      log('配置已保存并生效 · 当前模型：' + (current || '-'));
    }).catch(function(err){
      log('保存失败：' + err.message, true);
      load();
    });
  });
  $('test').addEventListener('click', function(){
    busy('正在检查接口连通性…');
    api('/v1/zhiyi/settings/test', 'POST', {chat:false}).then(function(r){
      if (r.ok) {
        log('连接正常 · 已拉取 ' + (r.modelCount || 0) + ' 个模型 · 耗时 ' + r.latencyMs + 'ms');
      } else {
        log('连接失败：' + (r.error || '未知错误'), true);
      }
    }).catch(function(err){ log('连接测试失败：' + err.message, true); });
  });
  $('testChat').addEventListener('click', function(){
    busy('正在发送测试消息…');
    api('/v1/zhiyi/settings/test', 'POST', {chat:true}).then(function(r){
      if (r.ok) {
        log('对话测试通过（模型：' + r.model + '，耗时 ' + r.latencyMs + 'ms）· 回复：「' + (r.chat || '') + '」');
      } else {
        log('对话测试失败：' + (r.error || '未知错误'), true);
      }
    }).catch(function(err){ log('对话测试失败：' + err.message, true); });
  });
  $('refreshDucx').addEventListener('click', function(){
    busy('正在刷新本机登录凭证…');
    api('/v1/zhiyi/settings/ducx/refresh', 'POST', {}).then(function(r){
      log(r.available ? '登录凭证已刷新，可正常调用接口。' : '未检测到可用的登录组件，请确认本机已登录。', !r.available);
      return api('/v1/zhiyi/settings');
    }).then(render).catch(function(err){ log('刷新失败：' + err.message, true); });
  });
  $('testReport').addEventListener('click', function(){
    busy('正在测试客户端来源上报…');
    api('/v1/zhiyi/settings/ducx/report/test', 'POST', {}).then(function(r){
      log(r.ok ? '来源上报测试成功。' : ('来源上报失败：' + (r.error || '未知错误')), !r.ok);
      return api('/v1/zhiyi/settings');
    }).then(render).catch(function(err){ log('测试失败：' + err.message, true); });
  });
  $('reset').addEventListener('click', function(){
    openConfirm(function(){
      busy('正在恢复默认配置…');
      api('/v1/zhiyi/settings/reset', 'POST', {}).then(function(data){
        render(data);
        log('已恢复环境变量默认配置。');
      }).catch(function(err){ log('恢复失败：' + err.message, true); });
    });
  });
  renderPresets(INITIAL_PRESETS);
  syncPresetHighlight();
  load();
})();
</script>
</body>
</html>
`;
