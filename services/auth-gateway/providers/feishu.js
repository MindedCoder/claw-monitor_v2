const BASE = 'https://open.feishu.cn/open-apis';

async function getAppToken(appId, appSecret) {
  const res = await fetch(`${BASE}/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || 'get app token failed');
  return data.app_access_token;
}

async function getUserToken(appToken, code) {
  const res = await fetch(`${BASE}/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${appToken}`,
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || 'get user token failed');
  return data.data;
}

async function getUserInfo(userAccessToken) {
  const res = await fetch(`${BASE}/authen/v1/user_info`, {
    headers: { 'Authorization': `Bearer ${userAccessToken}` },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || 'get user info failed');
  return data.data;
}

export default {
  getAuthUrl({ redirectUri, state, config }) {
    const appId = config.appId;
    return `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  },

  async getUser({ code, config }) {
    const appToken = await getAppToken(config.appId, config.appSecret);
    const tokenData = await getUserToken(appToken, code);
    const userInfo = await getUserInfo(tokenData.access_token);

    const user = {
      name: userInfo.name,
      openId: userInfo.open_id,
      email: userInfo.email,
      avatar: userInfo.avatar_url,
      provider: 'feishu',
    };

    // optional department-based access control
    if (config.allowedOpenIds?.length) {
      if (!config.allowedOpenIds.includes(user.openId)) return null;
    }

    return user;
  },
};
