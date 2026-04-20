(function () {
  const API_BASE = '../api/applications/';

  const appGrid = document.getElementById('appGrid');
  const createBtn = document.getElementById('createAppBtn');
  const modal = document.getElementById('createModal');
  const fieldName = document.getElementById('fieldName');
  const fieldDescription = document.getElementById('fieldDescription');
  const fieldIcon = document.getElementById('fieldIcon');
  const iconPickBtn = document.getElementById('iconPickBtn');
  const iconClearBtn = document.getElementById('iconClearBtn');
  const iconPreview = document.getElementById('iconPreview');
  const previewText = document.getElementById('previewText');
  const submitBtn = document.getElementById('submitBtn');
  const modalMessage = document.getElementById('modalMessage');
  const toast = document.getElementById('toast');

  let currentIconDataUrl = null;
  let previewEdited = false;

  function firstChar(name) {
    const trimmed = (name || '').trim();
    return trimmed ? Array.from(trimmed)[0] : '';
  }

  function renderAppItem(app) {
    const link = document.createElement('a');
    link.className = 'app-item';
    link.href = `./${app.id}/`;

    const icon = document.createElement('span');
    icon.className = 'app-icon';
    if (app.icon) {
      const img = document.createElement('img');
      img.src = app.icon;
      img.alt = '';
      icon.appendChild(img);
    } else {
      icon.style.backgroundColor = app.iconColor || '#3370ff';
      icon.textContent = firstChar(app.name);
    }

    const label = document.createElement('span');
    label.className = 'app-label';
    label.textContent = app.name;

    link.appendChild(icon);
    link.appendChild(label);
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
    } catch (err) {
      console.error('加载应用列表失败', err);
    }
  }

  function buildPromptText(name, description) {
    const trimmedName = (name || '').trim();
    const trimmedDesc = (description || '').trim();
    return [
      '你好小龙虾，我想创建一个应用。',
      `名称：「${trimmedName || '?'}」`,
      `功能：${trimmedDesc || '?'}`,
      '请帮我创建。',
    ].join('\n');
  }

  function refreshPreviewFromForm() {
    if (previewEdited) return;
    previewText.value = buildPromptText(fieldName.value, fieldDescription.value);
  }

  function updateIconPreview() {
    iconPreview.innerHTML = '';
    if (currentIconDataUrl) {
      const img = document.createElement('img');
      img.src = currentIconDataUrl;
      img.alt = '';
      iconPreview.appendChild(img);
      iconPreview.style.backgroundColor = '';
      iconClearBtn.hidden = false;
    } else {
      const ch = firstChar(fieldName.value);
      const span = document.createElement('span');
      span.className = 'icon-placeholder';
      span.textContent = ch || '?';
      if (ch) {
        span.style.color = '#fff';
        iconPreview.style.backgroundColor = '#9499a0';
      } else {
        span.style.color = '#8f959e';
        iconPreview.style.backgroundColor = '#f3f4f6';
      }
      iconPreview.appendChild(span);
      iconClearBtn.hidden = true;
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => { toast.hidden = true; }, 2000);
  }

  function setMessage(text, kind) {
    modalMessage.textContent = text || '';
    modalMessage.style.color = kind === 'success' ? '#16a34a' : '#ef4444';
  }

  function openModal() {
    modal.hidden = false;
    fieldName.value = '';
    fieldDescription.value = '';
    currentIconDataUrl = null;
    previewEdited = false;
    fieldIcon.value = '';
    setMessage('');
    submitBtn.disabled = false;
    updateIconPreview();
    refreshPreviewFromForm();
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

    const text = previewText.value.trim();
    if (!text) return setMessage('文案为空，无法复制');

    const copied = await copyText(text);
    if (copied) {
      closeModal();
      showToast('已复制，请到飞书粘贴给小龙虾');
    } else {
      setMessage('复制失败，请手动全选文案复制');
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

  fieldName.addEventListener('input', () => {
    updateIconPreview();
    refreshPreviewFromForm();
  });

  fieldDescription.addEventListener('input', refreshPreviewFromForm);

  previewText.addEventListener('input', () => {
    previewEdited = true;
  });

  iconPickBtn.addEventListener('click', () => fieldIcon.click());

  iconClearBtn.addEventListener('click', () => {
    currentIconDataUrl = null;
    fieldIcon.value = '';
    updateIconPreview();
  });

  fieldIcon.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 500 * 1024) {
      setMessage('图标文件需 ≤ 500KB');
      fieldIcon.value = '';
      return;
    }
    setMessage('');
    try {
      currentIconDataUrl = await fileToDataUrl(file);
      updateIconPreview();
    } catch (err) {
      setMessage('读取图标失败');
    }
  });

  submitBtn.addEventListener('click', submit);

  loadApps();
})();
