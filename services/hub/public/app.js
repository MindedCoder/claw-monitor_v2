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
  let listMode = 'all';

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

  const PLATFORM_LABELS = {
    macos: 'macOS',
    'macos-arm64': 'macOS arm64',
    'macos-x86-64': 'macOS x86_64',
    windows: 'Windows',
    'windows-arm64': 'Windows arm64',
    linux: 'Linux',
    'linux-arm64': 'Linux arm64',
    'linux-x86-64': 'Linux x86_64',
  };

  function platformLabel(p) {
    return PLATFORM_LABELS[p] || p;
  }

  function platformIconText(p) {
    if (!p) return '↓';
    if (p.startsWith('mac')) return 'mac';
    if (p.startsWith('win')) return 'win';
    if (p.startsWith('linux')) return 'lin';
    return p.slice(0, 3);
  }

  function detectPlatform() {
    const ua = (navigator.userAgent || '').toLowerCase();
    if (ua.includes('windows')) return 'windows';
    if (ua.includes('mac')) return 'macos';
    if (ua.includes('linux')) return 'linux';
    return null;
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg || '已复制到剪贴板');
      return;
    } catch (_err) {
      // fall through to textarea fallback (non-secure contexts / Safari < 13.1)
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(okMsg || '已复制到剪贴板');
    } catch (_e) {
      toast('复制失败,请手动选择', 'danger');
    }
    document.body.removeChild(ta);
  }

  // hub 知道自己的公网前缀(浏览器看到的 origin + API_PREFIX), 比 puller
  // 从 Forwarded headers 反推更可靠。puller 收到 ?hub= 时优先用它。
  function buildInstallCommand(appId) {
    const hub = location.origin + API_PREFIX;
    const url = hub + '/api/install/' + encodeURIComponent(appId)
      + '?hub=' + encodeURIComponent(hub);
    return 'curl -fsSL "' + url + '" | bash';
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

  function buildMineSubtitle(app) {
    return [
      app.platform ? platformLabel(app.platform) : '',
      app.declaredVersion ? 'v' + app.declaredVersion : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function buildAllSubtitle(app) {
    return (
      (app.platforms && app.platforms.length
        ? app.platforms.map(platformLabel).join(' · ') + ' · '
        : '') +
      app.versionCount +
      ' 个版本 · ' +
      humanTime(app.latestUploadedAt)
    );
  }

  function buildListEntry(app, options) {
    const listKind = options && options.listKind ? options.listKind : 'all';
    const latestInfo = options && options.latestInfo ? options.latestInfo : null;
    const clickable = options && options.clickable !== false;
    const hasUpdate =
      listKind === 'mine' &&
      !!latestInfo &&
      !!latestInfo.latest &&
      !!app.currentVersion &&
      latestInfo.latest !== app.currentVersion;
    const subtitle =
      listKind === 'mine'
        ? buildMineSubtitle(app)
        : buildAllSubtitle(app);

    const entryTag = clickable ? 'button' : 'div';
    const entryAttrs = clickable
      ? {
          type: 'button',
          class: 'entry',
          onclick: () => navigate('/app/' + encodeURIComponent(app.appId)),
        }
      : {
          class: 'entry entry-static',
        };
    const entryChildren = [
      el('span', { class: 'entry-icon', text: '📦' }),
      el('span', { class: 'entry-body' }, [
        el('div', { class: 'entry-title', text: app.name || app.appId }),
        el('div', {
          class: 'entry-sub',
          text: subtitle,
        }),
      ]),
    ];
    if (clickable) {
      entryChildren.push(el('span', { class: 'entry-tail', text: '›' }));
    }
    const entryMain = el(entryTag, entryAttrs, entryChildren);

    if (!(listKind === 'mine' && hasUpdate)) {
      return entryMain;
    }

    const installCmd = buildInstallCommand(app.appId);
    const updateRow = el('div', { class: 'entry-update-row' }, [
      el('span', { class: 'entry-update-badge', text: '可更新' }),
      el('span', {
        class: 'entry-update-text',
        text: '最新版本 ' + latestInfo.latest,
      }),
      el('button', {
        type: 'button',
        class: 'btn secondary entry-action-btn',
        text: '复制更新命令',
        onclick: (event) => {
          event.stopPropagation();
          copyText(installCmd, '更新命令已复制,粘贴到终端执行即可');
        },
      }),
    ]);

    return el('div', { class: 'entry-group' }, [
      entryMain,
      updateRow,
    ]);
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
      view.innerHTML = '';
      const listScreen = el('div', { class: 'list-screen' });
      const listBody = el('div', { class: 'list-body' });
      const switchBar = el('div', { class: 'list-switch' }, [
        el('button', {
          type: 'button',
          class: 'list-switch-tab' + (listMode === 'all' ? ' active' : ''),
          text: '全部',
          onclick: () => {
            if (listMode === 'all') return;
            listMode = 'all';
            renderList();
          },
        }),
        el('button', {
          type: 'button',
          class: 'list-switch-tab' + (listMode === 'mine' ? ' active' : ''),
          text: '我的',
          onclick: () => {
            if (listMode === 'mine') return;
            listMode = 'mine';
            renderList();
          },
        }),
      ]);
      listScreen.appendChild(listBody);
      listScreen.appendChild(switchBar);
      view.appendChild(listScreen);

      let apps = [];
      let latestByAppId = {};
      if (listMode === 'mine') {
        const [installedData, remoteData] = await Promise.all([
          fetchJson('/api/installed-apps'),
          fetchJson('/api/apps').catch(() => ({ apps: [] })),
        ]);
        apps = installedData.apps || [];
        latestByAppId = Object.fromEntries(
          (remoteData.apps || []).map((app) => [app.appId, app])
        );
      } else {
        const data = await fetchJson('/api/apps');
        apps = data.apps || [];
      }

      if (!apps.length) {
        const emptyHint = uploadsEnabled()
          ? '点击右下角 + 上传第一个应用'
          : listMode === 'mine'
            ? '当前实例还没有安装任何应用。先在本机执行安装命令，安装成功后这里才会出现。'
            : '上传功能暂未开放';
        listBody.appendChild(
          el('div', { class: 'empty' }, [
            listMode === 'mine' ? '本机还没有已安装应用' : '还没有任何应用',
            el('br'),
            el('span', { class: 'muted', text: emptyHint }),
          ])
        );
        return;
      }
      const stack = el('div', { class: 'stack' });
      const card = el('div', { class: 'card', style: 'padding:0' });
      for (const app of apps) {
        card.appendChild(
          buildListEntry(app, {
            listKind: listMode,
            latestInfo: listMode === 'mine' ? latestByAppId[app.appId] : null,
            clickable: listMode !== 'mine',
          })
        );
      }
      stack.appendChild(card);
      listBody.appendChild(stack);

      if (listMode === 'mine' && apps.some((app) => {
        const latestInfo = latestByAppId[app.appId];
        return latestInfo && latestInfo.latest && app.currentVersion && latestInfo.latest !== app.currentVersion;
      })) {
        listBody.appendChild(
          el('div', { class: 'muted list-mine-hint', text: '有新版本的应用会在列表中显示“复制更新命令”。' })
        );
      }
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
      let latestManifest = null;
      if (index.latest) {
        latestManifest = await fetchJson(
          '/api/apps/' +
            encodeURIComponent(appId) +
            '/versions/' +
            encodeURIComponent(index.latest)
        );
      }
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

      const latestEntry = (index.versions && index.versions[0]) || null;
      const platforms = latestEntry ? latestEntry.platforms || [] : [];

      if (platforms.length === 0) {
        headChildren.push(
          el('div', { class: 'empty', text: '暂无可下载的平台版本' })
        );
      } else {
        const detected = detectPlatform();
        let active =
          detected && platforms.find((p) => p.platform === detected)
            ? detected
            : platforms[0].platform;

        const tabBar = el('div', { class: 'platform-tabs' });
        const downloadArea = el('div', { class: 'download-area' });
        const instructionsArea = el('div');

        function renderForPlatform(platform) {
          active = platform;
          const info = platforms.find((p) => p.platform === platform);
          const declared = info && info.declaredVersion;

          tabBar.innerHTML = '';
          for (const p of platforms) {
            tabBar.appendChild(
              el('button', {
                type: 'button',
                class: 'platform-tab' + (p.platform === platform ? ' active' : ''),
                text:
                  platformLabel(p.platform) +
                  (p.declaredVersion ? ' · v' + p.declaredVersion : ''),
                onclick: () => renderForPlatform(p.platform),
              })
            );
          }

          downloadArea.innerHTML = '';
          const installCmd = buildInstallCommand(appId);
          downloadArea.appendChild(
            el('div', { class: 'btn-row' }, [
              el('button', {
                type: 'button',
                class: 'btn',
                text: '复制一键安装命令',
                onclick: () => copyText(installCmd, '安装命令已复制,粘贴到终端执行即可'),
              }),
              el('a', {
                class: 'btn secondary',
                href: api(
                  '/api/download/' +
                    encodeURIComponent(appId) +
                    '/latest/' +
                    encodeURIComponent(platform)
                ),
                text:
                  '下载 ' +
                  platformLabel(platform) +
                  (declared ? ' v' + declared : ''),
              }),
            ])
          );
          downloadArea.appendChild(
            el('div', { class: 'download-hint' }, [
              '一键安装会装到 ',
              el('code', { text: '~/.bfe/bfe-hub/apps/' + appId + '/' }),
              '(需要 curl + bash + jq);也可直接下载文件到浏览器默认目录自行处理',
            ])
          );

          const artifactInfo =
            (latestManifest &&
              (latestManifest.artifacts || []).find((a) => a.platform === platform)) ||
            null;
          const text = artifactInfo ? (artifactInfo.instructions || '').trim() : '';
          instructionsArea.innerHTML = '';
          instructionsArea.appendChild(buildInstructionsBlock(text, platform));
        }

        renderForPlatform(active);
        headChildren.push(tabBar);
        headChildren.push(downloadArea);
        headChildren.push(instructionsArea);
      }

      const head = el('div', { class: 'card' }, headChildren);
      view.appendChild(el('div', { class: 'stack' }, [head]));

      if (index.versions && index.versions.length) {
        view.appendChild(
          el('div', { class: 'section-title', text: '版本历史' })
        );
        const verCard = el('div', { class: 'card', style: 'padding:0' });
        index.versions.forEach((v, i) => {
          const platformIcons = (v.platforms || []).map((p) =>
            el('a', {
              class: 'icon-btn',
              title:
                '下载 ' +
                platformLabel(p.platform) +
                (p.declaredVersion ? ' v' + p.declaredVersion : ''),
              href: api(
                '/api/download/' +
                  encodeURIComponent(appId) +
                  '/' +
                  encodeURIComponent(v.version) +
                  '/' +
                  encodeURIComponent(p.platform)
              ),
              text: platformIconText(p.platform),
            })
          );
          verCard.appendChild(
            el('div', { class: 'version-row' }, [
              el('span', {
                class: 'version-badge' + (i === 0 ? ' latest' : ''),
                text: v.version,
              }),
              el('div', { class: 'version-meta' }, [humanTime(v.uploadedAt)]),
              el('div', { class: 'version-actions' }, platformIcons),
            ])
          );
        });
        view.appendChild(el('div', { class: 'stack' }, [verCard]));
      }
    } catch (err) {
      view.innerHTML = '';
      view.appendChild(el('div', { class: 'empty', text: '加载失败: ' + err.message }));
    }
  }

  function buildInstructionsBlock(text, platform) {
    text = (text || '').trim();
    const wrap = el('div', { class: 'instructions-block' });
    const headLabel = platform
      ? '下载后怎么用 · ' + platformLabel(platform)
      : '下载后怎么用';
    wrap.appendChild(el('div', { class: 'instructions-head', text: headLabel }));
    if (!text) {
      wrap.appendChild(
        el('div', { class: 'instructions-empty', text: '上传者未填写说明' })
      );
      return wrap;
    }
    wrap.appendChild(el('pre', { class: 'instructions-pre', text }));
    wrap.appendChild(
      el('button', {
        type: 'button',
        class: 'btn secondary instructions-copy',
        text: '复制说明',
        onclick: () => copyText(text),
      })
    );
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
