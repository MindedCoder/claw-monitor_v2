import { randomInt, createHmac } from 'node:crypto';
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
   * Verify code and return user info
   */
  async getUser({ body, config, tenant }) {
    const { phone, code } = body || {};
    if (!phone || !code) return null;

    const db = getDb();
    const doc = await db.collection('codes').findOne({ phone, tenant });

    if (!doc) return null;

    // too many attempts
    if (doc.attempts >= 5) return null;

    // wrong code — increment attempts
    if (doc.code !== code) {
      await db.collection('codes').updateOne(
        { _id: doc._id },
        { $inc: { attempts: 1 } },
      );
      return null;
    }

    // expired
    if (new Date() > doc.expiresAt) return null;

    // success — delete used code
    await db.collection('codes').deleteOne({ _id: doc._id });

    // get user info
    const user = await db.collection('users').findOne({ phone, tenants: tenant });
    return user
      ? { name: user.name, phone: user.phone, provider: 'phone' }
      : null;
  },
};
