(function () {
  const API_BASE = '../api/applications/';

  const appGrid = document.getElementById('appGrid');
  const createBtn = document.getElementById('createAppBtn');
  const appCount = document.getElementById('appCount');
  const modal = document.getElementById('createModal');
  const fieldName = document.getElementById('fieldName');
  const fieldDescription = document.getElementById('fieldDescription');
  const submitBtn = document.getElementById('submitBtn');
  const modalMessage = document.getElementById('modalMessage');
  const toast = document.getElementById('toast');

  function firstChar(name) {
    const trimmed = (name || '').trim();
    return trimmed ? Array.from(trimmed)[0] : '';
  }

  function renderAppItem(app) {
    const link = document.createElement('a');
    link.className = 'app-item';
    link.href = `./${app.id}/`;

    const idTag = document.createElement('span');
    idTag.className = 'app-item__id';
    idTag.textContent = `ID://${String(app.id).slice(0, 6).toUpperCase()}`;
    link.appendChild(idTag);

    const icon = document.createElement('span');
    icon.className = 'app-icon';
    if (app.icon) {
      const img = document.createElement('img');
      img.src = app.icon;
      img.alt = '';
      icon.appendChild(img);
    } else {
      icon.style.backgroundColor = app.iconColor || '#00f0ff';
      icon.textContent = firstChar(app.name);
    }
    link.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'app-label';
    label.textContent = app.name;
    link.appendChild(label);

    if (app.description) {
      const desc = document.createElement('span');
      desc.className = 'app-desc';
      desc.textContent = app.description;
      link.appendChild(desc);
    }

    const arrow = document.createElement('span');
    arrow.className = 'app-item__arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    link.appendChild(arrow);

    return link;
  }

  async function loadApps() {
    try {
      const res = await fetch(API_BASE + 'list');
      const data = await res.json();
      const apps = data.applications || [];

      const existing = Array.from(appGrid.querySelectorAll('.app-item:not(.app-item--create)'));
      existing.forEach((el) => el.remove());

      apps.forEach((app) => {
        appGrid.insertBefore(renderAppItem(app), createBtn);
      });

      if (appCount) appCount.textContent = String(apps.length).padStart(2, '0');
    } catch (err) {
      console.error('加载应用列表失败', err);
    }
  }

  function buildPromptText(name, description) {
    return [
      '你好小龙虾，我想创建一个应用。',
      `名称：「${name}」`,
      `功能：${description}`,
      '请帮我创建。',
    ].join('\n');
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => { toast.hidden = true; }, 2000);
  }

  function setMessage(text) {
    modalMessage.textContent = text || '';
  }

  function openModal() {
    modal.hidden = false;
    fieldName.value = '';
    fieldDescription.value = '';
    setMessage('');
    submitBtn.disabled = false;
    setTimeout(() => fieldName.focus(), 30);
  }

  function closeModal() {
    modal.hidden = true;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        return true;
      } catch {
        return false;
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  async function submit() {
    const name = fieldName.value.trim();
    const description = fieldDescription.value.trim();

    if (!name) return setMessage('请输入应用名称');
    if (!description) return setMessage('请输入功能描述');

    const text = buildPromptText(name, description);
    const copied = await copyText(text);
    if (copied) {
      closeModal();
      showToast('已复制，请到飞书粘贴给小龙虾');
    } else {
      setMessage('复制失败，请手动重试');
    }
  }

  createBtn.addEventListener('click', openModal);

  modal.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) {
      closeModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) {
      closeModal();
    }
  });

  submitBtn.addEventListener('click', submit);

  loadApps();
})();
