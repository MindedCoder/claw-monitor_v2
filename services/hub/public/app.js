(function () {
  // API prefix derived from the current page URL so the UI works both when
  // served directly and when reverse-proxied at /<instanceName>/hub/.
  const API_PREFIX = (function () {
    const segments = location.pathname.split('/').filter(Boolean);
    // strip trailing index.html if any
    if (segments.length && /\.html?$/i.test(segments[segments.length - 1])) {
      segments.pop();
    }
    return segments.length ? '/' + segments.join('/') : '';
  })();

  const CHUNK_SIZE = 5 * 1024 * 1024;
  const RESUME_KEY = 'bfe-hub:resume';

  const view = document.getElementById('view');
  const backBtn = document.getElementById('back-button');
  const pageTitle = document.getElementById('page-title');
  const hostTag = document.getElementById('host-tag');
  const fab = document.getElementById('fab-upload');
  const toastEl = document.getElementById('toast');

  let metaCache = null;

  function api(path) {
    return API_PREFIX + path;
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key in attrs) {
        if (key === 'class') node.className = attrs[key];
        else if (key === 'text') node.textContent = attrs[key];
        else if (key === 'html') node.innerHTML = attrs[key];
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), attrs[key]);
        else if (attrs[key] === true) node.setAttribute(key, '');
        else if (attrs[key] != null) node.setAttribute(key, attrs[key]);
      }
    }
    if (children) {
      for (const child of children) {
        if (child == null) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
    }
    return node;
  }

  function toast(msg, variant) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (variant === 'danger' ? ' danger' : '');
    setTimeout(() => toastEl.classList.add('hidden'), 2800);
    toastEl.classList.remove('hidden');
  }

  function humanSize(bytes) {
    if (!bytes && bytes !== 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return (n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
  }

  function humanTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
    return d.toLocaleDateString();
  }

  async function fetchJson(path, options) {
    const res = await fetch(api(path), options);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_err) {
      // raw body
    }
    if (!res.ok) {
      const msg = (data && data.error) || res.statusText || 'request failed';
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function loadMeta() {
    if (metaCache) return metaCache;
    try {
      metaCache = await fetchJson('/api/meta');
    } catch (_err) {
      metaCache = { instanceName: '', title: 'BFE Hub', appCount: 0, totalSize: 0 };
    }
    return metaCache;
  }

  async function renderHeader() {
    const meta = await loadMeta();
    pageTitle.textContent = meta.title || 'BFE Hub';
    if (meta.instanceName) {
      hostTag.textContent = meta.instanceName;
      hostTag.classList.remove('hidden');
    }
  }

  // ---------- Router ----------

  function parseRoute() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const parts = hash.split('/').filter(Boolean);
    if (parts.length === 0) return { name: 'list' };
    if (parts[0] === 'app' && parts[1]) return { name: 'detail', appId: parts[1] };
    if (parts[0] === 'upload') return { name: 'upload', appId: parts[1] || null };
    return { name: 'list' };
  }

  function navigate(hash) {
    location.hash = hash;
  }

  function resetPageTitle() {
    pageTitle.textContent = (metaCache && metaCache.title) || 'BFE Hub';
  }

  function uploadsEnabled() {
    return !!(metaCache && metaCache.uploadsEnabled);
  }

  async function route() {
    const r = parseRoute();
    view.innerHTML = '';
    fab.classList.add('hidden');
    backBtn.classList.add('hidden');
    resetPageTitle();
    if (r.name === 'list') {
      renderList();
    } else if (r.name === 'detail') {
      backBtn.classList.remove('hidden');
      backBtn.onclick = () => navigate('/');
      renderDetail(r.appId);
    } else if (r.name === 'upload') {
      if (!uploadsEnabled()) {
        navigate('/');
        return;
      }
      backBtn.classList.remove('hidden');
      backBtn.onclick = () => history.back();
      renderUpload(r.appId);
    }
  }

  // ---------- List view ----------

  async function renderList() {
    view.appendChild(el('div', { class: 'loading', text: '加载中…' }));
    if (uploadsEnabled()) {
      fab.classList.remove('hidden');
      fab.onclick = () => navigate('/upload');
    } else {
      fab.classList.add('hidden');
    }

    try {
      const data = await fetchJson('/api/apps');
      view.innerHTML = '';
      if (!data.apps.length) {
        const emptyHint = uploadsEnabled()
          ? '点击右下角 + 上传第一个应用'
          : '上传功能暂未开放';
        view.appendChild(
          el('div', { class: 'empty' }, [
            '还没有任何应用',
            el('br'),
            el('span', { class: 'muted', text: emptyHint }),
          ])
        );
        return;
      }
      const stack = el('div', { class: 'stack' });
      const card = el('div', { class: 'card', style: 'padding:0' });
      for (const app of data.apps) {
        card.appendChild(
          el(
            'button',
            {
              type: 'button',
              class: 'entry',
              onclick: () => navigate('/app/' + encodeURIComponent(app.appId)),
            },
            [
              el('span', { class: 'entry-icon', text: '📦' }),
              el('span', { class: 'entry-body' }, [
                el('div', { class: 'entry-title', text: app.name || app.appId }),
                el('div', {
                  class: 'entry-sub',
                  text:
                    (app.latest ? 'v' + app.latest : '无版本') +
                    ' · ' +
                    app.versionCount +
                    ' 个版本 · ' +
                    humanTime(app.latestUploadedAt),
                }),
              ]),
              el('span', { class: 'entry-tail', text: '›' }),
            ]
          )
        );
      }
      stack.appendChild(card);
      view.appendChild(stack);
    } catch (err) {
      view.innerHTML = '';
      view.appendChild(el('div', { class: 'empty', text: '加载失败: ' + err.message }));
    }
  }

  // ---------- Detail view ----------

  async function renderDetail(appId) {
    view.appendChild(el('div', { class: 'loading', text: '加载中…' }));
    try {
      const index = await fetchJson('/api/apps/' + encodeURIComponent(appId));
      view.innerHTML = '';
      pageTitle.textContent = index.name || index.appId;

      const headChildren = [
        el('div', { class: 'detail-head' }, [
          el('div', { class: 'detail-title', text: index.name || index.appId }),
          el('div', { class: 'detail-id', text: index.appId }),
        ]),
      ];
      if (index.description) {
        headChildren.push(
          el('div', { class: 'detail-desc', text: index.description })
        );
      }
      const actionButtons = [
        el('a', {
          class: 'btn',
          href: api('/api/download/' + encodeURIComponent(appId) + '/latest'),
          text: index.latest ? '下载最新 v' + index.latest : '暂无版本',
          ...(index.latest ? {} : { disabled: true }),
        }),
      ];
      if (uploadsEnabled()) {
        actionButtons.push(
          el('button', {
            type: 'button',
            class: 'btn secondary',
            text: '上传新版本',
            onclick: () => navigate('/upload/' + encodeURIComponent(appId)),
          })
        );
      }
      if (actionButtons.length) {
        headChildren.push(
          el('div', { class: 'btn-row', style: 'padding:0 14px 6px' }, actionButtons)
        );
      }
      headChildren.push(
        el('div', { class: 'download-hint' }, [
          '文件会保存到浏览器默认下载目录（macOS 通常为 ',
          el('code', { text: '~/Downloads/' }),
          '）',
        ])
      );
      headChildren.push(buildInstructionsBlock(index));
      const head = el('div', { class: 'card' }, headChildren);
      const wrap = el('div', { class: 'stack' }, [head]);
      view.appendChild(wrap);

      if (index.versions.length) {
        view.appendChild(
          el('div', { class: 'section-title', text: '版本历史' })
        );
        const verCard = el('div', { class: 'card', style: 'padding:0' });
        index.versions.forEach((v, i) => {
          verCard.appendChild(
            el('div', { class: 'version-row' }, [
              el('span', {
                class: 'version-badge' + (i === 0 ? ' latest' : ''),
                text: 'v' + v.version,
              }),
              el('div', { class: 'version-meta' }, [
                humanSize(v.size) + ' · ' + humanTime(v.uploadedAt),
              ]),
              el('div', { class: 'version-actions' }, [
                el('a', {
                  class: 'icon-btn',
                  title: '下载',
                  href: api(
                    '/api/download/' +
                      encodeURIComponent(appId) +
                      '/' +
                      encodeURIComponent(v.version)
                  ),
                  text: '↓',
                }),
              ]),
            ])
          );
        });
        const verWrap = el('div', { class: 'stack' }, [verCard]);
        view.appendChild(verWrap);
      }
    } catch (err) {
      view.innerHTML = '';
      view.appendChild(el('div', { class: 'empty', text: '加载失败: ' + err.message }));
    }
  }

  function buildInstructionsBlock(index) {
    const text = (index.instructions || '').trim();
    const wrap = el('div', { class: 'instructions-block' });
    wrap.appendChild(el('div', { class: 'instructions-head' }, ['下载后怎么用']));
    if (!text) {
      const uploader = index.uploader ? ' ' + index.uploader : '';
      wrap.appendChild(
        el('div', {
          class: 'instructions-empty',
          text: '上传者未填写说明' + (uploader ? '，请联系' + uploader : ''),
        })
      );
      return wrap;
    }
    const pre = el('pre', { class: 'instructions-pre', text });
    const copyBtn = el('button', {
      type: 'button',
      class: 'btn secondary instructions-copy',
      text: '复制说明',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制到剪贴板');
        } catch (_err) {
          // fallback for insecure contexts
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand('copy');
            toast('已复制到剪贴板');
          } catch (_e) {
            toast('复制失败，请手动选择', 'danger');
          }
          document.body.removeChild(ta);
        }
      },
    });
    wrap.appendChild(pre);
    wrap.appendChild(copyBtn);
    return wrap;
  }

  async function deleteVersion(appId, version) {
    if (!confirm('确认删除 ' + appId + ' v' + version + '?')) return;
    try {
      await fetchJson(
        '/api/apps/' +
          encodeURIComponent(appId) +
          '/versions/' +
          encodeURIComponent(version),
        { method: 'DELETE' }
      );
      toast('已删除');
      renderDetail(appId);
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function deleteApp(appId) {
    if (!confirm('确认删除整个应用 ' + appId + '? 所有版本都会被删除')) return;
    try {
      await fetchJson('/api/apps/' + encodeURIComponent(appId), { method: 'DELETE' });
      toast('已删除');
      navigate('/');
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  // ---------- Upload view ----------

  function renderUpload(prefillAppId) {
    const form = el('form', { class: 'card', onsubmit: (e) => e.preventDefault() });

    const appIdInput = el('input', {
      type: 'text',
      name: 'appId',
      placeholder: 'my-tool',
      pattern: '[a-z0-9][a-z0-9-]{1,39}',
      required: true,
      value: prefillAppId || '',
    });
    if (prefillAppId) appIdInput.readOnly = true;

    const nameInput = el('input', {
      type: 'text',
      name: 'name',
      placeholder: '展示名（可留空）',
    });
    const versionInput = el('input', {
      type: 'text',
      name: 'version',
      placeholder: '1.0.0',
      required: true,
    });
    const descInput = el('textarea', {
      name: 'description',
      rows: '2',
      placeholder: '一句话描述（可留空）',
    });
    const instructionsInput = el('textarea', {
      name: 'instructions',
      rows: '5',
      placeholder:
        '下载后怎么用（可留空）\n例：\n  解压后双击 install.command\n  或在 Terminal 执行：\n    tar -xzf ~/Downloads/xxx.tar.gz -C ~/.local/bin/',
    });

    const dropzone = el('div', { class: 'dropzone' }, [
      el('strong', { text: '点击选择文件，或拖到此处' }),
      el('span', { class: 'muted', text: '支持任意二进制 / 压缩包' }),
    ]);
    const fileInput = el('input', {
      type: 'file',
      style: 'display:none',
    });
    dropzone.appendChild(fileInput);
    dropzone.onclick = () => fileInput.click();
    dropzone.ondragover = (e) => {
      e.preventDefault();
      dropzone.classList.add('hover');
    };
    dropzone.ondragleave = () => dropzone.classList.remove('hover');
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove('hover');
      if (e.dataTransfer.files[0]) {
        fileInput.files = e.dataTransfer.files;
        onFileChosen();
      }
    };

    const fileInfo = el('div', { class: 'file-info hidden' });
    const progress = el('div', { class: 'progress hidden' }, [
      el('div', { class: 'progress-bar' }, [el('div', { class: 'progress-fill' })]),
      el('div', { class: 'progress-text', text: '' }),
    ]);

    const submitBtn = el('button', {
      type: 'button',
      class: 'btn',
      text: '开始上传',
      disabled: true,
    });
    const cancelBtn = el('button', {
      type: 'button',
      class: 'btn secondary',
      text: '取消',
      onclick: () => history.back(),
    });

    let chosenFile = null;
    let activeUpload = null;

    function onFileChosen() {
      chosenFile = fileInput.files[0];
      if (!chosenFile) return;
      fileInfo.classList.remove('hidden');
      fileInfo.textContent = chosenFile.name + ' · ' + humanSize(chosenFile.size);
      submitBtn.disabled = false;
      if (!versionInput.value && /[-_]v?(\d+(?:\.\d+)*)/.test(chosenFile.name)) {
        versionInput.value = RegExp.$1;
      }
    }
    fileInput.onchange = onFileChosen;

    submitBtn.onclick = async () => {
      if (!chosenFile) return;
      const appId = appIdInput.value.trim();
      const version = versionInput.value.trim();
      if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(appId)) {
        toast('appId 格式不符', 'danger');
        return;
      }
      if (!version) {
        toast('请填写 version', 'danger');
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = '准备中…';
      progress.classList.remove('hidden');
      try {
        activeUpload = {
          file: chosenFile,
          appId,
          version,
          name: nameInput.value.trim(),
          description: descInput.value.trim(),
          instructions: instructionsInput.value,
        };
        await runUpload(activeUpload, progress);
        toast('上传成功');
        clearResumeState(appId, version, chosenFile);
        setTimeout(
          () => navigate('/app/' + encodeURIComponent(appId)),
          800
        );
      } catch (err) {
        toast(err.message || '上传失败', 'danger');
        submitBtn.disabled = false;
        submitBtn.textContent = '重试';
      }
    };

    form.appendChild(
      el('label', { class: 'field' }, [
        el('span', { text: 'appId（路径/URL 用，不可变）' }),
        appIdInput,
      ])
    );
    form.appendChild(
      el('label', { class: 'field' }, [el('span', { text: '展示名' }), nameInput])
    );
    form.appendChild(
      el('label', { class: 'field' }, [el('span', { text: 'version' }), versionInput])
    );
    form.appendChild(
      el('label', { class: 'field' }, [el('span', { text: '描述' }), descInput])
    );
    form.appendChild(
      el('label', { class: 'field' }, [
        el('span', { text: '使用说明（下载后怎么用）' }),
        instructionsInput,
      ])
    );
    form.appendChild(dropzone);
    form.appendChild(fileInfo);
    form.appendChild(progress);
    form.appendChild(el('div', { class: 'btn-row' }, [submitBtn, cancelBtn]));

    const wrap = el('div', { class: 'stack' }, [form]);
    view.appendChild(wrap);
  }

  // ---------- Upload runner ----------

  function resumeKey(appId, version, file) {
    return (
      RESUME_KEY + ':' + appId + ':' + version + ':' + file.name + ':' + file.size
    );
  }

  function loadResumeState(appId, version, file) {
    try {
      const raw = localStorage.getItem(resumeKey(appId, version, file));
      return raw ? JSON.parse(raw) : null;
    } catch (_err) {
      return null;
    }
  }

  function saveResumeState(appId, version, file, state) {
    try {
      localStorage.setItem(resumeKey(appId, version, file), JSON.stringify(state));
    } catch (_err) {
      // ignore quota errors
    }
  }

  function clearResumeState(appId, version, file) {
    try {
      localStorage.removeItem(resumeKey(appId, version, file));
    } catch (_err) {
      // ignore
    }
  }

  async function sha256Hex(blob) {
    // crypto.subtle is only available in secure contexts (HTTPS or localhost).
    // On plain HTTP over tailnet it's undefined — fall back to letting the
    // server compute the digest and record it in the manifest itself.
    if (!window.crypto || !window.crypto.subtle) return null;
    try {
      const buf = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const bytes = new Uint8Array(digest);
      let out = '';
      for (let i = 0; i < bytes.length; i += 1) {
        out += bytes[i].toString(16).padStart(2, '0');
      }
      return out;
    } catch (_err) {
      return null;
    }
  }

  function updateProgress(progressEl, done, total, text) {
    const fill = progressEl.querySelector('.progress-fill');
    const txt = progressEl.querySelector('.progress-text');
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    fill.style.width = pct.toFixed(1) + '%';
    txt.textContent = text;
  }

  async function runUpload(task, progressEl) {
    const { file, appId, version, name, description, instructions } = task;

    updateProgress(progressEl, 0, file.size, '计算 sha256…');
    const sha256 = await sha256Hex(file);

    let state = loadResumeState(appId, version, file);
    if (state && state.sha256 !== sha256) state = null;

    if (!state) {
      updateProgress(progressEl, 0, file.size, '初始化上传…');
      const initRes = await fetchJson('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId,
          version,
          name,
          description,
          instructions,
          filename: file.name,
          size: file.size,
          sha256,
          chunkSize: CHUNK_SIZE,
        }),
      });
      state = {
        uploadId: initRes.uploadId,
        totalChunks: initRes.totalChunks,
        received: initRes.receivedChunks || [],
        sha256,
      };
      saveResumeState(appId, version, file, state);
    } else {
      try {
        const statusRes = await fetchJson(
          '/api/upload/status?uploadId=' + encodeURIComponent(state.uploadId)
        );
        state.received = statusRes.receivedChunks;
        state.totalChunks = statusRes.totalChunks;
        saveResumeState(appId, version, file, state);
      } catch (err) {
        // stale state; start over
        state = null;
        clearResumeState(appId, version, file);
        return runUpload(task, progressEl);
      }
    }

    const received = new Set(state.received);
    let uploadedBytes = received.size * CHUNK_SIZE;
    if (uploadedBytes > file.size) uploadedBytes = file.size;

    for (let i = 0; i < state.totalChunks; i += 1) {
      if (received.has(i)) continue;
      const start = i * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const blob = file.slice(start, end);
      updateProgress(
        progressEl,
        uploadedBytes,
        file.size,
        '上传分片 ' + (i + 1) + ' / ' + state.totalChunks
      );
      await fetch(
        api(
          '/api/upload/chunk?uploadId=' +
            encodeURIComponent(state.uploadId) +
            '&index=' +
            i
        ),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob,
        }
      ).then(async (res) => {
        if (!res.ok) {
          const body = await res.text();
          let msg = '分片上传失败';
          try {
            msg = JSON.parse(body).error || msg;
          } catch (_err) {
            // keep default
          }
          throw new Error(msg);
        }
      });
      received.add(i);
      state.received = Array.from(received).sort((a, b) => a - b);
      saveResumeState(appId, version, file, state);
      uploadedBytes = Math.min(file.size, uploadedBytes + (end - start));
      updateProgress(
        progressEl,
        uploadedBytes,
        file.size,
        '上传分片 ' + (i + 1) + ' / ' + state.totalChunks
      );
    }

    updateProgress(progressEl, file.size, file.size, '合并 + 校验中…');
    await fetchJson('/api/upload/complete?uploadId=' + encodeURIComponent(state.uploadId), {
      method: 'POST',
    });
    updateProgress(progressEl, file.size, file.size, '完成');
  }

  // ---------- Boot ----------

  window.addEventListener('hashchange', route);
  renderHeader().then(route);
})();
