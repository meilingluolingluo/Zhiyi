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
:root{color-scheme:light;--ink:#12263a;--muted:#5f6b7a;--line:#dfe6ee;--accent:#185fa5;--ok:#0f6e56;--bad:#a32d2d;--bg:#f6f8fb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:28px 20px 60px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap}
h1{font-size:20px;font-weight:600;margin:0}
.sub{color:var(--muted);font-size:13px}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;background:#e6f1fb;color:var(--accent);font-size:12px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:16px}
h2{font-size:14px;font-weight:600;margin:0 0 14px;color:var(--ink)}
label{display:block;margin-bottom:12px;font-size:13px;color:var(--muted)}
input,select{display:block;width:100%;margin-top:5px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);font:13px/1.4 inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
input[type=password]{font-family:inherit}
select{font-family:inherit}
.presets{display:flex;gap:10px;flex-wrap:wrap}
.preset{flex:1 1 220px;text-align:left;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#fbfdff;cursor:pointer;color:var(--ink)}
.preset:hover{border-color:var(--accent)}
.preset b{display:block;font-size:13px;font-weight:600;margin-bottom:4px}
.preset span{font-size:12px;color:var(--muted)}
.row{display:flex;gap:12px;flex-wrap:wrap}
.row>label{flex:1 1 240px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
button{padding:9px 15px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);cursor:pointer;font-size:13px}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
#output{background:#0f1b2a;color:#d7e6f5;border-radius:10px;padding:14px 16px;min-height:52px;white-space:pre-wrap;word-break:break-all;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:260px;overflow:auto}
#status{font-size:13px;color:var(--muted)}
#status b{color:var(--ink);font-weight:600}
.hint{color:var(--muted);font-size:12px;margin-top:18px}
.check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);margin-bottom:12px}
.check input{width:auto;margin:0}
.model-stats{font-size:12px;color:var(--muted);margin:10px 0 8px}
.model-list{max-height:250px;overflow:auto;border:1px solid var(--line);border-radius:8px}
.model-item{display:flex;align-items:flex-start;gap:8px;padding:8px 11px;border-bottom:1px solid var(--line);cursor:pointer;flex-wrap:wrap}
.model-item:last-child{border-bottom:none}
.model-item:hover{background:#f2f7fd}
.model-item.selected{background:#e6f1fb}
.model-id{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);min-width:180px;flex:1 1 180px;word-break:break-all}
.model-name{font-size:12px;color:var(--muted);flex:1 1 200px}
.tag{font-size:11px;padding:1px 7px;border-radius:999px;background:#eef2f6;color:var(--muted);white-space:nowrap}
.tag.rich{background:#e1f5ee;color:var(--ok)}
.empty-row{padding:14px;font-size:12px;color:var(--muted)}
.ok{color:var(--ok)}
.bad{color:var(--bad)}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div><h1>知忆 · 模型服务设置</h1><div class="sub">自填 API 地址与密钥、自选模型、管理 DUCX 登录态 · 保存后立即生效</div></div>
  <span class="badge" id="activeBadge">读取中…</span>
</header>

<section class="card">
  <h2>1 · 快速预设</h2>
  <div class="presets" id="presets"></div>
</section>

<section class="card">
  <h2>2 · 接入配置</h2>
  <div class="row">
    <label>API Base URL（OpenAI 兼容）
      <input id="baseUrl" placeholder="http://127.0.0.1:8787/v1" autocomplete="off">
    </label>
    <label>认证方式
      <select id="authMode">
        <option value="api_key">API Key（Bearer）</option>
        <option value="ducx">DUCX 登录态（Baidu OneAPI）</option>
        <option value="none">无需认证</option>
      </select>
    </label>
  </div>
  <div class="row">
    <label>API Key（留空 = 不修改）
      <input id="apiKey" type="password" placeholder="sk-… 或留空" autocomplete="new-password">
    </label>
    <label>模型列表路径
      <input id="modelsPath" value="/models" autocomplete="off">
    </label>
  </div>
  <div id="ducxRow" style="display:none">
    <label>DUCX 可执行文件路径（参考 codex-mixin 的 managed layout）
      <input id="ducxExecutable" placeholder="~/.baidu-cx/baidu-cx/bin/ducx" autocomplete="off">
    </label>
    <div class="sub" id="ducxHint">DUCX 会在本机启动一次性握手进程，抓取 comate_custom_header 与 Authorization，缓存 60 秒。</div>
  </div>
  <label class="check"><input type="checkbox" id="ducxReport" checked> DUCX 来源上报（向百度 data-report 上报 session / model / prompt，避免被判定为未知来源；可在下方「测试来源上报」验证）</label>
</section>

<section class="card">
  <h2>3 · 模型</h2>
  <label>当前模型（点击下方可选，也可直接输入任意模型 ID）
    <input id="model" list="modelOptions" placeholder="DeepSeek-V4-Flash-baidu-oneapi" autocomplete="off">
    <datalist id="modelOptions"></datalist>
  </label>
  <div class="row">
    <label>模型列表来源
      <select id="modelsSource">
        <option value="auto">自动合并（/v1/models + /openapi/v2/available_models，推荐）</option>
        <option value="single">仅主列表（/v1/models）</option>
      </select>
    </label>
    <label>模型优先级
      <select id="modelOverride">
        <option value="settings">以本页选中的模型为准（推荐，忽略 ADP 固定 ModelName）</option>
        <option value="request">以请求体 model 为准</option>
      </select>
    </label>
  </div>
  <label>搜索模型（ID / 名称 / 能力）
    <input id="modelSearch" placeholder="输入关键词过滤，例如 deepseek / 图像 / thinking" autocomplete="off">
  </label>
  <div class="model-stats" id="modelStats">尚未载入模型列表</div>
  <div class="model-list" id="modelList"></div>
  <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
    <button id="refreshModels" type="button">刷新模型列表</button>
    <button id="clearFilter" type="button">清除筛选</button>
  </div>
</section>

<div class="actions">
  <button id="save" class="primary" type="button">保存并生效</button>
  <button id="test" type="button">测试连接（/models）</button>
  <button id="testChat" type="button">测试真实对话</button>
  <button id="refreshDucx" type="button">刷新 DUCX 登录态</button>
  <button id="testReport" type="button">测试来源上报</button>
  <button id="reset" type="button">恢复 .env 默认</button>
</div>

<pre id="output">准备就绪。</pre>

<section class="card" style="margin-top:16px">
  <h2>运行状态</h2>
  <div id="status">读取中…</div>
</section>

<p class="hint">安全说明：配置写入 <b>data/model-settings.json</b>（权限 600，已加入 .gitignore），API Key 不会回传到页面。写接口默认仅允许本机访问；如需远程管理，请在 .env 设置 <b>ZHIYI_SETTINGS_TOKEN</b> 并在下方填入同一个令牌。DUCX 认证需要本机已登录百度 Codex（~/.baidu-cx）。</p>
<label class="hint">管理令牌（远程访问时填写，仅保存在本浏览器）
  <input id="adminToken" type="password" placeholder="ZHIYI_SETTINGS_TOKEN（可留空）" autocomplete="off">
</label>
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
          if (res.status === 401) msg += '（如需远程访问，请在下方填写管理令牌）';
          throw new Error(msg);
        }
        return json;
      });
    });
  }
  function currentPatch(){
    return {
      baseUrl: $('baseUrl').value.trim(),
      apiKey: $('apiKey').value,
      authMode: $('authMode').value,
      model: $('model').value.trim(),
      modelsPath: $('modelsPath').value.trim() || '/models',
      modelsSource: $('modelsSource').value,
      ducxReport: $('ducxReport').checked,
      ducxExecutable: $('ducxExecutable').value.trim(),
      modelOverride: $('modelOverride').value
    };
  }
  function render(data){
    $('baseUrl').value = data.baseUrl || '';
    $('authMode').value = data.authMode || 'api_key';
    $('modelsPath').value = data.modelsPath || '/models';
    $('modelsSource').value = data.modelsSource || 'auto';
    $('ducxReport').checked = data.ducxReport !== false;
    $('ducxExecutable').value = data.ducxExecutable || '';
    $('model').value = data.model || '';
    $('modelOverride').value = data.modelOverride || 'settings';
    $('apiKey').value = '';
    $('apiKey').placeholder = data.apiKeySet ? ('已保存：' + data.apiKeyMasked + '（留空不修改）') : '未设置，可留空';
    $('activeBadge').textContent = data.active ? '运行期设置已启用' : '使用 .env 默认配置';
    $('ducxRow').style.display = $('authMode').value === 'ducx' ? 'block' : 'none';
    var d = data.ducx || {};
    var r = data.ducxReportStatus || {};
    $('status').innerHTML =
      '生效上游：<b>' + (data.effectiveBaseUrl || '-') + '</b><br>' +
      '当前模型：<b>' + (data.model || '-') + '</b>　认证方式：<b>' + (data.authMode || '-') + '</b>　API Key：<b>' + (data.apiKeySet ? '已设置' : '未设置') + '</b><br>' +
      'DUCX 可执行文件：<b>' + (d.available ? '已找到' : '未找到') + '</b>　认证头缓存：<b>' + (d.cached ? '已缓存' : '未缓存') + '</b>　' +
      '缓存键：<b>' + ((d.cachedKeys || []).join(', ') || '-') + '</b><br>' +
      '来源上报：<b>' + (data.ducxReport ? '已开启' : '已关闭') + '</b>　data-report：<b>' + (r.available ? '已找到' : '未找到') + '</b>　token：<b>' + (r.tokenCached ? '已缓存' : '未缓存') + '</b>' +
      (r.lastSuccessAt ? '<br>最近上报成功：<b>' + r.lastSuccessAt + '</b>' : '') +
      '<br>.env 回退：' + (data.envFallback ? data.envFallback.baseUrl + ' / ' + data.envFallback.model : '-') +
      (d.lastError ? '<br><span class="bad">DUCX 最近错误：' + d.lastError + '</span>' : '') +
      (r.lastError ? '<br><span class="bad">上报最近错误：' + r.lastError + '</span>' : '');
    renderPresets(data.presets || []);
  }
  function renderPresets(presets){
    var box = $('presets');
    box.innerHTML = '';
    presets.forEach(function(p){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.innerHTML = '<b></b><span></span>';
      b.querySelector('b').textContent = p.label;
      b.querySelector('span').textContent = p.description;
      b.addEventListener('click', function(){
        $('baseUrl').value = p.baseUrl;
        $('authMode').value = p.authMode;
        $('modelsPath').value = p.modelsPath;
        $('modelsSource').value = p.modelsSource || 'auto';
        $('ducxRow').style.display = p.authMode === 'ducx' ? 'block' : 'none';
        log('已填入「' + p.label + '」预设，请确认 API Key / DUCX 路径后点击「保存并生效」。');
      });
      box.appendChild(b);
    });
  }
  var allModels = [];
  var modelSourceText = '来源：尚未载入';
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
      modelSourceText = '已合并 ' + sources.length + ' 个来源：' + sources.join(' + ');
    } else if (sources && sources.length) {
      modelSourceText = '来源：' + sources[0] + '（可在上方切换为自动合并）';
    } else {
      modelSourceText = '来源：主列表';
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
      if (m.variantOf) tags.push('渠道副本');
      if (m.isolatedVariant) tags.push('仅此渠道');
      if (m.capabilityKnown === false) tags.push('无能力信息');
      if (m.supportsImage) tags.push('图像');
      if (m.supportsThinking) tags.push('思考');
      if (m.ratio) tags.push(m.ratio);
      var hay = [m.id, m.name, m.description, tags.join(' ')].join(' ').toLowerCase();
      if (q && hay.indexOf(q) === -1) return;
      shown++;
      var row = document.createElement('div');
      row.className = 'model-item' + ($('model').value === m.id ? ' selected' : '');
      var idEl = document.createElement('span');
      idEl.className = 'model-id'; idEl.textContent = m.id;
      var nameEl = document.createElement('span');
      nameEl.className = 'model-name'; nameEl.textContent = m.name || m.description || '';
      row.appendChild(idEl); row.appendChild(nameEl);
      tags.forEach(function(t){
        var s = document.createElement('span');
        s.className = 'tag' + (t === '富信息' ? ' rich' : '');
        s.textContent = t;
        row.appendChild(s);
      });
      row.addEventListener('click', function(){
        $('model').value = m.id;
        renderModelRows();
        log('已选中模型：' + m.id + '（记得点「保存并生效」）');
      });
      box.appendChild(row);
    });
    if (shown === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty-row';
      empty.textContent = '没有匹配的模型，可直接在上方输入模型 ID。';
      box.appendChild(empty);
    }
    $('modelStats').textContent = modelSourceText + ' · 共 ' + allModels.length + ' 个，当前显示 ' + shown + ' 个';
  }
  function load(){
    return api('/v1/zhiyi/settings').then(function(data){
      render(data);
      return api('/v1/zhiyi/models');
    }).then(function(res){
      renderModels(res.data, res.sources);
      log('设置与模型列表已载入。');
    }).catch(function(err){ log('载入失败：' + err.message, true); });
  }

  $('authMode').addEventListener('change', function(){
    $('ducxRow').style.display = this.value === 'ducx' ? 'block' : 'none';
  });
  $('modelSearch').addEventListener('input', renderModelRows);
  $('clearFilter').addEventListener('click', function(){
    $('modelSearch').value = '';
    renderModelRows();
  });
  $('refreshModels').addEventListener('click', function(){
    busy('正在从上游刷新模型列表…');
    api('/v1/zhiyi/models?refresh=1').then(function(res){
      renderModels(res.data, res.sources);
      log('刷新成功，共 ' + res.data.length + ' 个模型' +
        (res.merged ? '（已合并 ' + res.sources.length + ' 个来源）' : '') + '。');
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
        return api('/v1/zhiyi/settings', 'PUT', {model:fallback}).then(function(){
          log('已保存并生效。原模型「' + current + '」不在新上游列表中，已自动切换为「' + fallback + '」。上游：' + res.source);
        });
      }
      log('已保存并立即生效。新上游：' + res.source + '，模型：' + current);
    }).catch(function(err){
      log('保存失败（设置可能已写入，但模型列表刷新未成功）：' + err.message, true);
      load();
    });
  });
  $('test').addEventListener('click', function(){
    busy('正在测试连接…');
    api('/v1/zhiyi/settings/test', 'POST', {chat:false}).then(function(r){
      log(r, !r.ok);
    }).catch(function(err){ log('连接测试失败：' + err.message, true); });
  });
  $('testChat').addEventListener('click', function(){
    busy('正在发送一次真实对话请求…');
    api('/v1/zhiyi/settings/test', 'POST', {chat:true}).then(function(r){
      log(r, !r.ok);
    }).catch(function(err){ log('对话测试失败：' + err.message, true); });
  });
  $('refreshDucx').addEventListener('click', function(){
    busy('正在重新铸造 DUCX 认证头…');
    api('/v1/zhiyi/settings/ducx/refresh', 'POST', {}).then(function(r){
      log(r, !r.available);
      return api('/v1/zhiyi/settings');
    }).then(render).catch(function(err){ log('DUCX 刷新失败：' + err.message, true); });
  });
  $('testReport').addEventListener('click', function(){
    busy('正在执行一次 DUCX 来源上报（upload/query）…');
    api('/v1/zhiyi/settings/ducx/report/test', 'POST', {}).then(function(r){
      log(r, !r.ok);
      return api('/v1/zhiyi/settings');
    }).then(render).catch(function(err){ log('上报测试失败：' + err.message, true); });
  });
  $('reset').addEventListener('click', function(){
    busy('正在恢复 .env 默认配置…');
    api('/v1/zhiyi/settings/reset', 'POST', {}).then(function(data){
      render(data);
      log('已恢复 .env 默认配置（运行期覆盖已停用）。');
    }).catch(function(err){ log('恢复失败：' + err.message, true); });
  });
  load();
})();
</script>
</body>
</html>
`;
