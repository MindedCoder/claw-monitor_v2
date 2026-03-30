export default {
  getAuthUrl({ redirectUri, state, config }) {
    const appId = config.appId;
    return `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_userinfo&state=${state}#wechat_redirect`;
  },

  async getUser({ code, config }) {
    // exchange code for access_token
    const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${config.appId}&secret=${config.appSecret}&code=${code}&grant_type=authorization_code`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();
    if (tokenData.errcode) throw new Error(tokenData.errmsg || 'wechat token error');

    // get user info
    const infoUrl = `https://api.weixin.qq.com/sns/userinfo?access_token=${tokenData.access_token}&openid=${tokenData.openid}&lang=zh_CN`;
    const infoRes = await fetch(infoUrl);
    const info = await infoRes.json();
    if (info.errcode) throw new Error(info.errmsg || 'wechat userinfo error');

    return {
      name: info.nickname,
      openId: info.openid,
      avatar: info.headimgurl,
      provider: 'wechat',
    };
  },
};
