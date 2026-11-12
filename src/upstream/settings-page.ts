/**
 * 知忆 · 模型服务设置页（零依赖静态页，挂在 Gateway 的 /settings）。
 * 只负责展示与提交，所有配置与凭证都经网关 API 保存，页面本身不含任何密钥。
 */
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
  --muted:#64748b;
  --line:#e2e8f0;
  --soft:#f8fafc;
  --bg:#f1f5f9;
  --card:#ffffff;
  --accent:#2563eb;
  --accent-soft:#eff6ff;
  --ok:#059669;
  --ok-soft:#ecfdf5;
  --bad:#dc2626;
  --bad-soft:#fef2f2;
  --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:24px 20px 56px}

.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.title-group h1{font-size:20px;font-weight:700;margin:0;letter-spacing:-0.01em}
.title-group .sub{color:var(--muted);font-size:13px;margin-top:2px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:500;background:var(--accent-soft);color:var(--accent);border:1px solid #bfdbfe}
.pill.muted{background:#fff;color:var(--muted);border-color:var(--line)}

.layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px;align-items:start}
@media (max-width:920px){.layout{grid-template-columns:1fr}}
.sidebar{position:sticky;top:20px}
@media (max-width:920px){.sidebar{position:static}}

.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px;box-shadow:0 1px 2px rgba(15,23,42,.03)}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}
.card-head h2{font-size:14px;font-weight:600;margin:0;color:var(--ink)}
.card-head .hint-inline{font-size:12px;color:var(--muted)}

.presets{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.preset{text-align:left;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--soft);cursor:pointer;transition:all .15s ease;color:var(--ink)}
.preset:hover{border-color:#93c5fd;background:var(--accent-soft)}
.preset.active{border-color:var(--accent);background:var(--accent-soft);box-shadow:0 0 0 1px var(--accent)}
.preset b{display:block;font-size:13px;font-weight:600;margin-bottom:3px}
.preset span{display:block;font-size:12px;color:var(--muted);line-height:1.4}

.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px}
@media (max-width:640px){.grid-2{grid-template-columns:1fr}}
.span-2{grid-column:1 / -1}

label.field{display:block;font-size:12px;font-weight:500;color:var(--muted);margin:0}
label.field input,label.field select{display:block;width:100%;margin-top:6px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink);font-size:13px;line-height:1.4;transition:border-color .15s}
label.field input{font-family:var(--mono)}
label.field input[type=password]{font-family:inherit}
label.field input:focus,label.field select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.12)}

.inline-note{margin-top:8px;padding:10px 12px;border-radius:9px;background:var(--soft);border:1px dashed var(--line);font-size:12px;color:var(--muted)}
.inline-note b{color:var(--ink)}

details.adv{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
details.adv summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--muted);user-select:none;list-style:none;display:flex;align-items:center;justify-content:space-between}
details.adv summary::-webkit-details-marker{display:none}
details.adv summary::after{content:'展开 ▾';font-weight:400}
details.adv[open] summary::after{content:'收起 ▴'}
details.adv .adv-body{margin-top:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px}
@media (max-width:640px){details.adv .adv-body{grid-template-columns:1fr}}

.check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);cursor:pointer;margin:0}
.check input{width:auto;margin:0}

.toolbar{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}
.toolbar input{flex:1 1 200px;padding:8px 11px;border:1px solid var(--line);border-radius:9px;font-size:13px;background:#fff;color:var(--ink)}
.toolbar input:focus{outline:none;border-color:var(--accent)}

.model-stats{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--muted);margin:10px 0 6px}
.model-list{max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:#fff}
.model-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border-bottom:1px solid #f1f5f9;cursor:pointer;transition:background .1s}
.model-item:last-child{border-bottom:none}
.model-item:hover{background:var(--soft)}
.model-item.selected{background:var(--accent-soft)}
.model-main{min-width:0;flex:1}
.model-id{font:12.5px/1.4 var(--mono);font-weight:600;color:var(--ink);word-break:break-all}
.model-name{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.model-tags{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0}
.tag{font-size:11px;padding:2px 7px;border-radius:999px;background:#f1f5f9;color:var(--muted);white-space:nowrap}
.tag.rich{background:var(--ok-soft);color:var(--ok)}
.empty-row{padding:18px;text-align:center;font-size:12px;color:var(--muted)}

button{padding:8px 13px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink);cursor:pointer;font-size:13px;font-weight:500;transition:all .15s}
button:hover{border-color:#94a3b8;background:var(--soft)}
button.primary{width:100%;padding:11px 16px;background:var(--accent);border-color:var(--accent);color:#fff;font-size:14px;font-weight:600}
button.primary:hover{background:#1d4ed8;border-color:#1d4ed8}
button.danger{color:var(--bad)}
button.danger:hover{background:var(--bad-soft);border-color:#fca5a5}

.btn-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}
.kv-list{display:grid;gap:8px;font-size:12.5px}
.kv{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding-bottom:7px;border-bottom:1px solid #f1f5f9}
.kv:last-child{padding-bottom:0;border-bottom:none}
.kv span{color:var(--muted);flex-shrink:0}
.kv b{color:var(--ink);font-weight:600;text-align:right;word-break:break-all;font-family:var(--mono);font-size:12px}
.kv b.text{font-family:inherit}
.kv b.ok{color:var(--ok)}
.kv b.bad{color:var(--bad)}

#output{margin:12px 0 0;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:12px 14px;min-height:64px;white-space:pre-wrap;word-break:break-all;font:12px/1.55 var(--mono);max-height:220px;overflow:auto}
#output.ok{color:#6ee7b7}
#output.bad{color:#fca5a5}

.footer-note{font-size:12px;color:var(--muted);line-height:1.6;margin-top:8px}
.hidden{display:none!important}
</style>
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <div class="title-group">
      <h1>知忆 · 模型服务设置</h1>
      <div class="sub">快速切换 Baidu OneAPI 直连或本地代理 · 保存后即时生效，凭证仅保存在网关本机</div>
    </div>
    <span class="pill" id="activeBadge">读取中…</span>
  </header>

  <div class="layout">
    <main>
      <section class="card">
        <div class="card-head">
          <h2>1 · 上游预设</h2>
          <span class="hint-inline">一键填入推荐配置，再点右侧保存</span>
        </div>
        <div class="presets" id="presets"></div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>2 · 接入与认证</h2>
          <span class="hint-inline">OneAPI 直连选 DUCX + 自动协议即可</span>
        </div>

        <div class="grid-2">
          <label class="field span-2">API Base URL
            <input id="baseUrl" placeholder="https://oneapi-comate.baidu-int.com/v1" autocomplete="off">
          </label>

          <label class="field">认证方式
            <select id="authMode">
              <option value="ducx">DUCX 登录态（Baidu OneAPI）</option>
              <option value="api_key">API Key（Bearer）</option>
              <option value="none">无需认证</option>
            </select>
          </label>

          <label class="field">上游协议
            <select id="upstreamProtocol">
              <option value="auto">自动路由（推荐：OneAPI 按模型自动选端点）</option>
              <option value="openai_chat">OpenAI Chat Completions (/v1/chat/completions)</option>
              <option value="anthropic_messages">Anthropic Messages (/v1/messages)</option>
              <option value="openai_responses">OpenAI Responses (/v1/responses)</option>
            </select>
          </label>

          <label class="field span-2" id="apiKeyRow">API Key（留空 = 保持当前密钥不变）
            <input id="apiKey" type="password" placeholder="sk-… 或留空" autocomplete="new-password">
          </label>
        </div>

        <div id="ducxRow" class="inline-note hidden">
          使用本机 <b>~/.baidu-cx</b> DUCX 握手抓取认证头并自动缓存 60 秒；401/403 时网关会自动刷新重试。
        </div>

        <details class="adv">
          <summary>高级选项（生图/标题模型 · 模型路径 · 优先级 · DUCX · 令牌）</summary>
          <div class="adv-body">
            <label class="field">生图模型（默认 gpt-image-2）
              <input id="imageModel" list="modelOptions" placeholder="gpt-image-2" autocomplete="off">
            </label>
            <label class="field">标题生成模型（留空 = 当前默认模型）
              <input id="titleModel" list="modelOptions" placeholder="留空沿用当前模型，如 Claude Haiku 5.5" autocomplete="off">
            </label>
            <label class="field">模型列表路径
              <input id="modelsPath" value="/models" autocomplete="off">
            </label>
            <label class="field">模型列表来源
              <select id="modelsSource">
                <option value="auto">自动合并（/v1/models + available_models）</option>
                <option value="single">仅主列表（/v1/models）</option>
              </select>
            </label>
            <label class="field">模型优先级
              <select id="modelOverride">
                <option value="settings">以本页选中模型为准（推荐）</option>
                <option value="request">以请求体 model 为准</option>
              </select>
            </label>
            <label class="field">DUCX 可执行文件路径
              <input id="ducxExecutable" placeholder="~/.baidu-cx/baidu-cx/bin/ducx" autocomplete="off">
            </label>
            <label class="field span-2">远程管理令牌（仅本浏览器 localStorage）
              <input id="adminToken" type="password" placeholder="ZHIYI_SETTINGS_TOKEN（本机访问可留空）" autocomplete="off">
            </label>
            <div class="span-2">
              <label class="check"><input type="checkbox" id="ducxReport" checked> 向百度 data-report 上报 session / model / prompt（仅 DUCX 模式需要）</label>
            </div>
          </div>
        </details>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>3 · 模型选择</h2>
          <span class="hint-inline">点击列表选中或直接输入模型 ID</span>
        </div>

        <label class="field">当前默认模型
          <input id="model" list="modelOptions" placeholder="Grok-4.7-baidu-oneapi" autocomplete="off">
          <datalist id="modelOptions"></datalist>
        </label>

        <div class="toolbar">
          <input id="modelSearch" placeholder="过滤模型（ID / 名称 / thinking / 图像…）" autocomplete="off">
          <button id="refreshModels" type="button">刷新列表</button>
          <button id="clearFilter" type="button">清除</button>
        </div>

        <div class="model-stats" id="modelStats">尚未载入模型列表</div>
        <div class="model-list" id="modelList"></div>
      </section>
    </main>

    <aside class="sidebar">
      <section class="card">
        <button id="save" class="primary" type="button">保存并立即生效</button>
        <div class="btn-grid">
          <button id="test" type="button">测试连接</button>
          <button id="testChat" type="button">测试对话</button>
          <button id="refreshDucx" type="button">刷新 DUCX</button>
          <button id="testReport" type="button">测试上报</button>
        </div>
        <div style="margin-top:8px">
          <button id="reset" class="danger" type="button" style="width:100%">恢复 .env 默认配置</button>
        </div>
        <pre id="output">准备就绪。</pre>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>运行状态</h2>
        </div>
        <div class="kv-list" id="status">读取中…</div>
      </section>

      <div class="footer-note">
        配置保存于 <b>data/model-settings.json</b>（0600，已忽略提交）。非本机管理需配置 <b>ZHIYI_SETTINGS_TOKEN</b>。
      </div>
    </aside>
  </div>
</div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var tokenKey = 'zhiyi_settings_token';
  $('adminToken').value = localStorage.getItem(tokenKey) || '';
  $('adminToken').addEventListener('change', function(){
    localStorage.setItem(tokenKey, $('adminToken').value.trim());
    log('管理令牌已保存在本浏览器。');
  });

  function log(text, bad){
    var out = $('output');
    out.textContent = (typeof text === 'string' ? text : JSON.stringify(text, null, 2));
    out.className = bad ? 'bad' : 'ok';
  }
  function busy(text){ $('output').textContent = text; $('output').className = ''; }
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
          if (res.status === 401) msg += '（请在高级选项填入管理令牌）';
          throw new Error(msg);
        }
        return json;
      });
    });
  }

  function syncAuthVisibility(){
    var mode = $('authMode').value;
    $('ducxRow').classList.toggle('hidden', mode !== 'ducx');
    $('apiKeyRow').classList.toggle('hidden', mode !== 'api_key');
    $('refreshDucx').disabled = mode !== 'ducx';
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

  function kvRow(label, value, cls){
    return '<div class="kv"><span>' + esc(label) + '</span><b class="' + (cls || '') + '">' + esc(value) + '</b></div>';
  }
  function esc(s){
    return String(s == null ? '-' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  var lastPresets = [];
  function syncPresetHighlight(){
    var curBase = ($('baseUrl').value || '').trim().replace(/\\/+$/,'');
    var curAuth = $('authMode').value;
    var btns = $('presets').querySelectorAll('.preset');
    btns.forEach(function(b, idx){
      var p = lastPresets[idx];
      if (!p) return;
      var match = p.baseUrl.replace(/\\/+$/,'') === curBase && p.authMode === curAuth;
      b.classList.toggle('active', match);
    });
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
    $('apiKey').placeholder = data.apiKeySet ? ('已保存：' + data.apiKeyMasked + '（留空不修改）') : '未设置，可留空';

    var badge = $('activeBadge');
    badge.textContent = data.active ? '运行期设置已启用' : '使用 .env 默认配置';
    badge.className = data.active ? 'pill' : 'pill muted';

    syncAuthVisibility();

    var d = data.ducx || {};
    var r = data.ducxReportStatus || {};
    var rows = [
      kvRow('生效地址', data.effectiveBaseUrl || '-'),
      kvRow('当前模型', data.model || '-'),
      kvRow('上游协议', data.upstreamProtocol || 'auto'),
      kvRow('认证方式', (data.authMode || '-') + (data.authMode === 'api_key' ? (data.apiKeySet ? ' · 已设Key' : ' · 未设Key') : ''), 'text'),
      kvRow('DUCX 状态', (d.available ? '可用' : '未找到') + ' · ' + (d.cached ? '已缓存' : '未缓存'), d.available ? 'ok text' : 'text'),
      kvRow('来源上报', data.ducxReport ? ('开启 · ' + (r.tokenCached ? 'token已缓存' : '待抓token')) : '关闭', 'text')
    ];
    if (d.lastError) rows.push(kvRow('DUCX 错误', d.lastError, 'bad text'));
    if (r.lastError) rows.push(kvRow('上报错误', r.lastError, 'bad text'));
    $('status').innerHTML = rows.join('');

    renderPresets(data.presets || []);
    syncPresetHighlight();
  }

  function renderPresets(presets){
    lastPresets = presets || [];
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
        $('baseUrl').value = p.baseUrl;
        $('authMode').value = p.authMode;
        $('upstreamProtocol').value = 'auto';
        $('modelsPath').value = p.modelsPath;
        $('modelsSource').value = p.modelsSource || 'auto';
        syncAuthVisibility();
        syncPresetHighlight();
        log('已填入「' + p.label + '」，请点击右侧「保存并立即生效」。');
      });
      box.appendChild(b);
    });
  }

  var allModels = [];
  var modelSourceText = '尚未载入';
  function renderModels(models, sources){
    allModels = models || [];
    var list = $('modelOptions');
    list.innerHTML = '';
    allModels.forEach(function(m){
      var o = document.createElement('option');
      o.value = m.id;
      if (m.name) o.label = m.name;
      list.appendChild(o);
    });
    if (sources && sources.length > 1) {
      modelSourceText = '已合并：' + sources.join(' + ');
    } else if (sources && sources.length) {
      modelSourceText = '来源：' + sources[0];
    } else {
      modelSourceText = '主列表';
    }
    renderModelRows();
  }

  function renderModelRows(){
    var q = ($('modelSearch').value || '').trim().toLowerCase();
    var box = $('modelList');
    box.innerHTML = '';
    var shown = 0;
    allModels.forEach(function(m){
      var tags = [];
      if (m.sources && m.sources.indexOf('baidu') >= 0) tags.push('富信息');
      if (m.supportsThinking) tags.push('思考');
      if (m.supportsImage) tags.push('图像');
      if (m.ratio) tags.push(m.ratio);
      if (m.variantOf) tags.push('渠道副本');
      if (m.isolatedVariant) tags.push('仅此渠道');
      var hay = [m.id, m.name, m.description, tags.join(' ')].join(' ').toLowerCase();
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
          s.className = 'tag' + (t === '富信息' ? ' rich' : '');
          s.textContent = t;
          tagWrap.appendChild(s);
        });
        row.appendChild(tagWrap);
      }

      row.addEventListener('click', function(){
        $('model').value = m.id;
        renderModelRows();
        log('已选中模型：' + m.id + '（点击「保存并立即生效」应用）');
      });
      box.appendChild(row);
    });
    if (shown === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty-row';
      empty.textContent = '无匹配模型，可直接在上方输入框填写任意模型 ID。';
      box.appendChild(empty);
    }
    $('modelStats').textContent = modelSourceText + ' · 共 ' + allModels.length + ' 个，显示 ' + shown + ' 个';
  }

  function load(){
    return api('/v1/zhiyi/settings').then(function(data){
      render(data);
      return api('/v1/zhiyi/models');
    }).then(function(res){
      renderModels(res.data, res.sources);
      log('设置与模型列表已就绪。');
    }).catch(function(err){ log('载入失败：' + err.message, true); });
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
    busy('正在刷新模型列表…');
    api('/v1/zhiyi/models?refresh=1').then(function(res){
      renderModels(res.data, res.sources);
      log('刷新成功，共 ' + res.data.length + ' 个模型。');
    }).catch(function(err){ log('刷新失败：' + err.message, true); });
  });
  $('save').addEventListener('click', function(){
    busy('正在保存并应用设置…');
    api('/v1/zhiyi/settings', 'PUT', currentPatch()).then(function(data){
      render(data);
      $('apiKey').value = '';
      return api('/v1/zhiyi/models?refresh=1');
    }).then(function(res){
      renderModels(res.data, res.sources);
      var current = $('model').value.trim();
      var ids = (res.data || []).map(function(m){ return m.id; });
      if (current && ids.length > 0 && ids.indexOf(current) === -1) {
        var fallback = ids[0];
        $('model').value = fallback;
        return api('/v1/zhiyi/settings', 'PUT', {model:fallback}).then(function(updated){
          render(updated);
          log('已生效，原模型不在新列表，已自动切换为：' + fallback);
        });
      }
      log('已保存并生效 · 模型：' + current);
    }).catch(function(err){
      log('保存失败：' + err.message, true);
      load();
    });
  });
  $('test').addEventListener('click', function(){
    busy('正在测试模型列表连接…');
    api('/v1/zhiyi/settings/test', 'POST', {chat:false}).then(function(r){
      log(r, !r.ok);
    }).catch(function(err){ log('连接测试失败：' + err.message, true); });
  });
  $('testChat').addEventListener('click', function(){
    busy('正在测试真实对话…');
    api('/v1/zhiyi/settings/test', 'POST', {chat:true}).then(function(r){
      log(r, !r.ok);
    }).catch(function(err){ log('对话测试失败：' + err.message, true); });
  });
  $('refreshDucx').addEventListener('click', function(){
    busy('正在刷新 DUCX 认证头…');
    api('/v1/zhiyi/settings/ducx/refresh', 'POST', {}).then(function(r){
      log(r, !r.available);
      return api('/v1/zhiyi/settings');
    }).then(render).catch(function(err){ log('DUCX 刷新失败：' + err.message, true); });
  });
  $('testReport').addEventListener('click', function(){
    busy('正在测试 DUCX 来源上报…');
    api('/v1/zhiyi/settings/ducx/report/test', 'POST', {}).then(function(r){
      log(r, !r.ok);
      return api('/v1/zhiyi/settings');
    }).then(render).catch(function(err){ log('上报测试失败：' + err.message, true); });
  });
  $('reset').addEventListener('click', function(){
    busy('正在恢复 .env 默认配置…');
    api('/v1/zhiyi/settings/reset', 'POST', {}).then(function(data){
      render(data);
      log('已恢复 .env 默认配置。');
    }).catch(function(err){ log('恢复失败：' + err.message, true); });
  });
  load();
})();
</script>
</body>
</html>
`;
