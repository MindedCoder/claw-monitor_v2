import { randomInt, randomBytes, createHmac } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb } from '../db.js';

/**
 * Aliyun SMS — send verification code via HTTP API (China mainland)
 * Docs: https://help.aliyun.com/document_detail/419273.html
 */
async function sendSms(phone, code, smsConfig) {
  const { accessKeyId, accessKeySecret, signName, templateCode } = smsConfig;
  const params = {
    AccessKeyId: accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: 'cn-hangzhou',
    SignName: signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: Math.random().toString(36).slice(2),
    SignatureVersion: '1.0',
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25',
  };

  // build signature
  const sorted = Object.keys(params).sort();
  const canonicalized = sorted
    .map(k => `${encodeRFC3986(k)}=${encodeRFC3986(params[k])}`)
    .join('&');
  const stringToSign = `GET&${encodeRFC3986('/')}&${encodeRFC3986(canonicalized)}`;
  const signature = createHmac('sha1', accessKeySecret + '&')
    .update(stringToSign)
    .digest('base64');
  params.Signature = signature;

  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const res = await fetch(`https://dysmsapi.aliyuncs.com/?${qs}`);
  const data = await res.json();
  if (data.Code !== 'OK') {
    console.error('[phone] SMS send failed:', data);
    throw new Error(data.Message || 'SMS send failed');
  }
  return data;
}

function encodeRFC3986(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

export default {
  /**
   * Send verification code to phone
   * Called by gateway.js on POST /auth/send-code
   */
  async sendCode({ phone, tenant, smsConfig }) {
    const db = getDb();

    // check user has access to this tenant
    const user = await db.collection('users').findOne({
      phone,
      tenants: tenant,
    });
    if (!user) return { ok: false, status: 403, message: '您没有此空间的访问权限' };

    // rate limit: 60s per phone+tenant
    const recent = await db.collection('codes').findOne({
      phone,
      tenant,
      createdAt: { $gt: new Date(Date.now() - 60_000) },
    });
    if (recent) return { ok: false, status: 429, message: '请60秒后再试' };

    // generate 6-digit code
    const code = String(randomInt(100000, 999999));
    const now = new Date();

    // remove old codes for this phone+tenant
    await db.collection('codes').deleteMany({ phone, tenant });

    // insert new code
    await db.collection('codes').insertOne({
      _id: randomBytes(12).toString('hex'),
      phone,
      tenant,
      code,
      attempts: 0,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60_000), // 5 min
    });

    // send SMS
    await sendSms(phone, code, smsConfig);

    return { ok: true, message: '验证码已发送' };
  },

  /**
   * Verify code or password and return user info
   */
  async getUser({ body, config, tenant }) {
    const { phone, code, password, loginType } = body || {};
    console.log(`[phone.getUser] tenant=${tenant} phone=${phone} loginType=${loginType} hasCode=${!!code} hasPassword=${!!password}`);
    if (!phone) { console.log('[phone.getUser] FAIL no phone'); return { _error: '请输入手机号' }; }

    const db = getDb();

    // password login
    if (loginType === 'password' || (!code && password)) {
      if (!password) { console.log('[phone.getUser] FAIL no password'); return { _error: '请输入密码' }; }
      const user = await db.collection('users').findOne({ phone, tenants: tenant });
      console.log(`[phone.getUser] db query {phone,tenants:${tenant}} → found=${!!user} hasPwd=${!!user?.password} hash=${user?.password?.slice(0,7) || 'n/a'}`);
      if (!user) {
        const any = await db.collection('users').findOne({ phone });
        console.log(`[phone.getUser] FAIL user not in tenant; user exists at all=${!!any} their tenants=${JSON.stringify(any?.tenants)}`);
        return { _error: any ? '您没有此空间的访问权限' : '用户不存在' };
      }
      if (!user.password) {
        console.log('[phone.getUser] FAIL user has no password set');
        return { _error: '该用户未设置密码，请使用短信验证码登录' };
      }

      // bcrypt hashes start with $2a$/$2b$/$2y$
      const isHashed = /^\$2[aby]\$/.test(user.password);
      if (isHashed) {
        const ok = await bcrypt.compare(password, user.password);
        console.log(`[phone.getUser] bcrypt.compare → ${ok}`);
        if (!ok) return { _error: '密码错误' };
      } else {
        // legacy plaintext — verify, then upgrade in place
        const ok = user.password === password;
        console.log(`[phone.getUser] plain compare → ${ok}`);
        if (!ok) return { _error: '密码错误' };
        const hashed = await bcrypt.hash(password, 10);
        await db.collection('users').updateOne(
          { _id: user._id },
          { $set: { password: hashed } },
        );
        console.log(`[phone.getUser] upgraded plain → bcrypt for ${phone}`);
      }
      console.log(`[phone.getUser] SUCCESS user=${user.name} phone=${phone}`);
      return { name: user.name, phone: user.phone, provider: 'phone' };
    }

    // sms code login
    if (!code) return { _error: '请输入验证码' };

    const doc = await db.collection('codes').findOne({ phone, tenant });
    if (!doc) return { _error: '验证码不存在或已过期，请重新获取' };

    if (doc.attempts >= 5) return { _error: '错误次数过多，请重新获取验证码' };

    if (doc.code !== code) {
      await db.collection('codes').updateOne(
        { _id: doc._id },
        { $inc: { attempts: 1 } },
      );
      return { _error: '验证码错误' };
    }

    if (new Date() > doc.expiresAt) return { _error: '验证码已过期，请重新获取' };

    await db.collection('codes').deleteOne({ _id: doc._id });

    const user = await db.collection('users').findOne({ phone, tenants: tenant });
    if (!user) {
      const any = await db.collection('users').findOne({ phone });
      return { _error: any ? '您没有此空间的访问权限' : '用户不存在' };
    }
    return { name: user.name, phone: user.phone, provider: 'phone' };
  },
};
